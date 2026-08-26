/* ==========================================================================
 * crop.js — 35:45 passport crop (standalone module, no external deps).
 *
 *   const result = await Crop.open(imageLike, { title });
 *   // null                                          -> user cancelled
 *   // { canvas, dataUrl, width, height, source }    -> cropped, high-res
 *
 * The crop happens BEFORE any background removal: nothing leaves this module
 * until the user presses "Crop & Continue".
 * ========================================================================== */
(function (global) {
  'use strict';

  var RATIO = 35 / 45;          // width / height  (35:45 == 7:9 ≈ 0.7778)
  var MAX_OUTPUT_WIDTH = 2000;  // high-resolution output cap (px)
  var MIN_OUTPUT_WIDTH = 500;
  var ZOOM_MAX_FACTOR = 4;      // max zoom, relative to "fit"
  var STAGE_PAD = 18;

  /* ------------------------------------------------------------- utilities */

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not decode that image.')); };
      if (typeof src === 'string' && src.indexOf('data:') !== 0 && src.indexOf('blob:') !== 0) {
        img.crossOrigin = 'anonymous';
      }
      img.src = src;
    });
  }

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

  /** Largest 35:45 rect that fits inside the stage. */
  function cropRectFor(stageW, stageH) {
    var availW = Math.max(10, stageW - STAGE_PAD * 2);
    var availH = Math.max(10, stageH - STAGE_PAD * 2);
    var w = availW;
    var h = w / RATIO;
    if (h > availH) { h = availH; w = h * RATIO; }
    return { w: w, h: h, x: (stageW - w) / 2, y: (stageH - h) / 2 };
  }

  /** Host modal if available, otherwise a self-contained one. */
  function fallbackModal() {
    var root = el('div', 'modal');
    var back = el('div', 'modal-backdrop');
    var card = el('div', 'modal-card');
    var head = el('div', 'modal-head');
    var title = el('h2', null, '');
    var close = el('button', 'icon-btn', '\u00d7');
    var body = el('div', 'modal-body');
    var foot = el('div', 'modal-foot');
    head.appendChild(title); head.appendChild(close);
    card.appendChild(head); card.appendChild(body); card.appendChild(foot);
    root.appendChild(back); root.appendChild(card);
    document.body.appendChild(root);
    var onClose = null;
    close.addEventListener('click', function () { if (onClose) onClose(); });
    back.addEventListener('click', function () { if (onClose) onClose(); });
    return {
      open: function (o) {
        title.textContent = o.title || '';
        body.innerHTML = ''; foot.innerHTML = '';
        body.appendChild(o.body);
        (o.buttons || []).forEach(function (b) { foot.appendChild(b); });
        onClose = o.onClose || null;
        root.hidden = false;
      },
      close: function () { root.hidden = true; root.remove(); },
      setTitle: function (t) { title.textContent = t; },
    };
  }

  function getModal() {
    var m = global.App && global.App.Modal;
    return m && typeof m.open === 'function' ? m : fallbackModal();
  }

  /* --------------------------------------------------------- cropper core */

  function createCropper(image) {
    var state = {
      rotation: 0,   // 0 | 90 | 180 | 270 clockwise
      scale: 1,      // zoom (px per source px)
      offsetX: 0,    // pan in rotated-image pixels
      offsetY: 0,
    };

    var natW = image.naturalWidth || image.width;
    var natH = image.naturalHeight || image.height;

    function rotDims() {
      return state.rotation % 180 === 0 ? { w: natW, h: natH } : { w: natH, h: natW };
    }

    /** Zoom at which the rotated image exactly covers the crop box. */
    function fitScale(view) {
      var d = rotDims();
      return Math.max(view.cropW / d.w, view.cropH / d.h);
    }

    /** Resolve + clamp the geometry for the current view. */
    function viewGeom(view) {
      var crop = cropRectFor(view.stageW, view.stageH);
      var fit = fitScale(view);
      var maxScale = fit * ZOOM_MAX_FACTOR;
      var scale = clamp(state.scale, fit, maxScale);
      state.scale = scale;

      var d = rotDims();
      var iw = d.w * scale;
      var ih = d.h * scale;

      var centerX = view.stageW / 2 + state.offsetX * scale;
      var centerY = view.stageH / 2 + state.offsetY * scale;

      // Never let the crop window fall outside the image.
      centerX = clamp(centerX, crop.x + crop.w / 2 - iw / 2, crop.x + crop.w / 2 + iw / 2);
      centerY = clamp(centerY, crop.y + crop.h / 2 - ih / 2, crop.y + crop.h / 2 + ih / 2);

      state.offsetX = (centerX - view.stageW / 2) / scale;
      state.offsetY = (centerY - view.stageH / 2) / scale;

      return { crop: crop, fit: fit, maxScale: maxScale, scale: scale, centerX: centerX, centerY: centerY, dims: d };
    }

    /** Area of the ORIGINAL image currently visible in the crop window. */
    function sourceRect(g) {
      var w = g.crop.w / g.scale;
      var h = g.crop.h / g.scale;
      var x = clamp(g.dims.w / 2 - state.offsetX - w / 2, 0, Math.max(0, g.dims.w - w));
      var y = clamp(g.dims.h / 2 - state.offsetY - h / 2, 0, Math.max(0, g.dims.h - h));
      return { x: x, y: y, w: w, h: h };
    }

    function draw(ctx, view, dpr) {
      var g = viewGeom(view);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, view.stageW, view.stageH);
      ctx.fillStyle = '#10151f';
      ctx.fillRect(0, 0, view.stageW, view.stageH);

      ctx.save();
      ctx.translate(g.centerX, g.centerY);
      ctx.rotate((state.rotation * Math.PI) / 180);
      ctx.scale(g.scale, g.scale);
      ctx.translate(-g.dims.w / 2, -g.dims.h / 2);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0);
      ctx.restore();

      // Dim everything outside the crop window.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = 'rgba(9, 13, 22, .62)';
      ctx.beginPath();
      ctx.rect(0, 0, view.stageW, view.stageH);
      ctx.rect(g.crop.x, g.crop.y, g.crop.w, g.crop.h);
      ctx.fill('evenodd');

      // Frame.
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.lineWidth = 2;
      ctx.strokeRect(g.crop.x, g.crop.y, g.crop.w, g.crop.h);

      // Thirds guides.
      ctx.strokeStyle = 'rgba(255,255,255,.32)';
      ctx.lineWidth = 1;
      for (var i = 1; i <= 2; i++) {
        var vx = g.crop.x + (g.crop.w * i) / 3;
        var hy = g.crop.y + (g.crop.h * i) / 3;
        ctx.beginPath(); ctx.moveTo(vx, g.crop.y); ctx.lineTo(vx, g.crop.y + g.crop.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(g.crop.x, hy); ctx.lineTo(g.crop.x + g.crop.w, hy); ctx.stroke();
      }

      // Corner ticks.
      ctx.strokeStyle = '#4d84ff';
      ctx.lineWidth = 3;
      var t = Math.min(22, g.crop.w * 0.18);
      [[g.crop.x, g.crop.y, 1, 1],
       [g.crop.x + g.crop.w, g.crop.y, -1, 1],
       [g.crop.x, g.crop.y + g.crop.h, 1, -1],
       [g.crop.x + g.crop.w, g.crop.y + g.crop.h, -1, -1]].forEach(function (c) {
        ctx.beginPath();
        ctx.moveTo(c[0] + t * c[2], c[1]);
        ctx.lineTo(c[0], c[1]);
        ctx.lineTo(c[0], c[1] + t * c[3]);
        ctx.stroke();
      });

      return g;
    }

    /** Export the crop at high resolution (exact 35:45, never distorted). */
    function renderOutput(view) {
      var g = viewGeom(view);
      var src = sourceRect(g);

      var outW = clamp(Math.round(src.w), MIN_OUTPUT_WIDTH, MAX_OUTPUT_WIDTH);
      var outH = Math.round(outW / RATIO);

      var canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      var k = outW / src.w;
      ctx.translate(outW / 2, outH / 2);
      ctx.rotate((state.rotation * Math.PI) / 180);
      ctx.scale(k, k);
      ctx.translate(-g.dims.w / 2 - state.offsetX, -g.dims.h / 2 - state.offsetY);
      ctx.drawImage(image, 0, 0);

      return { canvas: canvas, source: src };
    }

    return {
      state: state,
      natural: { w: natW, h: natH },
      rotDims: rotDims,
      viewGeom: viewGeom,
      sourceRect: sourceRect,
      draw: draw,
      renderOutput: renderOutput,
      reset: function (view) {
        state.rotation = 0;
        state.offsetX = 0;
        state.offsetY = 0;
        state.scale = viewGeom(view).fit;
      },
      rotate: function (view, delta) {
        state.rotation = (state.rotation + delta + 360) % 360;
        state.offsetX = 0;
        state.offsetY = 0;
        state.scale = viewGeom(view).fit;
      },
      RATIO: RATIO,
    };
  }

  /* ------------------------------------------------------------ public API */

  function open(source, options) {
    options = options || {};

    return new Promise(function (resolve) {
      var modal = getModal();
      var settled = false;
      var raf = 0;
      var ro = null;
      var onResize = null;

      function cleanup() {
        if (raf) { global.cancelAnimationFrame(raf); raf = 0; }
        if (ro) { ro.disconnect(); ro = null; }
        if (onResize) { global.removeEventListener('resize', onResize); onResize = null; }
      }

      function finish(value) {
        if (settled) return;
        settled = true;
        cleanup();
        modal.close();
        resolve(value);
      }

      Promise.resolve()
        .then(function () {
          if (typeof source === 'string' || (source && typeof source.then === 'function')) return loadImage(source);
          return source;
        })
        .then(function (img) {
          if (!img || !(img.naturalWidth || img.width)) throw new Error('Empty image.');
          build(img);
        })
        .catch(function (err) {
          if (global.App && global.App.toast) {
            global.App.toast((err && err.message) || 'Could not open the cropper.', 'error');
          }
          finish(null);
        });

      function build(img) {
        var cropper = createCropper(img);

        /* ---- markup ---- */
        var body = el('div');
        var stage = el('div', 'crop-stage');
        var canvas = document.createElement('canvas');
        stage.appendChild(canvas);
        body.appendChild(stage);

        var zoomRange = document.createElement('input');
        zoomRange.type = 'range';
        zoomRange.min = '100';
        zoomRange.max = String(ZOOM_MAX_FACTOR * 100);
        zoomRange.step = '1';
        zoomRange.value = '100';
        var zoomOut = document.createElement('output');
        zoomOut.textContent = '100%';

        var zoomMinus = button('\u2212', 'btn-sm');
        zoomMinus.setAttribute('aria-label', 'Zoom out');
        var zoomPlus = button('+', 'btn-sm');
        zoomPlus.setAttribute('aria-label', 'Zoom in');

        var zoomWrap = el('div', 'slider');
        zoomWrap.appendChild(el('span', null, 'Zoom'));
        zoomWrap.appendChild(zoomMinus);
        zoomWrap.appendChild(zoomRange);
        zoomWrap.appendChild(zoomPlus);
        zoomWrap.appendChild(zoomOut);

        var rotLeft = button('\u21ba 90\u00b0', 'btn-sm');
        var rotRight = button('\u21bb 90\u00b0', 'btn-sm');
        var resetBtn = button('Reset', 'btn-sm');

        var controls = el('div', 'crop-controls');
        controls.appendChild(zoomWrap);
        controls.appendChild(rotLeft);
        controls.appendChild(rotRight);
        controls.appendChild(resetBtn);
        body.appendChild(controls);

        var meta = el('div', 'crop-meta');
        var metaRatio = el('span', null, 'Ratio 35:45 (passport)');
        var metaZoom = el('span', null, 'Zoom 100%');
        var metaOut = el('span', null, '');
        meta.appendChild(metaRatio); meta.appendChild(metaZoom); meta.appendChild(metaOut);
        body.appendChild(meta);

        /* ---- render loop ---- */
        var ctx = canvas.getContext('2d');
        var view = { stageW: 300, stageH: 300, cropW: 200, cropH: 257 };
        var dpr = 1;
        var needsRedraw = true;

        function measure() {
          var r = stage.getBoundingClientRect();
          dpr = Math.min(global.devicePixelRatio || 1, 2);
          view.stageW = Math.max(80, r.width);
          view.stageH = Math.max(80, r.height);
          canvas.width = Math.round(view.stageW * dpr);
          canvas.height = Math.round(view.stageH * dpr);
          var c = cropRectFor(view.stageW, view.stageH);
          view.cropW = c.w;
          view.cropH = c.h;
          needsRedraw = true;
        }

        function render() {
          var g = cropper.draw(ctx, view, dpr);
          var pct = Math.round((g.scale / g.fit) * 100);
          zoomRange.value = String(pct);
          zoomOut.textContent = pct + '%';
          metaZoom.textContent = 'Zoom ' + pct + '%';
          var src = cropper.sourceRect(g);
          var w = clamp(Math.round(src.w), MIN_OUTPUT_WIDTH, MAX_OUTPUT_WIDTH);
          metaOut.textContent = 'Output \u2248 ' + w + ' \u00d7 ' + Math.round(w / RATIO) + ' px';
          needsRedraw = false;
        }

        function loop() {
          if (needsRedraw) render();
          raf = global.requestAnimationFrame(loop);
        }

        measure();
        cropper.state.scale = cropper.viewGeom(view).fit; // start at "fit"
        render();

        /* ---- interactions ---- */
        var drag = null;

        canvas.addEventListener('pointerdown', function (e) {
          try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
          drag = { x: e.clientX, y: e.clientY, ox: cropper.state.offsetX, oy: cropper.state.offsetY };
          canvas.classList.add('is-dragging');
          needsRedraw = true;
        });

        canvas.addEventListener('pointermove', function (e) {
          if (!drag) return;
          var scale = cropper.viewGeom(view).scale;
          cropper.state.offsetX = drag.ox + (e.clientX - drag.x) / scale;
          cropper.state.offsetY = drag.oy + (e.clientY - drag.y) / scale;
          needsRedraw = true;
        });

        function endDrag(e) {
          if (!drag) return;
          drag = null;
          canvas.classList.remove('is-dragging');
          try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        }
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);

        canvas.addEventListener('wheel', function (e) {
          e.preventDefault();
          var g = cropper.viewGeom(view);
          cropper.state.scale = clamp(g.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08), g.fit, g.maxScale);
          needsRedraw = true;
        }, { passive: false });

        zoomRange.addEventListener('input', function () {
          var g = cropper.viewGeom(view);
          cropper.state.scale = g.fit * (Number(zoomRange.value) / 100);
          needsRedraw = true;
        });
        zoomPlus.addEventListener('click', function () {
          var g = cropper.viewGeom(view);
          cropper.state.scale = clamp(g.scale * 1.15, g.fit, g.maxScale);
          needsRedraw = true;
        });
        zoomMinus.addEventListener('click', function () {
          var g = cropper.viewGeom(view);
          cropper.state.scale = clamp(g.scale / 1.15, g.fit, g.maxScale);
          needsRedraw = true;
        });
        rotLeft.addEventListener('click', function () { cropper.rotate(view, -90); needsRedraw = true; });
        rotRight.addEventListener('click', function () { cropper.rotate(view, 90); needsRedraw = true; });
        resetBtn.addEventListener('click', function () { cropper.reset(view); needsRedraw = true; });

        onResize = measure;
        global.addEventListener('resize', onResize);
        if (typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(function () { measure(); });
          ro.observe(stage);
        }

        /* ---- buttons ---- */
        var cancelBtn = button('Cancel', '');
        cancelBtn.addEventListener('click', function () { finish(null); });

        var confirmBtn = button(options.confirmLabel || 'Crop & Continue', 'btn-primary');
        confirmBtn.addEventListener('click', function () {
          try {
            var out = cropper.renderOutput(view);
            finish({
              canvas: out.canvas,
              dataUrl: out.canvas.toDataURL('image/png'),
              width: out.canvas.width,
              height: out.canvas.height,
              source: out.source,
              rotation: cropper.state.rotation,
            });
          } catch (e) {
            if (global.App && global.App.toast) global.App.toast('Could not export the crop.', 'error');
            finish(null);
          }
        });

        modal.open({
          title: options.title || 'Crop photo \u2014 35 : 45',
          body: body,
          buttons: [cancelBtn, confirmBtn],
          onClose: function () { finish(null); },
        });

        raf = global.requestAnimationFrame(loop);
        global.setTimeout(function () { measure(); cropper.state.scale = cropper.viewGeom(view).fit; needsRedraw = true; }, 30);
      }
    });
  }

  global.Crop = {
    open: open,
    RATIO: RATIO,
    loadImage: loadImage,
    _internal: { createCropper: createCropper, cropRectFor: cropRectFor },
  };
})(typeof window !== 'undefined' ? window : globalThis);
