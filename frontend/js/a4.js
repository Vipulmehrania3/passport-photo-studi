/* ==========================================================================
 * a4.js — A4 sheet layout, rendering, export and printing.
 *
 *   const layout = A4.layout([{ id, copies, img, settings }, ...], { dpi });
 *   const canvases = A4.renderSheets(layout, dpi);
 *   A4.downloadPng(canvases); A4.downloadPdf(canvases); A4.print(canvases);
 *
 * Geometry is exact: A4 = 210 x 297 mm, photo = 35 x 45 mm (ratio 7:9).
 * ========================================================================== */
(function (global) {
  'use strict';

  var PAGE = { w: 210, h: 297 };        // mm
  var PHOTO = { w: 35, h: 45 };         // mm
  var DEFAULT_MARGIN = 5;               // mm, physical safety margin
  var DEFAULT_GAP = 5;                  // mm
  var RATIO = PHOTO.w / PHOTO.h;        // 0.7777...
  var PREVIEW_DPI = 40;                 // fast preview; exports use full dpi
  var MAX_EXPORT_DPI = 600;

  var MM_PER_INCH = 25.4;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function mmToPx(mm, dpi) { return (mm / MM_PER_INCH) * dpi; }

  /* --------------------------------------------------------- layout engine */

  /**
   * Pack photos onto A4 pages.
   * items: [{ id, label, copies, img, settings }]  (copies 1..99; 0 = skipped)
   */
  function layout(items, options) {
    options = options || {};
    var margin = options.margin === undefined ? DEFAULT_MARGIN : options.margin;
    var gap = options.gap === undefined ? DEFAULT_GAP : options.gap;
    var maxCols = options.maxCols || 8;
    var maxRows = options.maxRows || 12;

    // Flatten to single copies, in photo order (A A A A, B B B ...).
    var cells = [];
    (items || []).forEach(function (item) {
      var n = clamp(Math.round(Number(item.copies) || 0), 0, 99);
      for (var i = 0; i < n; i++) cells.push(item);
    });

    var capacity = Math.floor((PAGE.w - 2 * margin + gap) / (PHOTO.w + gap)) *
                   Math.floor((PAGE.h - 2 * margin + gap) / (PHOTO.h + gap));
    capacity = Math.max(1, capacity);

    var sheets = [];
    for (var i = 0; i < cells.length; i += capacity) {
      sheets.push(cells.slice(i, i + capacity));
    }

    var pages = sheets.map(function (sheetCells, index) {
      // Smallest grid that still holds this page's photos (keeps spacing even).
      var grid = bestGrid(sheetCells.length, margin, gap, maxCols, maxRows);

      var blockW = grid.cols * PHOTO.w + (grid.cols - 1) * grid.gapX;
      var blockH = grid.rows * PHOTO.h + (grid.rows - 1) * grid.gapY;
      var startX = (PAGE.w - blockW) / 2;
      var startY = (PAGE.h - blockH) / 2;

      var placed = sheetCells.map(function (item, k) {
        var col = k % grid.cols;
        var row = Math.floor(k / grid.cols);
        return {
          id: item.id,
          label: item.label,
          img: item.img,
          settings: item.settings,
          x: startX + col * (PHOTO.w + grid.gapX),
          y: startY + row * (PHOTO.h + grid.gapY),
          w: PHOTO.w,
          h: PHOTO.h,
        };
      });

      return {
        index: index + 1,
        count: placed.length,
        grid: grid,
        capacity: capacity,
        photos: placed,
      };
    });

    return {
      pages: pages,
      totalPages: pages.length,
      totalCopies: cells.length,
      perSheet: capacity,
      page: PAGE,
      photo: PHOTO,
      margin: margin,
    };
  }

  /**
   * Pick the grid for `n` photos: it must fit the page, and among the fitting
   * options we prefer the most balanced (closest to square) arrangement so
   * partial pages still look tidy.
   */
  function bestGrid(n, margin, gap, maxCols, maxRows) {
    var count = Math.max(1, n);
    var best = null;

    for (var cols = 1; cols <= maxCols; cols++) {
      for (var rows = 1; rows <= maxRows; rows++) {
        if (cols * rows < count) continue;
        var w = cols * PHOTO.w + (cols - 1) * gap;
        var h = rows * PHOTO.h + (rows - 1) * gap;
        if (w > PAGE.w - 2 * margin || h > PAGE.h - 2 * margin) continue;

        // Prefer the tightest grid, and among equally tight grids the one
        // whose shape is closest to the A4 page shape (portrait).
        var ratio = (cols * PHOTO.w) / (rows * PHOTO.h);
        var pageRatio = PAGE.w / PAGE.h;
        var score = (cols * rows - count) + Math.abs(Math.log(ratio / pageRatio)) * 0.35;
        if (!best || score < best.score) {
          best = { cols: cols, rows: rows, score: score };
        }
      }
    }

    if (!best) best = { cols: 1, rows: 1 };

    var gapX = best.cols > 1 ? (PAGE.w - 2 * margin - best.cols * PHOTO.w) / (best.cols - 1) : 0;
    var gapY = best.rows > 1 ? (PAGE.h - 2 * margin - best.rows * PHOTO.h) / (best.rows - 1) : 0;
    return { cols: best.cols, rows: best.rows, gapX: gapX, gapY: gapY };
  }

  /* -------------------------------------------------------------- rendering */

  /**
   * Render every page to a canvas at `dpi`.
   * Each photo cell is composited with Editor.renderFrame so edits, zoom and
   * background colour are baked in at full print resolution.
   */
  function renderSheets(layoutResult, dpi) {
    dpi = clamp(Number(dpi) || 300, 36, MAX_EXPORT_DPI);
    var pageW = Math.round(mmToPx(PAGE.w, dpi));
    var pageH = Math.round(mmToPx(PAGE.h, dpi));
    var Editor = global.Editor;

    return layoutResult.pages.map(function (page) {
      var canvas = document.createElement('canvas');
      canvas.width = pageW;
      canvas.height = pageH;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, pageW, pageH);

      // Composite each DISTINCT photo once at print size, then stamp it for
      // every copy. Copies of one photo are always pixel-identical.
      var frameCache = {};
      var cellW = Math.round(mmToPx(PHOTO.w, dpi));
      var cellH = Math.round(mmToPx(PHOTO.h, dpi));

      function frameFor(p) {
        var key = String(p.id);
        if (!(key in frameCache)) {
          frameCache[key] =
            Editor && typeof Editor.renderFrame === 'function' && p.img
              ? Editor.renderFrame(p.img, p.settings || {}, { width: cellW })
              : null;
        }
        return frameCache[key];
      }

      page.photos.forEach(function (p) {
        var x = Math.round(mmToPx(p.x, dpi));
        var y = Math.round(mmToPx(p.y, dpi));

        var frame = frameFor(p);
        if (frame) {
          ctx.drawImage(frame, x, y, cellW, cellH);
        } else if (p.img) {
          ctx.drawImage(p.img, x, y, cellW, cellH);
        }

        // Hairline trim guide (sits inside the safety margin).
        ctx.strokeStyle = 'rgba(150,160,175,.5)';
        ctx.lineWidth = Math.max(1, dpi / 300);
        ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
      });

      return canvas;
    });
  }

  /* ---------------------------------------------------------------- export */

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b); else reject(new Error('Could not encode the sheet.'));
      }, type, quality);
    });
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    global.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  async function downloadPng(canvases) {
    if (!canvases || !canvases.length) throw new Error('Nothing to download.');
    var base = 'passport-a4-' + stamp();
    for (var i = 0; i < canvases.length; i++) {
      var blob = await canvasToBlob(canvases[i], 'image/png');
      triggerDownload(blob, canvases.length > 1 ? base + '-page' + (i + 1) + '.png' : base + '.png');
      // Give the browser a beat between downloads.
      await new Promise(function (r) { global.setTimeout(r, 250); });
    }
    return canvases.length;
  }

  /** True when the bundled jsPDF build is present. */
  function hasPdfSupport() {
    return !!(global.jspdf && global.jspdf.jsPDF);
  }

  async function downloadPdf(canvases) {
    if (!canvases || !canvases.length) throw new Error('Nothing to download.');
    if (!hasPdfSupport()) {
      var err = new Error('jsPDF is not loaded (vendor/jspdf.umd.min.js). Downloading PNG instead.');
      err.code = 'pdf_unavailable';
      throw err;
    }

    var jsPDF = global.jspdf.jsPDF;
    var doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

    canvases.forEach(function (canvas, i) {
      if (i > 0) doc.addPage('a4', 'portrait');
      // JPEG keeps the PDF small; 0.95 is visually lossless at print size.
      var data = canvas.toDataURL('image/jpeg', 0.95);
      doc.addImage(data, 'JPEG', 0, 0, PAGE.w, PAGE.h, undefined, 'FAST');
    });

    doc.save('passport-a4-' + stamp() + '.pdf');
    return canvases.length;
  }

  /* ----------------------------------------------------------------- print */

  /**
   * Print ONLY the sheet(s). The app UI is hidden by CSS (@media print hides
   * everything except #printArea) and the artwork is injected there at full
   * 210x297mm.
   */
  async function print(canvases, container) {
    container = container || document.getElementById('printArea');
    if (!container) throw new Error('Print container #printArea is missing.');
    if (!canvases || !canvases.length) throw new Error('Nothing to print.');

    container.innerHTML = '';
    for (var i = 0; i < canvases.length; i++) {
      var blob = await canvasToBlob(canvases[i], 'image/png');
      var page = document.createElement('div');
      page.className = 'print-page';
      var img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      img.alt = 'A4 sheet ' + (i + 1);
      page.appendChild(img);
      container.appendChild(page);
    }

    // Let the images decode before the print dialog opens.
    await Promise.all(Array.prototype.map.call(container.querySelectorAll('img'), function (img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function (res) { img.onload = img.onerror = res; });
    }));

    global.focus();
    global.print();

    // Revoke after the print dialog closes.
    global.setTimeout(function () {
      Array.prototype.forEach.call(container.querySelectorAll('img'), function (img) {
        if (img.src.indexOf('blob:') === 0) URL.revokeObjectURL(img.src);
      });
      container.innerHTML = '';
    }, 1500);

    return canvases.length;
  }

  global.A4 = {
    PAGE: PAGE,
    PHOTO: PHOTO,
    RATIO: RATIO,
    PREVIEW_DPI: PREVIEW_DPI,
    layout: layout,
    bestGrid: bestGrid,
    renderSheets: renderSheets,
    downloadPng: downloadPng,
    downloadPdf: downloadPdf,
    hasPdfSupport: hasPdfSupport,
    print: print,
    mmToPx: mmToPx,
  };
})(typeof window !== 'undefined' ? window : globalThis);
