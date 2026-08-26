/* ==========================================================================
 * backend/test/smoke.test.js — real HTTP tests against the actual server.
 *
 *   npm test              -> live ClearBackdrop + validation + error paths
 *   CLEARBACKDROP_MOCK=1 npm test  -> same suite with the upstream mocked
 *
 * Every assertion is made against a response from backend/server.js.
 * ========================================================================== */
'use strict';

const assert = require('assert');
const path = require('path');
const zlib = require('zlib');
const app = require('../server.js');

const MODE = process.env.CLEARBACKDROP_MOCK === '1' ? 'mock' : 'live';
const ALLOW_SIMULATE = process.env.CLEARBACKDROP_MOCK === '1' || process.env.ALLOW_SIMULATE === '1';
const results = [];

/* --------------------------------------------------------------- utilities */

function pngBuffer(w, h, rgbaFn) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = rgbaFn(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Portrait-ish test image: subject in the middle, plain background around it.
function portraitPng(w, h) {
  return pngBuffer(w || 350, h || 450, (x, y) => {
    const cx = (w || 350) / 2;
    const cy = (h || 450) * 0.42;
    const d = Math.hypot((x - cx) / ((w || 350) * 0.22), (y - cy) / ((h || 450) * 0.26));
    if (d < 1) return [240, 205, 175, 255];
    if (y > (h || 450) * 0.72) return [40, 60, 110, 255];
    return [120, 160, 200, 255];
  });
}

function formWith(buf, name, mime, extraFields) {
  const fd = new FormData();
  fd.append('image', new Blob([new Uint8Array(buf)], { type: mime }), name);
  Object.keys(extraFields || {}).forEach((k) => fd.append(k, extraFields[k]));
  return fd;
}

function post(url, body) {
  return fetch(url, { method: 'POST', body });
}

function get(url) {
  return fetch(url);
}

function isPngBuffer(buf) {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(String(dataUrl).split(',')[1], 'base64');
}

async function test(name, fn, opts) {
  if (opts && opts.requiresSimulate && !ALLOW_SIMULATE) {
    results.push({ name, ok: true, skipped: true });
    console.log('  - ' + name + '  [skipped: needs ALLOW_SIMULATE=1]');
    return;
  }
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  \u2713 ' + name);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log('  \u2717 ' + name + '\n      ' + (e && e.message));
  }
}

/* ------------------------------------------------------------------- suite */

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  console.log('\n  backend smoke tests (' + MODE + ' mode) — ' + base + '\n');

  /* ------------------------------------------------------------- health */
  await test('GET /api/health reports the service and upstream config', async () => {
    const res = await get(base + '/api/health');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.service, 'passport-photo-studio-backend');
    assert.strictEqual(
      data.clearbackdrop.endpoint,
      'https://clearbackdrop.com/api/v1/remove-background',
      'must target the documented non-www v1 endpoint'
    );
    assert.strictEqual(data.clearbackdrop.mode, MODE);
    assert.strictEqual(data.clearbackdrop.max_upload_mb, 15);
  });

  await test('GET /api/health never leaks the BRIA key value', async () => {
    const res = await get(base + '/api/health');
    const data = await res.json();
    assert.strictEqual(data.clearbackdrop.bria_model, false, 'no key configured in tests');
    assert.ok(!JSON.stringify(data).includes(process.env.CLEARBACKDROP_BRIA_KEY || '__none__'));
  });

  /* ------------------------------------------------------ validation */
  await test('POST /api/remove-background without a file -> 400 no_image', async () => {
    const res = await post(base + '/api/remove-background', new FormData());
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.error, 'no_image');
    assert.ok(/image/i.test(data.message));
  });

  await test('upload under the wrong field name -> 400 bad_field_name', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(portraitPng())], { type: 'image/png' }), 'x.png');
    const res = await post(base + '/api/remove-background', fd);
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error === 'bad_field_name' || data.error === 'no_image', 'got ' + data.error);
  });

  await test('unsupported image type (GIF) -> 415 unsupported_image', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 0)]);
    const res = await post(base + '/api/remove-background', formWith(gif, 'a.gif', 'image/gif'));
    assert.strictEqual(res.status, 415);
    const data = await res.json();
    assert.strictEqual(data.error, 'unsupported_image');
  });

  await test('oversized upload (>15MB) -> 413 file_too_large', async () => {
    const big = Buffer.concat([portraitPng(64, 64), Buffer.alloc(16 * 1024 * 1024, 7)]);
    const res = await post(base + '/api/remove-background', formWith(big, 'big.png', 'image/png'));
    assert.strictEqual(res.status, 413);
    const data = await res.json();
    assert.strictEqual(data.error, 'file_too_large');
    assert.strictEqual(data.max_upload_mb, 15);
  });

  await test('empty upload -> 400 empty_image', async () => {
    const res = await post(base + '/api/remove-background', formWith(Buffer.alloc(0), 'e.png', 'image/png'));
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.error, 'empty_image');
  });

  /* ------------------------------------------------- error simulation */
  await test('upstream 500 -> 500 upstream_processing_failed, marked retryable', async () => {
    const res = await post(
      base + '/api/remove-background',
      formWith(portraitPng(), 'p.png', 'image/png', { simulate: 'upstream_error' })
    );
    assert.strictEqual(res.status, 500);
    const data = await res.json();
    assert.strictEqual(data.error, 'upstream_processing_failed');
    assert.strictEqual(data.retryable, true);
    assert.strictEqual(data.image, undefined, 'must NOT return the original image as a fallback');
  }, { requiresSimulate: true });

  await test('rate limit -> 429 rate_limited with retry_after_seconds', async () => {
    const res = await post(
      base + '/api/remove-background',
      formWith(portraitPng(), 'p.png', 'image/png', { simulate: 'rate_limit' })
    );
    assert.strictEqual(res.status, 429);
    const data = await res.json();
    assert.strictEqual(data.error, 'rate_limited');
    assert.ok(data.retry_after_seconds > 0, 'retry_after_seconds should be set');
  }, { requiresSimulate: true });

  await test('upstream timeout -> 504 upstream_timeout', async () => {
    const res = await post(
      base + '/api/remove-background',
      formWith(portraitPng(), 'p.png', 'image/png', { simulate: 'timeout' })
    );
    assert.strictEqual(res.status, 504);
    const data = await res.json();
    assert.strictEqual(data.error, 'upstream_timeout');
  }, { requiresSimulate: true });

  await test('unknown route -> 404 JSON, not HTML', async () => {
    const res = await get(base + '/api/nope');
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.strictEqual(data.error, 'not_found');
  });

  /* --------------------------------------------- successful removal */
  await test('POST a cropped PNG -> 200 with a transparent PNG data URL', async () => {
    const input = portraitPng(350, 450);
    const res = await post(base + '/api/remove-background', formWith(input, 'crop.png', 'image/png'));
    assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(/^data:image\/png;base64,/.test(data.image), 'expected a PNG data URL');

    const out = dataUrlToBuffer(data.image);
    assert.ok(isPngBuffer(out), 'payload is a real PNG');
    assert.strictEqual(out.readUInt32BE(16), 350, 'output width matches input width');
    assert.strictEqual(out.readUInt32BE(20), 450, 'output height matches input height');

    if (MODE === 'live') {
      assert.strictEqual(data.size, '350x450', 'size metadata present');
      // Real ClearBackdrop output must be RGBA with a transparent corner.
      assert.strictEqual(out[25], 6, 'colour type RGBA');
    }
    if (MODE === 'mock') assert.strictEqual(data.mock, true);

    assert.ok(res.headers.get('x-quota-remaining') !== null, 'quota header forwarded');
    assert.ok(data.quota && typeof data.quota.remaining === 'number', 'quota in body');
  });

  await test('JPEG input is accepted too', async () => {
    // Minimal valid JPEG (1x1) is enough to exercise the mime path in mock mode.
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'base64'
    );
    const res = await post(base + '/api/remove-background', formWith(jpeg, 'crop.jpg', 'image/jpeg'));
    assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status + ' ' + (await res.clone().text()).slice(0, 200));
    const data = await res.json();
    assert.ok(/^data:image\//.test(data.image));
  });

  /* ------------------------------------------------------- quota proxy */
  await test('GET /api/quota returns hourly quota numbers', async () => {
    const res = await get(base + '/api/quota');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.remaining === 'number' || (data.headers && typeof data.headers.remaining === 'number'));
  });

  /* ----------------------------------------------------- static serving */
  await test('GET / serves the frontend index.html', async () => {
    const res = await get(base + '/');
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Passport Photo Studio'));
    assert.ok(html.includes('js/app.js'), 'frontend scripts are referenced');
  });

  await test('frontend bundle contains no ClearBackdrop credentials', async () => {
    const fs = require('fs');
    const files = ['index.html', 'js/app.js', 'js/api.js', 'js/crop.js', 'js/editor.js', 'js/a4.js']
      .map((f) => path.join(__dirname, '..', '..', 'frontend', f));
    files.forEach((f) => {
      const src = fs.readFileSync(f, 'utf8');
      assert.ok(!/X-Bria-Key/i.test(src), f + ' must not reference the BRIA key header');
      assert.ok(!/CLEARBACKDROP_BRIA_KEY/.test(src), f + ' must not reference the env var');
      assert.ok(!/clearbackdrop\.com\/api/.test(src), f + ' must not call ClearBackdrop directly');
    });
  });

  server.close();

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(
    '\n  ' + (results.length - failed.length) + '/' + results.length + ' passed (' + MODE + ' mode' +
    (skipped ? ', ' + skipped + ' skipped' : '') + ')\n'
  );
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
