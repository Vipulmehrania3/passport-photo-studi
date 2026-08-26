/* ==========================================================================
 * backend/test/frontend.test.js — the real frontend, driven in jsdom.
 *
 * Loads frontend/index.html with its real <script> tags (api.js, crop.js,
 * editor.js, a4.js, app.js) into a jsdom window backed by node-canvas, then
 * exercises the workflow through the real DOM:
 *
 *   upload -> crop -> remove background -> library -> copies -> A4 -> export
 *
 * `API.removeBackground` is stubbed so no network is needed; everything else
 * is the shipping code.
 *
 *   npm run test:frontend
 * ========================================================================== */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { JSDOM, VirtualConsole } = require('jsdom');
require('canvas'); // gives jsdom a real 2D canvas

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
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

const PORTRAIT = pngBuffer(350, 450, (x, y) => {
  const d = Math.hypot((x - 175) / 80, (y - 190) / 110);
  if (d < 1) return [240, 205, 175, 255];
  if (y > 330) return [40, 60, 110, 255];
  return [120, 160, 200, 255];
});
const PORTRAIT_DATA_URL = 'data:image/png;base64,' + PORTRAIT.toString('base64');

// A transparent cutout, like the one ClearBackdrop returns.
const CUTOUT = pngBuffer(350, 450, (x, y) => {
  const d = Math.hypot((x - 175) / 80, (y - 190) / 110);
  if (d < 1) return [240, 205, 175, 255];
  if (y > 330) return [40, 60, 110, 255];
  return [0, 0, 0, 0];
});
const CUTOUT_DATA_URL = 'data:image/png;base64,' + CUTOUT.toString('base64');

/** Serve the real frontend/ over HTTP so jsdom loads the actual <script> tags. */
function startStaticServer() {
  const http = require('http');
  const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.join(FRONTEND, rel);
    if (!file.startsWith(FRONTEND)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port }));
  });
}

async function makeWindow() {
  const { server, base } = await startStaticServer();
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    if (/Not implemented/.test(e.message)) return; // jsdom: print(), etc.
    errors.push(e.message);
  });
  vc.on('error', () => { /* app-level console.error */ });

  const html = await (await fetch(base + '/index.html')).text();

  const dom = new JSDOM(html, {
    url: base + '/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });

  const w = dom.window;
  w.__staticServer = server;

  // jsdom has no object URLs (and its Files are opaque), so the tests register
  // a data URL per File and the polyfill hands that back. Browsers use real
  // blob: URLs — this only affects the test harness.
  const objectUrls = new Map();
  w.__fileDataUrls = objectUrls;
  w.URL.createObjectURL = function (blob) {
    const preset = objectUrls.get(blob);
    if (preset) return preset;
    const url = 'blob:jsdom/' + Math.random().toString(36).slice(2);
    return url;
  };
  w.URL.revokeObjectURL = function () {};

  // Print should not navigate anywhere.
  let printCalls = 0;
  w.print = function () { printCalls += 1; };
  w.focus = function () {};
  w.alert = function () {};

  // Anchor clicks must not attempt navigation.
  w.HTMLAnchorElement.prototype.click = function () { this.dataset.clicked = '1'; };

  w.__printCalls = () => printCalls;
  w.__jsdomErrors = errors;
  w.__objectUrls = objectUrls;
  return dom;
}

async function waitFor(fn, timeout, label) {
  const limit = Date.now() + (timeout || 15000);
  while (Date.now() < limit) {
    let value = null;
    try {
      value = await fn();
    } catch (_) {
      value = null;
    }
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('Timed out waiting for: ' + (label || 'condition'));
}

function buttonsIn(container) {
  return Array.prototype.slice.call(container.querySelectorAll('button'));
}

function findButton(container, text) {
  return buttonsIn(container).find((b) => b.textContent.trim() === text) || null;
}

function clickCropContinue(doc) {
  const btn = findButton(doc.getElementById('modalFoot'), 'Crop & Continue');
  assert.ok(btn, 'the crop modal must offer "Crop & Continue"');
  btn.click();
}

async function makeFile(w, name, type, buffer) {
  const buf = buffer || PORTRAIT;
  const file = new w.File([new Uint8Array(buf)], name, { type: type || 'image/png' });
  w.__fileDataUrls.set(file, 'data:' + (type || 'image/png') + ';base64,' + Buffer.from(buf).toString('base64'));
  return file;
}

async function blobToBuffer(w, blob) {
  if (typeof blob.arrayBuffer === 'function') return Buffer.from(await blob.arrayBuffer());
  // jsdom Blob: read it through the window's FileReader.
  return new Promise((resolve, reject) => {
    const fr = new w.FileReader();
    fr.onload = () => resolve(Buffer.from(String(fr.result).split(',')[1], 'base64'));
    fr.onerror = () => reject(new Error('FileReader failed'));
    fr.readAsDataURL(blob);
  });
}

function stubApi(w, impl) {
  const calls = [];
  w.API.removeBackground = async function (source, options) {
    calls.push({ source, options });
    return impl(source, options, calls.length);
  };
  return calls;
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  \u2713 ' + name);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log('  \u2717 ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e));
  }
}

/* ------------------------------------------------------------------- suite */

async function main() {
  console.log('\n  frontend tests (jsdom + node-canvas, real app code)\n');

  /* ------------------------------------------------------- module loading */
  let dom = await makeWindow();
  let w = dom.window;
  let doc = w.document;

  await waitFor(() => w.App && w.App.state, 10000, 'app to boot');

  await test('index.html loads every module and exposes the namespaces', async () => {
    assert.ok(w.API && typeof w.API.removeBackground === 'function', 'API');
    assert.ok(w.Crop && typeof w.Crop.open === 'function', 'Crop');
    assert.ok(w.Editor && typeof w.Editor.open === 'function', 'Editor');
    assert.ok(w.A4 && typeof w.A4.layout === 'function', 'A4');
    assert.ok(w.App && typeof w.App.handleFiles === 'function', 'App');
    assert.ok(w.jspdf && w.jspdf.jsPDF, 'vendored jsPDF is loaded');
    assert.ok(doc.getElementById('printArea'), 'print surface exists');
  });

  await test('jsPDF generates a valid A4 PDF from a rendered sheet', async () => {
    const canvas = doc.createElement('canvas');
    canvas.width = Math.round(w.A4.mmToPx(210, 150));
    canvas.height = Math.round(w.A4.mmToPx(297, 150));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#3366cc';
    ctx.fillRect(100, 100, 200, 300);

    let saved = null;
    const origCreate = w.URL.createObjectURL;
    w.URL.createObjectURL = function (blob) { saved = blob; return 'blob:pdf'; };
    await w.A4.downloadPdf([canvas]);
    w.URL.createObjectURL = origCreate;

    assert.ok(saved, 'a blob was produced');
    const buf = await blobToBuffer(w, saved);
    assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-', 'starts with the PDF header');
    assert.ok(buf.slice(-1024).toString().includes('%%EOF'), 'ends with %%EOF');
    assert.ok(saved.size > 2000, 'PDF has content (' + saved.size + ' bytes)');
  });

  /* ------------------------------------------------- upload validation */
  await test('unsupported file types are rejected before any cropping', async () => {
    w.App.state.photos.length = 0;
    w.App.handleFiles([await makeFile(w, 'anim.gif', 'image/gif')]);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(w.App.state.photos.length, 0, 'gif must not enter the pipeline');
    assert.ok(w.App.state.cropQueue.length === 0, 'nothing queued for cropping');
  });

  /* ------------------------------- THE core workflow: crop before removal */
  await test('multi-upload crops EACH image before any background removal', async () => {
    w.App.state.photos.length = 0;
    w.App.state.failed.length = 0;

    const order = [];
    const calls = stubApi(w, async () => {
      order.push('remove');
      return { image: CUTOUT_DATA_URL, mime: 'image/png', quota: { remaining: 99, limit_per_hour: 100 } };
    });

    w.App.handleFiles([
      await makeFile(w, 'a.png', 'image/png'),
      await makeFile(w, 'b.jpg', 'image/jpeg'),
      await makeFile(w, 'c.webp', 'image/webp'),
    ]);

    // 1st crop modal
    await waitFor(() => findButton(doc.getElementById('modalFoot'), 'Crop & Continue'), 8000, 'crop modal 1');
    assert.strictEqual(calls.length, 0, 'no removal may happen before the first crop');
    assert.match(doc.getElementById('modalTitle').textContent, /Crop 1 of 3/);
    clickCropContinue(doc);

    // 2nd crop modal
    await waitFor(() => /Crop 2 of 3/.test(doc.getElementById('modalTitle').textContent), 8000, 'crop modal 2');
    assert.strictEqual(calls.length, 0, 'no removal may happen before the second crop');
    assert.strictEqual(w.App.state.photos.filter((p) => p.status === 'ready').length, 0,
      'no photo may be "ready" before its crop is confirmed');
    clickCropContinue(doc);

    // 3rd crop modal + the "Processing N of M" progress text
    await waitFor(() => /Crop 3 of 3/.test(doc.getElementById('modalTitle').textContent), 8000, 'crop modal 3');
    assert.strictEqual(calls.length, 0, 'no removal may happen before the third crop');
    const batchPanel = doc.getElementById('batchPanel');
    assert.strictEqual(batchPanel.hidden, false, 'batch panel visible during the batch');
    assert.match(doc.getElementById('batchLabel').textContent, /Processing \d+ of 3/);
    clickCropContinue(doc);

    // removals now run, one per cropped image
    await waitFor(() => calls.length === 3, 15000, 'three removal calls');
    await waitFor(() => w.App.state.photos.filter((p) => p.status === 'ready').length === 3, 15000, 'three ready photos');

    assert.deepStrictEqual(order, ['remove', 'remove', 'remove'], 'removals only, and only after crops');
    assert.strictEqual(w.App.state.photos.filter((p) => p.status === 'ready').length, 3);
  });

  await test('crop output is high resolution and exactly 35:45', async () => {
    const photo = w.App.state.photos.filter((p) => p.status === 'ready')[0];
    assert.ok(photo, 'a ready photo exists');
    const img = await loadImageIn(w, photo.crop);
    const cw = img.naturalWidth || img.width;
    const ch = img.naturalHeight || img.height;
    const ratio = cw / ch;
    assert.ok(Math.abs(ratio - 35 / 45) < 0.01, 'crop ratio is 35:45 (got ' + ratio.toFixed(4) + ')');
    assert.ok(cw >= 350, 'crop keeps source resolution (' + cw + 'px wide)');
    assert.ok(/^data:image\/png/.test(photo.crop), 'crop is a PNG data URL');
  });

  await test('processed photos appear in the library with copies = 1', async () => {
    const cards = doc.querySelectorAll('#photoGrid .photo-card');
    assert.strictEqual(cards.length, 3, 'three library cards');
    const inputs = doc.querySelectorAll('#photoGrid .stepper input');
    assert.strictEqual(inputs.length, 3);
    Array.prototype.forEach.call(inputs, (i) => assert.strictEqual(i.value, '1', 'default copies is 1'));
    assert.strictEqual(doc.getElementById('libraryEmpty').hidden, true, 'empty state hidden');
    const card = cards[0];
    assert.ok(card.querySelector('.pc-frame img'), 'card shows the cutout preview');
    assert.ok(findButton(card, 'Edit') && findButton(card, 'Delete'), 'Edit + Delete buttons');
    assert.ok(card.querySelector('.check input[type=checkbox]').checked, 'included by default');
    assert.match(card.querySelector('.pc-top span').textContent, /Photo 1/);
  });

  await test('the library never contains an original-background image', async () => {
    w.App.readyPhotos().forEach((p) => {
      assert.ok(p.cutout, 'every library photo has a processed cutout');
      assert.notStrictEqual(p.cutout, p.sourceUrl, 'cutout is not the original upload');
      assert.notStrictEqual(p.cutout, p.crop, 'cutout is not the raw crop');
    });
  });

  /* -------------------------------------------------- failure: no fallback */
  await test('removal failure -> Retry/Cancel, and the ORIGINAL image is never added', async () => {
    w.App.state.photos.length = 0;
    w.App.state.failed.length = 0;
    doc.getElementById('photoGrid').innerHTML = '';

    stubApi(w, async () => {
      const err = new Error('ClearBackdrop returned 500');
      err.status = 500;
      err.code = 'upstream_processing_failed';
      err.retryable = true;
      throw err;
    });

    w.App.handleFiles([await makeFile(w, 'fail.png', 'image/png')]);
    await waitFor(() => findButton(doc.getElementById('modalFoot'), 'Crop & Continue'), 8000, 'crop modal');
    clickCropContinue(doc);

    // Failure dialog with exactly Retry / Cancel
    await waitFor(() => findButton(doc.getElementById('modalFoot'), 'Retry'), 10000, 'failure dialog');
    const foot = doc.getElementById('modalFoot');
    assert.strictEqual(doc.getElementById('modalTitle').textContent, 'Background removal failed');
    assert.ok(doc.getElementById('modalBody').textContent.includes('Background removal failed'));
    assert.ok(findButton(foot, 'Retry'), 'Retry offered');
    assert.ok(findButton(foot, 'Cancel'), 'Cancel offered');

    // Nothing entered the library.
    assert.strictEqual(doc.querySelectorAll('#photoGrid .photo-card').length, 0, 'library stays empty');
    assert.strictEqual(w.App.readyPhotos().length, 0, 'no ready photos');
    assert.strictEqual(w.App.state.failed.length, 1, 'photo parked in Needs attention');
    assert.ok(w.App.state.failed[0].cutout === null, 'no cutout was fabricated');
    assert.ok(doc.getElementById('failedPanel').hidden === false, 'Needs attention panel shown');

    // "Needs attention" offers Retry / Cancel too.
    const failedRow = doc.querySelector('#failedList .failed-item');
    assert.ok(findButton(failedRow, 'Retry') && findButton(failedRow, 'Cancel'));

    // Cancel drops it entirely — still no original-background copy anywhere.
    findButton(foot, 'Cancel').click();
    await waitFor(() => w.App.state.failed.length === 0, 5000, 'failed list cleared');
    assert.strictEqual(w.App.readyPhotos().length, 0, 'still nothing in the library');
  });

  await test('Retry from the failure dialog succeeds and adds the cutout', async () => {
    w.App.state.photos.length = 0;
    w.App.state.failed.length = 0;
    doc.getElementById('photoGrid').innerHTML = '';

    let attempt = 0;
    stubApi(w, async () => {
      attempt += 1;
      if (attempt === 1) {
        const err = new Error('Simulated failure');
        err.status = 500;
        throw err;
      }
      return { image: CUTOUT_DATA_URL, mime: 'image/png', quota: { remaining: 98, limit_per_hour: 100 } };
    });

    w.App.handleFiles([await makeFile(w, 'retry.png', 'image/png')]);
    await waitFor(() => findButton(doc.getElementById('modalFoot'), 'Crop & Continue'), 8000, 'crop modal');
    clickCropContinue(doc);
    await waitFor(() => findButton(doc.getElementById('modalFoot'), 'Retry'), 10000, 'failure dialog');
    findButton(doc.getElementById('modalFoot'), 'Retry').click();

    await waitFor(() => w.App.readyPhotos().length === 1, 10000, 'photo recovered after retry');
    assert.strictEqual(attempt, 2, 'the retry called the API a second time');
    assert.strictEqual(w.App.state.failed.length, 0, 'no longer in Needs attention');
    assert.strictEqual(doc.querySelectorAll('#photoGrid .photo-card').length, 1, 'now in the library');
  });

  /* ---------------------------------------------------------- copies + A4 */
  await test('copies stepper clamps to 0..99 and 0 excludes the photo', async () => {
    const card = doc.querySelector('#photoGrid .photo-card');
    const input = card.querySelector('.stepper input');
    const minus = card.querySelectorAll('.stepper button')[0];
    const plus = card.querySelectorAll('.stepper button')[1];

    input.value = '250';
    input.dispatchEvent(new w.Event('change'));
    assert.strictEqual(w.App.readyPhotos()[0].copies, 99, 'clamped to 99');

    input.value = '-5';
    input.dispatchEvent(new w.Event('change'));
    assert.strictEqual(w.App.readyPhotos()[0].copies, 0, 'clamped to 0');
    assert.strictEqual(minus.disabled, true, 'minus disabled at 0');
    assert.ok(card.classList.contains('is-excluded'), 'card marked excluded');

    plus.click();
    plus.click();
    assert.strictEqual(w.App.readyPhotos()[0].copies, 2, 'plus increments');
  });

  await test('A4 layout: 25 photos per sheet, exact 35x45mm, multi-page packing', async () => {
    const img = await loadImageIn(w, CUTOUT_DATA_URL);
    const items = [
      { id: 'a', copies: 4, img, settings: {} },
      { id: 'b', copies: 6, img, settings: {} },
      { id: 'c', copies: 2, img, settings: {} },
      { id: 'd', copies: 0, img, settings: {} }, // 0 copies -> excluded
    ];
    const layout = w.A4.layout(items, {});

    // 5 columns x 5 rows is the maximum at 5mm margins:
    //   width  5*35 + 4*5 = 195mm <= 200mm usable  (6 cols = 235mm, too wide)
    //   height 5*45 + 4*5 = 245mm <= 287mm usable  (6 rows = 295mm, too tall)
    assert.strictEqual(layout.perSheet, 25, 'A4 holds 25 passport photos at 5mm margins');
    assert.strictEqual(layout.page.w, 210, 'page is 210mm wide');
    assert.strictEqual(layout.page.h, 297, 'page is 297mm tall');
    assert.strictEqual(layout.totalCopies, 12, 'copies = 0 contributes nothing');
    assert.strictEqual(layout.totalPages, 1);
    // bestGrid picks the tightest grid closest to the page shape.
    // 6 rows cannot fit (6*45 + 5*5 = 295mm > 287mm usable), so 3x4 it is.
    assert.strictEqual(layout.pages[0].grid.cols, 3, '12 photos -> 3x4 grid');
    assert.strictEqual(layout.pages[0].grid.rows, 4);

    const counts = {};
    layout.pages[0].photos.forEach((p) => { counts[p.id] = (counts[p.id] || 0) + 1; });
    assert.deepStrictEqual(counts, { a: 4, b: 6, c: 2 }, 'A x4, B x6, C x2 on the sheet');

    // Exact physical size + ratio for every placed photo.
    layout.pages[0].photos.forEach((p) => {
      assert.strictEqual(p.w, 35, 'photo is 35mm wide');
      assert.strictEqual(p.h, 45, 'photo is 45mm tall');
      assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= 210 && p.y + p.h <= 297, 'inside the page');
    });

    // Spills onto a second page.
    const big = w.A4.layout([{ id: 'x', copies: 30, img, settings: {} }], {});
    assert.strictEqual(big.totalPages, 2, '30 copies need 2 sheets');
    assert.strictEqual(big.pages[0].count, 25, 'first sheet is full');
    assert.strictEqual(big.pages[1].count, 5, '5 copies spill onto page 2');
  });

  await test('renderSheets produces a true 210x297mm canvas at the chosen DPI', async () => {
    const img = await loadImageIn(w, CUTOUT_DATA_URL);
    const layout = w.A4.layout([{ id: 'a', copies: 4, img, settings: { bg: '#FFFFFF', zoom: 100 } }], {});
    const sheets = w.A4.renderSheets(layout, 300);
    assert.strictEqual(sheets.length, 1);
    assert.strictEqual(sheets[0].width, Math.round((210 / 25.4) * 300), 'A4 width at 300dpi = 2480');
    assert.strictEqual(sheets[0].height, Math.round((297 / 25.4) * 300), 'A4 height at 300dpi = 3508');

    // The sheet must not be blank.
    const ctx = sheets[0].getContext('2d');
    const data = ctx.getImageData(0, 0, sheets[0].width, sheets[0].height).data;
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) nonWhite++;
    }
    assert.ok(nonWhite > 1000, 'photos were drawn (' + nonWhite + ' non-white pixels)');
  });

  /* --------------------------------------------------- end-to-end via UI */
  await test('UI: copies -> A4 preview -> PNG download at full resolution', async () => {
    // One ready photo with 4 copies is already in place from the retry test.
    const card = doc.querySelector('#photoGrid .photo-card');
    const input = card.querySelector('.stepper input');
    input.value = '4';
    input.dispatchEvent(new w.Event('change'));

    doc.getElementById('regenerateBtn').click();

    await waitFor(() => doc.querySelectorAll('#sheetPages .sheet-page').length === 1, 15000, 'sheet preview');
    assert.strictEqual(doc.getElementById('sheetPreviewEmpty').hidden, true, 'placeholder hidden');
    assert.match(doc.querySelector('#sheetPages figcaption').textContent, /Page 1 of 1/);
    assert.strictEqual(doc.getElementById('printBtn').disabled, false, 'print enabled');
    assert.strictEqual(doc.getElementById('downloadPdfBtn').disabled, false, 'pdf enabled');
    assert.match(doc.getElementById('sheetSummary').textContent, /1 photo/);

    let blob = null;
    const orig = w.URL.createObjectURL;
    w.URL.createObjectURL = function (b) { blob = b; return 'blob:png'; };
    await w.A4.downloadPng(await w.App.fullSheets());
    w.URL.createObjectURL = orig;

    assert.ok(blob, 'PNG blob produced');
    assert.strictEqual(blob.type, 'image/png');
    const full = await w.App.fullSheets();
    assert.strictEqual(full[0].width, 2480, 'export is 2480px wide (A4 @300dpi)');
    assert.strictEqual(full[0].height, 3508, 'export is 3508px tall (A4 @300dpi)');
  });

  await test('UI: Print sends only the A4 sheet to #printArea', async () => {
    const before = w.__printCalls();
    await w.A4.print(await w.App.fullSheets(), doc.getElementById('printArea'));
    assert.strictEqual(w.__printCalls(), before + 1, 'window.print() called once');

    const pages = doc.querySelectorAll('#printArea .print-page');
    assert.strictEqual(pages.length, 1, 'one A4 page injected');
    assert.ok(pages[0].querySelector('img'), 'page holds the sheet image');

    // The app UI itself is never printed (CSS hides it; verify the rule exists).
    const css = fs.readFileSync(path.join(FRONTEND, 'css', 'style.css'), 'utf8');
    assert.ok(/@media print/.test(css), 'print stylesheet present');
    assert.ok(/@page\s*{\s*size:\s*210mm 297mm;\s*margin:\s*0/.test(css), 'exact A4 @page rule');
    assert.ok(/body \* { visibility: hidden/.test(css), 'everything hidden except the print area');
    assert.ok(/#printArea, #printArea \* { visibility: visible/.test(css), 'print area shown');
  });

  /* --------------------------------------------------------------- editor */
  await test('Editor opens with live preview and applies settings', async () => {
    const photo = w.App.readyPhotos()[0];
    const before = JSON.stringify(photo.settings);

    const openPromise = w.Editor.open(photo);
    const preview = await waitFor(() => doc.querySelector('.editor-preview canvas'), 10000, 'editor preview');
    assert.strictEqual(preview.width, 1050, 'preview rendered at high resolution');
    assert.strictEqual(preview.height, 1350, 'preview keeps the 35:45 ratio');

    const sliders = Array.prototype.slice.call(doc.querySelectorAll('.editor-side input[type=range]'));
    assert.ok(sliders.length >= 6, 'zoom/rotate/brightness/contrast/saturation/sharpness sliders (' + sliders.length + ')');

    // Sample a corner pixel: that area is pure background colour.
    const previewBefore = preview.getContext('2d').getImageData(30, 30, 1, 1).data.join(',');

    // Change saturation + background colour and confirm the preview reacts.
    sliders[4].value = '0';
    sliders[4].dispatchEvent(new w.Event('input'));
    const colorInput = doc.querySelector('.swatch-custom input[type=color]');
    colorInput.value = '#dce9f7';
    colorInput.dispatchEvent(new w.Event('input'));

    await new Promise((r) => setTimeout(r, 300));
    const previewAfter = preview.getContext('2d').getImageData(30, 30, 1, 1).data.join(',');
    assert.notStrictEqual(previewBefore, previewAfter, 'preview updates live');

    // Reset restores the defaults in the UI.
    findButton(doc.getElementById('modalFoot'), 'Reset').click();
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(sliders[4].value, '100', 'saturation reset to 100');

    findButton(doc.getElementById('modalFoot'), 'Apply').click();
    const result = await openPromise;
    assert.ok(result, 'Apply resolves with a result');
    assert.strictEqual(result.settings.bg, '#FFFFFF', 'reset restored the white background');
    assert.deepStrictEqual(photo.settings, result.settings, 'settings persisted onto the photo');
    assert.ok(before.length > 2, 'photo had settings before editing');
  });

  await test('Editor background swatches offer white / light blue / light grey / custom', async () => {
    const photo = w.App.readyPhotos()[0];
    const openPromise = w.Editor.open(photo);
    await waitFor(() => doc.querySelector('.editor-preview canvas'), 10000, 'editor preview');

    const swatches = Array.prototype.slice.call(doc.querySelectorAll('.swatches .swatch'));
    assert.strictEqual(swatches.length, 3, 'three preset swatches');
    assert.deepStrictEqual(
      swatches.map((s) => s.dataset.color),
      ['#FFFFFF', '#DCE9F7', '#E8E8E8'],
      'white / light blue / light grey'
    );
    assert.ok(doc.querySelector('.swatch-custom input[type=color]'), 'custom colour picker');
    assert.strictEqual(w.Editor.DEFAULTS.bg, '#FFFFFF', 'default background is white');

    findButton(doc.getElementById('modalFoot'), 'Cancel').click();
    assert.strictEqual(await openPromise, null, 'Cancel resolves to null (no changes)');
  });

  /* -------------------------------------------------------- crop geometry */
  await test('Crop geometry: 35:45 source rect, clamped inside the image', async () => {
    const img = await loadImageIn(w, PORTRAIT_DATA_URL);
    const cropper = w.Crop._internal.createCropper(img);
    const view = { stageW: 400, stageH: 400, cropW: 200, cropH: 200 / (35 / 45) };

    const g = cropper.viewGeom(view);
    const src = cropper.sourceRect(g);
    const ratio = src.w / src.h;
    assert.ok(Math.abs(ratio - 35 / 45) < 1e-6, 'source rect is exactly 35:45 (' + ratio.toFixed(6) + ')');
    assert.ok(src.x >= 0 && src.y >= 0, 'origin inside the image');
    assert.ok(src.x + src.w <= img.naturalWidth + 1e-6, 'width inside the image');
    assert.ok(src.y + src.h <= img.naturalHeight + 1e-6, 'height inside the image');

    // Pan far away: the clamp must hold.
    cropper.state.offsetX = 99999;
    cropper.state.offsetY = -99999;
    const g2 = cropper.viewGeom(view);
    const src2 = cropper.sourceRect(g2);
    assert.ok(src2.x >= 0 && src2.y >= 0, 'clamped after extreme pan');
    assert.ok(src2.x + src2.w <= img.naturalWidth + 1e-6);
    assert.ok(src2.y + src2.h <= img.naturalHeight + 1e-6);

    // Rotation swaps the working dimensions and still yields a 35:45 rect.
    cropper.rotate(view, 90);
    const g3 = cropper.viewGeom(view);
    const src3 = cropper.sourceRect(g3);
    assert.ok(Math.abs(src3.w / src3.h - 35 / 45) < 1e-6, 'still 35:45 after a 90° rotation');
    assert.ok(src3.x + src3.w <= img.naturalHeight + 1e-6, 'bounds follow the rotated image');
  });

  await test('Cancelling a crop keeps the photo out of the library', async () => {
    w.App.state.photos.length = 0;
    w.App.state.failed.length = 0;
    doc.getElementById('photoGrid').innerHTML = '';
    stubApi(w, async () => ({ image: CUTOUT_DATA_URL, mime: 'image/png', quota: { remaining: 97 } }));

    w.App.handleFiles([await makeFile(w, 'skip.png', 'image/png')]);
    await waitFor(() => findButton(doc.getElementById('modalFoot'), 'Crop & Continue'), 8000, 'crop modal');
    findButton(doc.getElementById('modalFoot'), 'Cancel').click();

    await waitFor(() => w.App.state.photos[0].status === 'cancelled', 8000, 'crop cancelled');
    assert.strictEqual(doc.querySelectorAll('#photoGrid .photo-card').length, 0, 'nothing in the library');
    assert.strictEqual(w.App.readyPhotos().length, 0);
  });

  /* ------------------------------------------------------------- security */
  await test('frontend files contain no backend secrets and no direct ClearBackdrop calls', async () => {
    ['index.html', 'js/api.js', 'js/app.js', 'js/crop.js', 'js/editor.js', 'js/a4.js'].forEach((f) => {
      const src = fs.readFileSync(path.join(FRONTEND, f), 'utf8');
      assert.ok(!/X-Bria-Key/i.test(src), f + ': no BRIA key header');
      assert.ok(!/CLEARBACKDROP_[A-Z_]*KEY/.test(src), f + ': no credential env var');
      assert.ok(!/clearbackdrop\.com\/api/.test(src), f + ': no direct API call');
    });
    const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
    const inlineScripts = (html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || []);
    const inlineChars = inlineScripts.reduce((n, s) => n + s.length, 0);
    assert.ok(inlineChars < 400, 'index.html holds only the small config script (' + inlineChars + ' chars inline)');
    assert.ok(inlineScripts.length === 1, 'exactly one inline script (the runtime config)');
    assert.ok(!/<style/i.test(html), 'no inline <style> blocks — styling lives in style.css');
    assert.ok(html.includes('css/style.css'), 'styles live in style.css');
  });

  await test('no uncaught jsdom errors during the whole run', async () => {
    // Ignored: jsdom harness gaps, not app bugs — CSS parsing of modern
    // features, unimplemented browser APIs, and blob: URLs (jsdom cannot
    // fetch them; a real browser renders the print <img> normally).
    const harnessNoise = /Not implemented|Could not parse CSS|Could not load img: "blob:/;
    const errs = w.__jsdomErrors.filter((m) => !harnessNoise.test(m));
    assert.deepStrictEqual(errs, [], 'jsdom reported: ' + errs.join(' | '));
  });

  if (w.__staticServer) w.__staticServer.close();
  dom.window.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n  ' + (results.length - failed.length) + '/' + results.length + ' frontend tests passed\n');
  if (failed.length) process.exit(1);
}

function loadImageIn(w, src) {
  return new Promise((resolve, reject) => {
    const img = new w.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
