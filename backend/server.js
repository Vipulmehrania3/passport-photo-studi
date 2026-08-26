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

const CLEARBACKDROP_BASE = String(
  process.env.CLEARBACKDROP_BASE || 'https://clearbackdrop.com'
).replace(/\/+$/, '');
const REMOVE_BG_PATH = process.env.CLEARBACKDROP_REMOVE_PATH || '/api/v1/remove-background';
const QUOTA_PATH = process.env.CLEARBACKDROP_QUOTA_PATH || '/api/v1/quota';

const CLEARBACKDROP_URL = CLEARBACKDROP_BASE + REMOVE_BG_PATH;
const QUOTA_URL = CLEARBACKDROP_BASE + QUOTA_PATH;

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 15);
const MAX_UPLOAD_BYTES = Math.round(MAX_UPLOAD_MB * 1024 * 1024);

const REQUEST_TIMEOUT_MS = Number(process.env.CLEARBACKDROP_TIMEOUT_MS || 60000);
const RESPONSE_MODE = (process.env.CLEARBACKDROP_RESPONSE_MODE || 'binary').toLowerCase();
const BRIA_KEY = process.env.CLEARBACKDROP_BRIA_KEY || '';
const MOCK_MODE = ['1', 'true', 'yes'].includes(String(process.env.CLEARBACKDROP_MOCK || '').toLowerCase());
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
  const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x4e && buffer[2] === 0x47 && buffer[3] === 0x0d;
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  let width = null;
  let height = null;
  if (isPng && buffer.length >= 24) {
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  }
  return { isPng, isJpeg, width, height };
}

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
    raw[y * (W * 4 + 1)] = 0;
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------- ClearBackdrop calls */

async function postToClearBackdrop(fileBuffer, filename, mimetype, simulate) {
  if (ALLOW_SIMULATE && simulate) {
    if (simulate === 'upstream_error') {
      const err = new Error('Simulated ClearBackdrop processing failure.');
      err.status = 500;
      err.payload = { error: 'processing_failed', message: err.message };
      throw err;
    }
    if (simulate === 'rate_limit') {
      const err = new Error('Simulated ClearBackdrop rate limit.');
      err.status = 429;
      err.payload = { error: 'rate_limited', message: err.message };
      err.retryAfterSeconds = 60;
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
      redirect: 'error',
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

// Open CORS for Netlify and localhost
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Quota-Remaining', 'X-Quota-Limit', 'X-Quota-Reset'],
}));

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

app.get('/', (req, res) => {
  res.send('Passport Photo Studio Backend is Live and Running!');
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

app.get('/api/quota', async (req, res) => {
  if (MOCK_MODE) return res.json({ limit_per_hour: 100, remaining: 100, reset_seconds: 0, mock: true });
  try {
    const r = await fetch(QUOTA_URL, { redirect: 'error' });
    const data = await r.json();
    const rate = rateInfoFromHeaders(r.headers);
    res.json(Object.assign({}, data, { headers: rate }));
  } catch (e) {
    jsonError(res, 502, 'quota_unavailable', 'Could not fetch ClearBackdrop quota: ' + e.message);
  }
});

app.post('/api/remove-background', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return jsonError(res, 413, 'file_too_large', 'Image exceeds ' + MAX_UPLOAD_MB + 'MB limit.');
      }
      return jsonError(res, 400, 'upload_failed', err.message || 'Upload failed');
    }

    if (!req.file || !req.file.size) {
      return jsonError(res, 400, 'no_image', 'Image is missing or empty.');
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
        quota: result.rate,
        took_ms: Date.now() - started,
      });
    } catch (e) {
      const status = e.status || 500;
      console.error('[remove-background] error:', e.message);
      jsonError(res, status, 'background_removal_failed', e.message);
    }
  });
});

app.use((req, res) => jsonError(res, 404, 'not_found', 'No route for ' + req.method + ' ' + req.path));

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log('Backend running on port ' + PORT);
  });
}

module.exports = app;