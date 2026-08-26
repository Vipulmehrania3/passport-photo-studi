/**
 * Passport Photo Studio — backend
 * ---------------------------------------------------------------------------
 * This server is the ONLY component that talks to ClearBackdrop.
 *
 *   Browser  →  this backend (/api/remove-background)  →  ClearBackdrop
 *
 * ClearBackdrop contract verified against the live docs on 2026-08-27
 * (https://clearbackdrop.com/api and https://clearbackdrop.com/llms.txt):
 *
 *   POST https://clearbackdrop.com/api/v1/remove-background
 *   Content-Type: multipart/form-data, image under the field name `image`
 *   Auth:        none required for the standard model.
 *                Optional BRIA RMBG-2.0 model: header `X-Bria-Key: <key>`
 *                (invalid key -> 403 invalid_bria_key, no silent fallback).
 *   Response:    image/png bytes by default (same WxH as input, RGBA)
 *                or JSON metadata when `?response=json` is appended.
 *   Limits:      15 MB max upload, 100 requests / hour / IP.
 *   Rate headers:X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset
 *   Errors:      400 no image, 413 too large, 415 unsupported type,
 *                429 rate limited, 500 processing failed.
 *   NOTE:        always use the non-www host — www 301-redirects and drops
 *                the POST body.
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

/* ------------------------------------------------------------------ config */

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

// Non-www host is mandatory: www redirects and the POST body is lost.
const CLEARBACKDROP_BASE = String(
  process.env.CLEARBACKDROP_BASE || 'https://clearbackdrop.com'
).replace(/\/+$/, '');
const REMOVE_BG_PATH = process.env.CLEARBACKDROP_REMOVE_PATH || '/api/v1/remove-background';
const QUOTA_PATH = process.env.CLEARBACKDROP_QUOTA_PATH || '/api/v1/quota';

const CLEARBACKDROP_URL = CLEARBACKDROP_BASE + REMOVE_BG_PATH;
const QUOTA_URL = CLEARBACKDROP_BASE + QUOTA_PATH;

// Mirrors the documented ClearBackdrop upload limit.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 15);
const MAX_UPLOAD_BYTES = Math.round(MAX_UPLOAD_MB * 1024 * 1024);

const REQUEST_TIMEOUT_MS = Number(process.env.CLEARBACKDROP_TIMEOUT_MS || 60000);

// 'binary' (default, fastest) or 'json' (returns metadata + downloads result_url)
const RESPONSE_MODE = (process.env.CLEARBACKDROP_RESPONSE_MODE || 'binary').toLowerCase();

// Optional premium BRIA model key. NEVER sent to the browser.
const BRIA_KEY = process.env.CLEARBACKDROP_BRIA_KEY || '';

// Dev/test only: serve a locally generated cutout instead of calling ClearBackdrop.
const MOCK_MODE = ['1', 'true', 'yes'].includes(String(process.env.CLEARBACKDROP_MOCK || '').toLowerCase());

// Dev/test only: let a request force a specific failure so the error paths can
// be exercised. NEVER enable this in production. Implicitly on in mock mode.
const ALLOW_SIMULATE =
  MOCK_MODE || ['1', 'true', 'yes'].includes(String(process.env.ALLOW_SIMULATE || '').toLowerCase());

const ALLOWED_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const ALLOWED_EXT = ['.jpg', '.jpeg', '.jpe', '.png', '.webp'];

const FRONTEND_DIR = process.env.FRONTEND_DIR
  ? path.resolve(process.env.FRONTEND_DIR)
  : path.resolve(__dirname, '..', 'frontend');

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || ''; // e.g. http://localhost:5500

/* ------------------------------------------------------------------- helpers */

function jsonError(res, status, code, message, extra) {
  res.status(status).json(Object.assign({ error: code, message }, extra || {}));
}

function rateInfoFromHeaders(headers) {
  const get = (name) => {
    const v = headers.get ? headers.get(name) : headers[name];
    return v === null || v === undefined ? null : v;
  };
  const limit = get('x-ratelimit-limit');
  const remaining = get('x-ratelimit-remaining');
  const reset = get('x-ratelimit-reset');
  return {
    limit_per_hour: limit === null ? null : Number(limit),
    remaining: remaining === null ? null : Number(remaining),
    reset_seconds: reset === null ? null : Number(reset),
  };
}

function bufferToDataUrl(buffer, mime) {
  return 'data:' + mime + ';base64,' + buffer.toString('base64');
}

function describeBuffer(buffer) {
  // Cheap PNG/JPEG header sniff — enough to sanity check the upstream reply.
  const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  let width = null;
  let height = null;
  if (isPng && buffer.length >= 24) {
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  }
  return { isPng, isJpeg, width, height };
}

/** PNG (IHDR) or JPEG (SOFn) pixel dimensions, or null when unrecognised. */
function imageSize(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
      const len = buffer.readUInt16BE(offset + 2);
      if (len < 2) return null;
      offset += 2 + len;
    }
  }
  return null;
}

function mockCutoutPng(W, H) {
  // A deterministic stand-in cutout (opaque centre subject, transparent surround).
  // Only used when CLEARBACKDROP_MOCK=1. Dimensions mirror the input, exactly
  // like the real ClearBackdrop API does.
  W = W || 600;
  H = H || 800;
  const zlib = require('zlib');
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const o = y * (W * 4 + 1) + 1 + x * 4;
      const dx = (x - W / 2) / (W / 2);
      const dy = (y - H / 2) / (H / 2);
      const inside = dx * dx * 1.6 + dy * dy * 1.1 < 0.55;
      raw[o] = 245;
      raw[o + 1] = 214;
      raw[o + 2] = 190;
      raw[o + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------- ClearBackdrop calls */

async function postToClearBackdrop(fileBuffer, filename, mimetype, simulate) {
  // Test hook: reproduce a specific upstream failure without hitting the API.
  if (ALLOW_SIMULATE && simulate) {
    if (simulate === 'upstream_error') {
      const err = new Error('Simulated ClearBackdrop processing failure (ALLOW_SIMULATE).');
      err.status = 500;
      err.payload = { error: 'processing_failed', message: err.message };
      throw err;
    }
    if (simulate === 'rate_limit') {
      const err = new Error('Simulated ClearBackdrop rate limit (ALLOW_SIMULATE).');
      err.status = 429;
      err.payload = { error: 'rate_limited', message: err.message };
      err.retryAfterSeconds = 60;
      throw err;
    }
    if (simulate === 'timeout') {
      const err = new Error('Simulated ClearBackdrop timeout (ALLOW_SIMULATE).');
      err.code = 'ETIMEDOUT';
      throw err;
    }
    if (simulate === 'bad_response') {
      const err = new Error('Simulated invalid upstream response (ALLOW_SIMULATE).');
      err.status = 502;
      err.code = 'EINVALIDRESPONSE';
      throw err;
    }
  }

  if (MOCK_MODE) {
    const dims = imageSize(fileBuffer) || { width: 600, height: 800 };
    const png = mockCutoutPng(dims.width, dims.height);
    return {
      mime: 'image/png',
      buffer: png,
      meta: { image_size: dims.width + 'x' + dims.height, cached: false, processing_time: 0.01, mock: true },
      rate: { limit_per_hour: 100, remaining: 100, reset_seconds: 0 },
    };
  }

  const form = new FormData();
  // Documented field name is `image`.
  form.append('image', new Blob([new Uint8Array(fileBuffer)], { type: mimetype }), filename || 'upload.jpg');

  const headers = {};
  if (BRIA_KEY) headers['X-Bria-Key'] = BRIA_KEY;

  const url = RESPONSE_MODE === 'json' ? CLEARBACKDROP_URL + '?response=json' : CLEARBACKDROP_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
      redirect: 'error', // never follow a redirect: the body would be dropped
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
      const err = new Error('ClearBackdrop timed out after ' + REQUEST_TIMEOUT_MS + 'ms');
      err.code = 'ETIMEDOUT';
      throw err;
    }
    const err = new Error('Could not reach ClearBackdrop: ' + (e && e.message ? e.message : 'network failure'));
    err.code = 'ENETUNREACH';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const rate = rateInfoFromHeaders(upstream.headers);

  if (!upstream.ok) {
    let payload = null;
    const text = await upstream.text().catch(() => '');
    try {
      payload = JSON.parse(text);
    } catch (_) {
      payload = text ? { error: 'upstream_error', message: text.slice(0, 500) } : null;
    }
    const err = new Error((payload && payload.message) || 'ClearBackdrop returned ' + upstream.status);
    err.status = upstream.status;
    err.payload = payload;
    const ra = upstream.headers.get && upstream.headers.get('retry-after');
    if (ra) err.retryAfterSeconds = Number(ra) || null;
    throw err;
  }

  if (RESPONSE_MODE === 'json') {
    let meta;
    try {
      meta = await upstream.json();
    } catch (_) {
      const err = new Error('ClearBackdrop returned an unreadable JSON response');
      err.code = 'EINVALIDRESPONSE';
      throw err;
    }
    if (!meta || meta.success !== true || !meta.result_url) {
      const err = new Error((meta && meta.message) || 'ClearBackdrop did not return a result_url');
      err.status = 502;
      err.code = 'EINVALIDRESPONSE';
      throw err;
    }
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), REQUEST_TIMEOUT_MS);
    let img;
    try {
      img = await fetch(meta.result_url, { signal: ctrl2.signal, redirect: 'follow' });
    } catch (e) {
      const err = new Error('Could not download the processed image from ClearBackdrop');
      err.code = e && e.name === 'AbortError' ? 'ETIMEDOUT' : 'ENETUNREACH';
      throw err;
    } finally {
      clearTimeout(t2);
    }
    if (!img.ok) {
      const err = new Error('Failed to download result_url (' + img.status + ')');
      err.status = 502;
      throw err;
    }
    const buffer = Buffer.from(await img.arrayBuffer());
    const mime = (img.headers.get('content-type') || 'image/png').split(';')[0].trim();
    return { mime, buffer, meta, rate: Object.assign({}, rate, meta.quota || {}) };
  }

  const mime = (upstream.headers.get('content-type') || '').split(';')[0].trim();
  const buffer = Buffer.from(await upstream.arrayBuffer());

  if (!/^image\//.test(mime)) {
    const err = new Error('ClearBackdrop returned an unexpected response type: ' + (mime || 'unknown'));
    err.status = 502;
    err.code = 'EINVALIDRESPONSE';
    throw err;
  }
  if (!buffer.length) {
    const err = new Error('ClearBackdrop returned an empty image');
    err.status = 502;
    err.code = 'EINVALIDRESPONSE';
    throw err;
  }

  const info = describeBuffer(buffer);
  return {
    mime,
    buffer,
    meta: {
      image_size: info.width && info.height ? info.width + 'x' + info.height : null,
      cached: String(upstream.headers.get('x-cache') || '').toUpperCase() === 'HIT',
    },
    rate,
  };
}

/* --------------------------------------------------------------------- app */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const corsOptions = {
  origin(origin, cb) {
    if (!FRONTEND_ORIGIN || FRONTEND_ORIGIN === '*') return cb(null, true);
    const allow = FRONTEND_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
    if (!origin || allow.includes(origin)) return cb(null, true);
    return cb(new Error('Origin ' + origin + ' is not allowed by FRONTEND_ORIGIN'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  exposedHeaders: ['X-Quota-Remaining', 'X-Quota-Limit', 'X-Quota-Reset'],
  maxAge: 600,
};
app.use(cors(corsOptions));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const okMime = Object.prototype.hasOwnProperty.call(ALLOWED_MIME, (file.mimetype || '').toLowerCase());
    const okExt = ALLOWED_EXT.includes(ext);
    if (!okMime || !okExt) {
      const err = new Error('Unsupported image type. Send JPG, JPEG, PNG or WEBP.');
      err.code = 'EUNSUPPORTED';
      err.status = 415;
      return cb(err);
    }
    cb(null, true);
  },
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'passport-photo-studio-backend',
    clearbackdrop: {
      endpoint: CLEARBACKDROP_URL,
      mode: MOCK_MODE ? 'mock' : 'live',
      response_mode: RESPONSE_MODE,
      bria_model: Boolean(BRIA_KEY),
      timeout_ms: REQUEST_TIMEOUT_MS,
      max_upload_mb: MAX_UPLOAD_MB,
      allow_simulate: ALLOW_SIMULATE,
    },
    time: new Date().toISOString(),
  });
});

// Read-only quota proxy so the UI can show remaining credits.
app.get('/api/quota', async (req, res) => {
  if (MOCK_MODE) return res.json({ limit_per_hour: 100, remaining: 100, reset_seconds: 0, mock: true });
  try {
    const r = await fetch(QUOTA_URL, { redirect: 'error' });
    const data = await r.json();
    const rate = rateInfoFromHeaders(r.headers);
    res.json(Object.assign({}, data, { headers: rate }));
  } catch (e) {
    jsonError(res, 502, 'quota_unavailable', 'Could not fetch the ClearBackdrop quota: ' + e.message);
  }
});

app.post('/api/remove-background', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return jsonError(res, 413, 'file_too_large', 'Image exceeds the ' + MAX_UPLOAD_MB + 'MB limit.', {
          max_upload_mb: MAX_UPLOAD_MB,
        });
      }
      if (err.code === 'EUNSUPPORTED' || err.status === 415) {
        return jsonError(res, 415, 'unsupported_image', err.message);
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return jsonError(res, 400, 'bad_field_name', "The image must be uploaded under the field name 'image'.");
      }
      return jsonError(res, 400, 'upload_failed', err.message || 'Upload failed');
    }

    if (!req.file) {
      return jsonError(res, 400, 'no_image', "Attach the image under the multipart field name 'image'.");
    }
    if (!req.file.size) {
      return jsonError(res, 400, 'empty_image', 'The uploaded image is empty.');
    }

    const simulate = typeof req.body.simulate === 'string' ? req.body.simulate : null;
    const started = Date.now();

    try {
      const result = await postToClearBackdrop(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        simulate
      );

      res.setHeader('X-Quota-Remaining', String(result.rate.remaining));
      res.setHeader('X-Quota-Limit', String(result.rate.limit_per_hour));
      res.setHeader('X-Quota-Reset', String(result.rate.reset_seconds));
      res.json({
        ok: true,
        image: bufferToDataUrl(result.buffer, result.mime),
        mime: result.mime,
        bytes: result.buffer.length,
        size: result.meta.image_size || null,
        cached: Boolean(result.meta.cached),
        processing_time: result.meta.processing_time !== undefined ? result.meta.processing_time : null,
        mock: Boolean(result.meta.mock),
        quota: result.rate,
        took_ms: Date.now() - started,
      });
    } catch (e) {
      const status = e.status || (e.code === 'ETIMEDOUT' ? 504 : 502);
      const codeMap = {
        400: 'upstream_bad_request',
        403: 'invalid_bria_key',
        413: 'file_too_large',
        415: 'unsupported_image',
        429: 'rate_limited',
        500: 'upstream_processing_failed',
        502: 'invalid_upstream_response',
        504: 'upstream_timeout',
      };
      const code = e.code === 'EINVALIDRESPONSE' ? 'invalid_upstream_response' : e.code === 'ENETUNREACH' ? 'network_error' : e.code === 'ETIMEDOUT' ? 'upstream_timeout' : codeMap[status] || 'background_removal_failed';

      console.error('[remove-background] ' + status + ' ' + code + ' :: ' + e.message);

      jsonError(res, status, code, e.message, {
        upstream_status: e.status || null,
        upstream_error: (e.payload && e.payload.error) || null,
        retry_after_seconds: e.retryAfterSeconds || (status === 429 ? 60 : null),
        retryable: status === 429 || status === 500 || status === 502 || status === 504,
      });
    }
  });
});

/* ------------------------------------------------------------ static frontend */

if (fs.existsSync(FRONTEND_DIR)) {
  app.use(
    express.static(FRONTEND_DIR, {
      extensions: ['html'],
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );
} else {
  app.get('/', (req, res) =>
    res.status(500).send('frontend/ not found. Set FRONTEND_DIR or run from the project root.')
  );
}

/* --------------------------------------------------------------- error hooks */

app.use((req, res) => jsonError(res, 404, 'not_found', 'No route for ' + req.method + ' ' + req.path));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] ' + (err && err.message));
  if (res.headersSent) return;
  jsonError(res, err.status || 500, err.code || 'server_error', err.message || 'Unexpected server error');
});

/* --------------------------------------------------------------------- boot */

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Passport Photo Studio backend');
    console.log('  -----------------------------');
    console.log('  http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
    console.log('  frontend dir : ' + FRONTEND_DIR + (fs.existsSync(FRONTEND_DIR) ? '' : '  (MISSING)'));
    console.log('  clearbackdrop: ' + (MOCK_MODE ? 'MOCK MODE (no upstream calls)' : CLEARBACKDROP_URL));
    if (BRIA_KEY) console.log('  model        : BRIA RMBG-2.0 (X-Bria-Key configured)');
    if (FRONTEND_ORIGIN) console.log('  cors origins : ' + FRONTEND_ORIGIN);
    console.log('  limits       : ' + MAX_UPLOAD_MB + 'MB upload, ' + REQUEST_TIMEOUT_MS + 'ms timeout');
    console.log('');
  });
}

module.exports = app;
