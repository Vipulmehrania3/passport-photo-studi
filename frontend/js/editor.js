/* ==========================================================================
 * editor.js — per-photo editor.
 *
 *   const out = await Editor.open(photo);
 *   // null                                  -> cancelled, nothing changed
 *   // { settings, cutout }                 -> Apply pressed
 *
 * The cutout stays TRANSPARENT internally; the background colour is only
 * composited when rendering. Nothing is ever stretched: zoom scales the whole
 * frame uniformly, so the 35:45 aspect ratio (and the face) is preserved.
 * ========================================================================== */
(function (global) {
  'use strict';

  var RATIO = 35 / 45;
  var RENDER_WIDTH = 1050;              // 35mm @ 300dpi ≈ 413px; 1050 keeps headroom
  var RENDER_HEIGHT = Math.round(RENDER_WIDTH / RATIO);

  var BACKGROUNDS = [
    { id: 'white', label: 'White', color: '#FFFFFF' },
    { id: 'blue', label: 'Light blue', color: '#DCE9F7' },
    { id: 'grey', label: 'Light grey', color: '#E8E8E8' },
  ];

  var DEFAULTS = {
    zoom: 100,          // %
    rotation: 0,        // degrees
    brightness: 100,    // %
    contrast: 100,      // %
    saturation: 100,    // %
    sharpness: 0,       // 0..100
    bg: '#FFFFFF',
  };

  /* ------------------------------------------------------------- utilities */

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(label, className) {
    var b = el('button', 'btn ' + (className || ''));
    b.type = 'button';
    b.textContent = label;
    return b;
  }

  function sliderRow(label, min, max, step, value, unit) {
    var wrap = el('div', 'slider');
    wrap.appendChild(el('span', null, label));
    var input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    var out = document.createElement('output');
    out.textContent = value + (unit || '');
    input.addEventListener('input', function () { out.textContent = input.value + (unit || ''); });
    wrap.appendChild(input);
    wrap.appendChild(out);
    return { wrap: wrap, input: input, output: out };
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not decode the cutout image.')); };
      img.src = src;
    });
  }

  function isTransparentPng(img) {
    try {
      var c = document.createElement('canvas');
      c.width = Math.min(32, img.naturalWidth || img.width);
      c.height = Math.max(1, Math.round(c.width * (img.naturalHeight || img.height) / (img.naturalWidth || img.width)));
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      var d = ctx.getImageData(0, 0, c.width, c.height).data;
      var transparent = 0;
      for (var i = 3; i < d.length; i += 4) if (d[i] < 16) transparent++;
      return transparent / (d.length / 4) > 0.05;
    } catch (_) {
      return false;
    }
  }

  /** Unsharp mask — a practical sharpening pass over the composited frame. */
  function unsharp(ctx, w, h, amount) {
    if (!amount) return;
    var src = ctx.getImageData(0, 0, w, h);

    var tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    var tctx = tmp.getContext('2d');
    try {
      tctx.filter = 'blur(1.4px)';
    } catch (_) { /* filter unsupported: skip sharpening */ return; }
    tctx.putImageData(src, 0, 0);
    var blur = document.createElement('canvas');
    blur.width = w; blur.height = h;
    var bctx = blur.getContext('2d');
    bctx.filter = 'blur(1.4px)';
    bctx.drawImage(tmp, 0, 0);

    var blurred = bctx.getImageData(0, 0, w, h);
    var a = src.data;
    var b = blurred.data;
    var k = amount;
    for (var i = 0; i < a.length; i += 4) {
      a[i] = clamp(a[i] + (a[i] - b[i]) * k, 0, 255);
      a[i + 1] = clamp(a[i + 1] + (a[i + 1] - b[i + 1]) * k, 0, 255);
      a[i + 2] = clamp(a[i + 2] + (a[i + 2] - b[i + 2]) * k, 0, 255);
    }
    ctx.putImageData(src, 0, 0);
  }

  /* ------------------------------------------------------- compositing core */

  /**
   * Draw one passport frame: background colour + transparent cutout on top.
   * Returns the canvas. `dpi` only affects the output pixel size.
   */
  function renderFrame(img, settings, opts) {
    opts = opts || {};
    var width = opts.width || RENDER_WIDTH;
    var height = Math.round(width / RATIO);
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');

    // 1. background colour
    ctx.fillStyle = settings.bg || '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    if (!img) return canvas;

    // 2. cutout, uniformly scaled (never stretched) + rotated about its centre
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    if (!iw || !ih) return canvas;

    var fit = Math.min(width / iw, height / ih);
    var zoom = (settings.zoom || 100) / 100;
    var s = fit * zoom;
    var dw = iw * s;
    var dh = ih * s;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    var filter =
      'brightness(' + (settings.brightness || 100) / 100 + ') ' +
      'contrast(' + (settings.contrast || 100) / 100 + ') ' +
      'saturate(' + (settings.saturation || 100) / 100 + ')';
    try { ctx.filter = filter; } catch (_) { /* ignore */ }

    ctx.translate(width / 2, height / 2);
    ctx.rotate(((settings.rotation || 0) * Math.PI) / 180);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    try { ctx.filter = 'none'; } catch (_) { /* ignore */ }

    // 3. sharpening pass
    if (settings.sharpness) unsharp(ctx, width, height, settings.sharpness / 100);

    return canvas;
  }

  /* ------------------------------------------------------------ public API */

  function open(photo) {
    return new Promise(function (resolve) {
      var modal = global.App.Modal;
      var settings = Object.assign({}, DEFAULTS, photo.settings || {});
      var draft = Object.assign({}, settings);
      var cutoutSrc = photo.cutout;
      var cutoutImg = null;
      var settled = false;
      var renderTimer = 0;

      function finish(value) {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(value);
      }

      loadImage(cutoutSrc)
        .then(function (img) {
          cutoutImg = img;
          build();
        })
        .catch(function (err) {
          global.App.toast((err && err.message) || 'Could not open the editor.', 'error');
          finish(null);
        });

      function build() {
        var body = el('div', 'editor-layout');

        /* ---- preview ---- */
        var previewWrap = el('div', 'editor-preview');
        var previewCanvas = document.createElement('canvas');
        previewCanvas.width = RENDER_WIDTH;
        previewCanvas.height = RENDER_HEIGHT;
        previewCanvas.style.width = '100%';
        previewCanvas.style.maxWidth = '380px';
        previewWrap.appendChild(previewCanvas);
        body.appendChild(previewWrap);

        var transparent = isTransparentPng(cutoutImg);
        if (!transparent) {
          var warn = el('p', 'bg-note', 'This image does not look like a transparent cutout. Re-run background removal for a clean result.');
          warn.style.color = '#9a6200';
          previewWrap.appendChild(warn);
        }

        /* ---- controls ---- */
        var side = el('div', 'editor-side');

        // geometry
        var geo = el('div', 'control-group');
        geo.appendChild(el('h3', null, 'Framing'));
        var zoom = sliderRow('Zoom', 60, 200, 1, draft.zoom, '%');
        var rotate = sliderRow('Rotate', -45, 45, 1, draft.rotation, '\u00b0');
        geo.appendChild(zoom.wrap);
        geo.appendChild(rotate.wrap);
        var cropBtn = button('Re-crop 35:45', 'btn-sm btn-ghost');
        cropBtn.style.marginTop = '8px';
        geo.appendChild(cropBtn);
        side.appendChild(geo);

        // adjustments
        var adj = el('div', 'control-group');
        adj.appendChild(el('h3', null, 'Adjustments'));
        var brightness = sliderRow('Brightness', 50, 150, 1, draft.brightness, '%');
        var contrast = sliderRow('Contrast', 50, 150, 1, draft.contrast, '%');
        var saturation = sliderRow('Saturation', 0, 200, 1, draft.saturation, '%');
        var sharpness = sliderRow('Sharpness', 0, 100, 1, draft.sharpness, '');
        adj.appendChild(brightness.wrap);
        adj.appendChild(contrast.wrap);
        adj.appendChild(saturation.wrap);
        adj.appendChild(sharpness.wrap);
        side.appendChild(adj);

        // background
        var bg = el('div', 'control-group');
        bg.appendChild(el('h3', null, 'Background'));
        var swatches = el('div', 'swatches');
        var swatchEls = [];
        BACKGROUNDS.forEach(function (b) {
          var s = el('button', 'swatch');
          s.type = 'button';
          s.style.background = b.color;
          s.title = b.label;
          s.setAttribute('aria-label', b.label);
          s.dataset.color = b.color.toUpperCase();
          s.addEventListener('click', function () {
            draft.bg = b.color;
            colorInput.value = b.color;
            syncSwatches();
            scheduleRender();
          });
          swatches.appendChild(s);
          swatchEls.push(s);
        });

        var custom = el('label', 'swatch-custom');
        custom.appendChild(el('span', null, 'Custom'));
        var colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = draft.bg;
        colorInput.addEventListener('input', function () {
          draft.bg = colorInput.value.toUpperCase();
          syncSwatches();
          scheduleRender();
        });
        custom.appendChild(colorInput);
        swatches.appendChild(custom);
        bg.appendChild(swatches);
        bg.appendChild(el('p', 'bg-note', 'The cutout itself stays transparent — only the composite uses this colour.'));
        side.appendChild(bg);

        function syncSwatches() {
          swatchEls.forEach(function (s) {
            s.classList.toggle('is-active', s.dataset.color === String(draft.bg).toUpperCase());
          });
        }
        syncSwatches();

        body.appendChild(side);

        /* ---- live render ---- */
        function readControls() {
          draft.zoom = Number(zoom.input.value);
          draft.rotation = Number(rotate.input.value);
          draft.brightness = Number(brightness.input.value);
          draft.contrast = Number(contrast.input.value);
          draft.saturation = Number(saturation.input.value);
          draft.sharpness = Number(sharpness.input.value);
        }

        function paint() {
          renderTimer = 0;
          readControls();
          var frame = renderFrame(cutoutImg, draft, { width: RENDER_WIDTH });
          var pctx = previewCanvas.getContext('2d');
          pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
          pctx.drawImage(frame, 0, 0);
        }

        function scheduleRender() {
          if (renderTimer) return;
          renderTimer = global.setTimeout(paint, 24);
        }

        [zoom, rotate, brightness, contrast, saturation, sharpness].forEach(function (s) {
          s.input.addEventListener('input', scheduleRender);
        });

        cropBtn.addEventListener('click', async function () {
          var src = photo.crop || photo.source || cutoutSrc;
          var result = await global.Crop.open(src, { title: 'Re-crop photo \u2014 35 : 45' });
          if (!result) {
            // The crop modal replaced our modal content: restore the editor.
            modal.open({
              title: 'Edit photo ' + (photo.number || ''),
              body: body,
              buttons: footButtons,
              onClose: function () { finish(null); },
            });
            scheduleRender();
            return;
          }
          modal.open({
            title: 'Edit photo ' + (photo.number || ''),
            body: body,
            buttons: footButtons,
            onClose: function () { finish(null); },
          });
          // Re-cropping invalidates the processed cutout — it must go through
          // background removal again. Hand that back to the app.
          photo.pendingRecrop = result.dataUrl;
          global.App.toast('New crop accepted. Background removal will run again when you apply.', 'warn');
          cutoutImg = await global.Crop.loadImage(result.dataUrl);
          scheduleRender();
        });

        /* ---- footer ---- */
        var cancelBtn = button('Cancel', '');
        cancelBtn.addEventListener('click', function () { finish(null); });

        var resetBtn = button('Reset', 'btn-ghost');
        resetBtn.addEventListener('click', function () {
          draft = Object.assign({}, DEFAULTS);
          zoom.input.value = String(draft.zoom); zoom.output.textContent = draft.zoom + '%';
          rotate.input.value = String(draft.rotation); rotate.output.textContent = draft.rotation + '\u00b0';
          brightness.input.value = String(draft.brightness); brightness.output.textContent = draft.brightness + '%';
          contrast.input.value = String(draft.contrast); contrast.output.textContent = draft.contrast + '%';
          saturation.input.value = String(draft.saturation); saturation.output.textContent = draft.saturation + '%';
          sharpness.input.value = String(draft.sharpness); sharpness.output.textContent = String(draft.sharpness);
          colorInput.value = draft.bg;
          syncSwatches();
          scheduleRender();
        });

        var applyBtn = button('Apply', 'btn-primary');
        applyBtn.addEventListener('click', function () {
          readControls();
          finish({
            settings: Object.assign({}, draft),
            recrop: photo.pendingRecrop || null,
            preview: previewCanvas.toDataURL('image/png'),
          });
        });

        var footButtons = [cancelBtn, resetBtn, applyBtn];

        modal.open({
          title: 'Edit photo ' + (photo.number || ''),
          body: body,
          buttons: footButtons,
          onClose: function () { finish(null); },
        });

        paint();
      }
    });
  }

  global.Editor = {
    open: open,
    renderFrame: renderFrame,
    DEFAULTS: DEFAULTS,
    BACKGROUNDS: BACKGROUNDS,
    RATIO: RATIO,
  };
})(typeof window !== 'undefined' ? window : globalThis);
