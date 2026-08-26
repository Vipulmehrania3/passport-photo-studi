/* ==========================================================================
 * app.js — application state + workflow.
 *
 *   Upload → Crop (per image) → ClearBackdrop (via our backend) → Library
 *          → Edit → Copies → A4 sheet → Print / Download
 *
 * Hard rule: if background removal fails, the ORIGINAL image is never added
 * to the library. The photo moves to "Needs attention" with Retry / Cancel.
 * ========================================================================== */
(function (global) {
  'use strict';

  var ACCEPTED = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp'];
  var ACCEPTED_EXT = ['jpg', 'jpeg', 'jpe', 'png', 'webp'];
  var MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // ClearBackdrop documented limit
  var MAX_COPIES = 99;

  /* ------------------------------------------------------------------ state */

  var state = {
    photos: [],
    failed: [],
    cropQueue: [],
    cropRunning: false,
    cropBatchTotal: 0,
    cropDone: 0,
    cropCancelled: false,
    removalCancelled: false,
    sheet: null,          // { layout, signature }
    fullSheets: null,     // cached full-dpi canvases
    fullSignature: null,
    dpi: 300,
    busy: false,
    seq: 0,
  };

  var dom = {};

  /* -------------------------------------------------------------- utilities */

  function $(id) { return document.getElementById(id); }

  function uid() {
    state.seq += 1;
    return 'p' + Date.now().toString(36) + state.seq;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function extOf(name) {
    var i = String(name || '').lastIndexOf('.');
    return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
  }

  function shortName(name) {
    var n = String(name || 'photo');
    return n.length > 16 ? n.slice(0, 9) + '\u2026' + n.slice(-6) : n;
  }

  function toast(message, type, ms) {
    var stack = dom.toastStack;
    if (!stack) return;
    var t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.textContent = message;
    stack.appendChild(t);
    global.setTimeout(function () {
      t.style.opacity = '0';
      global.setTimeout(function () { t.remove(); }, 200);
    }, ms || 4200);
  }

  /* ----------------------------------------------------------------- modal */

  var modal = {
    onClose: null,
    isOpen: false,

    open: function (opts) {
      dom.modalRoot.hidden = false;
      dom.modalRoot.setAttribute('aria-hidden', 'false');
      dom.modalTitle.textContent = opts.title || '';
      dom.modalBody.innerHTML = '';
      dom.modalFoot.innerHTML = '';
      dom.modalBody.appendChild(opts.body);
      (opts.buttons || []).forEach(function (b) { dom.modalFoot.appendChild(b); });
      dom.modalFoot.hidden = !(opts.buttons && opts.buttons.length);
      dom.modalCard.classList.toggle('modal-sm', !!opts.small);
      modal.onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
      modal.isOpen = true;
    },

    close: function () {
      if (!modal.isOpen) return;
      modal.isOpen = false;
      modal.onClose = null;
      dom.modalRoot.hidden = true;
      dom.modalRoot.setAttribute('aria-hidden', 'true');
      dom.modalBody.innerHTML = '';
      dom.modalFoot.innerHTML = '';
    },

    /** Close + run the registered onClose (used by X / backdrop). */
    dismiss: function () {
      var cb = modal.onClose;
      modal.close();
      if (cb) cb();
    },

    /** Small confirm-style dialog. Resolves with the chosen button id. */
    choose: function (opts) {
      return new Promise(function (resolve) {
        var body = document.createElement('div');
        if (opts.message) {
          var p = document.createElement('p');
          p.textContent = opts.message;
          body.appendChild(p);
        }
        if (opts.detail) {
          var d = document.createElement('p');
          d.className = 'hint';
          d.style.marginTop = '8px';
          d.textContent = opts.detail;
          body.appendChild(d);
        }
        var settled = false;
        var buttons = (opts.buttons || []).map(function (b) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn ' + (b.className || '');
          btn.textContent = b.label;
          btn.addEventListener('click', function () { done(b.id); });
          return btn;
        });
        function done(id) {
          if (settled) return;
          settled = true;
          modal.close();
          resolve(id);
        }
        modal.open({
          title: opts.title || '',
          body: body,
          buttons: buttons,
          small: true,
          onClose: function () { done(opts.cancelId || 'cancel'); },
        });
      });
    },
  };

  /* --------------------------------------------------------------- backend */

  async function refreshQuota() {
    var q = await API.quota();
    if (!q) return;
    var remaining = q.remaining !== undefined ? q.remaining : (q.headers && q.headers.remaining);
    var limit = q.limit_per_hour !== undefined ? q.limit_per_hour : (q.headers && q.headers.limit_per_hour);
    if (remaining === null || remaining === undefined) return;
    dom.quotaText.textContent = 'Quota: ' + remaining + (limit ? '/' + limit : '') + ' this hour';
    dom.quotaDot.className = 'quota-dot ' + (remaining > 40 ? 'ok' : remaining > 10 ? 'warn' : 'bad');
  }

  function applyQuota(quota) {
    if (!quota || quota.remaining === null || quota.remaining === undefined) return;
    dom.quotaText.textContent = 'Quota: ' + quota.remaining + (quota.limit_per_hour ? '/' + quota.limit_per_hour : '') + ' this hour';
    dom.quotaDot.className = 'quota-dot ' + (quota.remaining > 40 ? 'ok' : quota.remaining > 10 ? 'warn' : 'bad');
  }

  async function checkBackend() {
    try {
      var health = await API.health();
      var cb = health && health.clearbackdrop;
      dom.quotaDot.className = 'quota-dot ok';
      dom.quotaText.textContent = cb && cb.mode === 'mock'
        ? 'Backend: mock mode'
        : 'Backend: connected';
      if (cb && cb.mode !== 'mock') refreshQuota();
      return true;
    } catch (e) {
      dom.quotaDot.className = 'quota-dot bad';
      dom.quotaText.textContent = 'Backend offline';
      toast(e.message || 'Cannot reach the backend.', 'error', 8000);
      return false;
    }
  }

  /* ------------------------------------------------------------- file input */

  function validateFile(file) {
    var type = (file.type || '').toLowerCase();
    var ext = extOf(file.name);
    if (ACCEPTED.indexOf(type) === -1 && ACCEPTED_EXT.indexOf(ext) === -1) {
      return 'Unsupported type. Use JPG, JPEG, PNG or WEBP.';
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return 'File is larger than 15MB.';
    }
    if (!file.size) return 'File is empty.';
    return null;
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    var accepted = [];
    var rejected = 0;
    files.forEach(function (file) {
      var err = validateFile(file);
      if (err) { rejected += 1; toast(file.name + ': ' + err, 'error'); return; }
      accepted.push(file);
    });

    if (!accepted.length) return;
    if (rejected) toast(rejected + ' file(s) skipped.', 'warn');

    accepted.forEach(function (file) {
      var photo = {
        id: uid(),
        name: file.name,
        status: 'pending',
        sourceUrl: URL.createObjectURL(file),
        crop: null,
        cutout: null,
        settings: Object.assign({}, global.Editor.DEFAULTS),
        selected: true,
        copies: 1,
        number: 0,
        error: null,
      };
      state.photos.push(photo);
      state.cropQueue.push(photo.id);
    });

    state.cropCancelled = false;
    runCropQueue();
  }

  /* ------------------------------------------------------------ crop stage */

  function setBatchProgress(label, stage, ratio) {
    dom.batchPanel.hidden = false;
    dom.batchLabel.textContent = label;
    dom.batchStage.textContent = stage || '';
    dom.batchBar.style.width = Math.round(clamp(ratio, 0, 1) * 100) + '%';
  }

  async function runCropQueue() {
    if (state.cropRunning) return;
    state.cropRunning = true;
    state.cropBatchTotal = state.cropQueue.length;
    state.cropDone = 0;

    var toProcess = [];

    while (state.cropQueue.length) {
      if (state.cropCancelled) {
        // Drop the rest of the crop queue but keep processing what was cropped.
        state.cropQueue.length = 0;
        toast('Remaining uploads cancelled.', 'warn');
        break;
      }
      var id = state.cropQueue[0];
      var photo = findPhoto(id);
      state.cropQueue.shift();
      if (!photo || photo.status !== 'pending') continue;

      state.cropDone += 1;
      setBatchProgress(
        'Processing ' + state.cropDone + ' of ' + state.cropBatchTotal,
        'Crop ' + shortName(photo.name) + ' — background removal runs after you confirm',
        (state.cropDone - 0.5) / state.cropBatchTotal
      );

      var result = await global.Crop.open(photo.sourceUrl, {
        title: 'Crop ' + state.cropDone + ' of ' + state.cropBatchTotal + ' — ' + photo.name,
      });

      if (result) {
        photo.crop = result.dataUrl;
        photo.status = 'cropped';
        toProcess.push(photo);
      } else {
        photo.status = 'cancelled';
      }
      renderLibrary();
    }

    state.cropRunning = false;

    if (toProcess.length) {
      await runRemoval(toProcess, state.cropBatchTotal, state.cropDone - toProcess.length);
    } else {
      dom.batchPanel.hidden = true;
    }
    renderAll();
  }

  /* ------------------------------------------- background removal (backend) */

  function sleep(ms) { return new Promise(function (r) { global.setTimeout(r, ms); }); }

  /**
   * Send cropped images to OUR backend one at a time.
   * Success  -> photo is added to the library as a transparent cutout.
   * Failure  -> photo goes to "Needs attention". The original image is NEVER
   *             used as a fallback.
   */
  async function runRemoval(photos, batchTotal, doneBase) {
    batchTotal = batchTotal || photos.length;
    doneBase = doneBase || 0;
    state.removalCancelled = false;
    state.busy = true;

    var queue = photos.slice();
    var ok = 0;
    var failed = 0;

    for (var i = 0; i < queue.length; i++) {
      var photo = queue[i];
      if (state.removalCancelled) {
        for (var k = i; k < queue.length; k++) queue[k].status = 'cancelled';
        toast('Background removal cancelled for the remaining images.', 'warn');
        break;
      }

      photo.status = 'processing';
      photo.error = null;
      renderLibrary();
      setBatchProgress(
        'Processing ' + (doneBase + i + 1) + ' of ' + batchTotal,
        'Removing background — ' + shortName(photo.name),
        (doneBase + i + 0.5) / batchTotal
      );

      try {
        var res = await API.removeBackground(photo.crop, { filename: baseName(photo.name) + '.png' });
        photo.cutout = res.image;
        photo.cutoutImg = null;
        photo.status = 'ready';
        photo.error = null;
        applyQuota(res.quota);
        ok += 1;
      } catch (err) {
        if (err && err.status === 429) {
          var waitSec = clamp(err.retryAfterSeconds || 60, 5, 120);
          toast('ClearBackdrop rate limit reached. Waiting ' + waitSec + 's…', 'warn', waitSec * 1000);
          setBatchProgress(
            'Processing ' + (doneBase + i + 1) + ' of ' + batchTotal,
            'Rate limited — waiting ' + waitSec + 's',
            (doneBase + i + 0.5) / batchTotal
          );
          await sleep(waitSec * 1000);
          queue.push(photo);       // retry this one at the end of the queue
          photo.status = 'cropped';
          continue;
        }

        failed += 1;
        photo.status = 'failed';
        photo.error = err;
        state.failed.push(photo);
        showFailureDialog(photo);
      }
      renderLibrary();
    }

    state.busy = false;
    dom.batchPanel.hidden = true;
    renderAll();

    if (ok) toast(ok + ' photo' + (ok > 1 ? 's' : '') + ' ready in the library.', 'ok');
    if (failed) {
      toast(failed + ' image' + (failed > 1 ? 's' : '') + ' failed background removal — see "Needs attention".', 'error', 7000);
    }
  }

  function baseName(name) {
    var n = String(name || 'photo');
    var i = n.lastIndexOf('.');
    return i > 0 ? n.slice(0, i) : n;
  }

  /**
   * Background removal failed.
   * Shows Retry / Cancel. NEVER falls back to the original-background image.
   */
  var activeFailureDialog = null;

  function showFailureDialog(photo) {
    // A newer failure replaces the dialog; disable the stale one's buttons.
    if (activeFailureDialog) activeFailureDialog.superseded = true;

    var dialog = { superseded: false };
    activeFailureDialog = dialog;

    var body = document.createElement('div');
    var msg = document.createElement('p');
    msg.textContent = 'Background removal failed';
    msg.style.fontWeight = '650';
    body.appendChild(msg);

    var detail = document.createElement('p');
    detail.className = 'hint';
    detail.style.marginTop = '6px';
    detail.textContent =
      shortName(photo.name) + ' — ' + (photo.error && photo.error.message ? photo.error.message : 'Unknown error');
    body.appendChild(detail);

    var note = document.createElement('p');
    note.className = 'hint';
    note.style.marginTop = '10px';
    note.textContent =
      'The original image is not added to the library. Retry, or cancel to drop this photo — ' +
      'you can also retry later from "Needs attention".';
    body.appendChild(note);

    var retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-primary';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', function () {
      if (dialog.superseded) return;
      modal.close();
      retryPhoto(photo);
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () {
      if (dialog.superseded) return;
      modal.close();
      dropFailed(photo);
    });

    modal.open({
      title: 'Background removal failed',
      body: body,
      buttons: [cancelBtn, retryBtn],
      small: true,
      onClose: function () {
        if (activeFailureDialog === dialog) activeFailureDialog = null;
        renderFailed(); // photo stays in "Needs attention"
      },
    });
  }

  function retryPhoto(photo) {
    if (!photo.crop) {
      toast('This photo has no crop yet — upload it again.', 'error');
      return;
    }
    state.failed = state.failed.filter(function (p) { return p.id !== photo.id; });
    photo.status = 'cropped';
    photo.error = null;
    renderFailed();
    runRemoval([photo], 1, 0);
  }

  function dropFailed(photo) {
    state.failed = state.failed.filter(function (p) { return p.id !== photo.id; });
    photo.status = 'cancelled';
    toast(shortName(photo.name) + ' was dropped (no original-background copy is kept).', 'warn');
    renderAll();
  }

  /* --------------------------------------------------------------- library */

  function findPhoto(id) {
    for (var i = 0; i < state.photos.length; i++) if (state.photos[i].id === id) return state.photos[i];
    return null;
  }

  function readyPhotos() {
    return state.photos.filter(function (p) { return p.status === 'ready' && p.cutout; });
  }

  function renumber() {
    readyPhotos().forEach(function (p, i) { p.number = i + 1; });
  }

  function statusText(p) {
    switch (p.status) {
      case 'pending': return 'Waiting for crop';
      case 'cropped': return 'Cropped — queued';
      case 'processing': return 'Removing background…';
      case 'failed': return 'Background removal failed';
      case 'cancelled': return 'Cancelled';
      default: return '';
    }
  }

  function renderLibrary() {
    renumber();
    var grid = dom.photoGrid;
    grid.innerHTML = '';
    var ready = readyPhotos();
    dom.libraryEmpty.hidden = ready.length > 0;

    ready.forEach(function (photo) {
      grid.appendChild(photoCard(photo));
    });

    renderFailed();
    updateSheetSummaryOnly();
  }

  function photoCard(photo) {
    var card = document.createElement('article');
    card.className = 'photo-card' + (photo.selected ? ' is-selected' : '') + (photo.copies === 0 ? ' is-excluded' : '');
    card.dataset.id = photo.id;

    /* header */
    var top = document.createElement('div');
    top.className = 'pc-top';
    var num = document.createElement('span');
    num.textContent = 'Photo ' + photo.number;
    var name = document.createElement('span');
    name.className = 'pc-name';
    name.title = photo.name;
    name.textContent = shortName(photo.name);
    top.appendChild(num);
    top.appendChild(name);
    card.appendChild(top);

    /* preview */
    var frame = document.createElement('div');
    frame.className = 'pc-frame';
    var img = document.createElement('img');
    img.src = photo.cutout;
    img.alt = 'Photo ' + photo.number + ' cutout';
    frame.appendChild(img);

    if (photo.status !== 'ready') {
      var overlay = document.createElement('div');
      overlay.className = 'pc-status';
      if (photo.status === 'processing') {
        var sp = document.createElement('span');
        sp.className = 'spinner';
        overlay.appendChild(sp);
      }
      var label = document.createElement('span');
      label.textContent = statusText(photo);
      overlay.appendChild(label);
      frame.appendChild(overlay);
    }
    card.appendChild(frame);

    /* body */
    var body = document.createElement('div');
    body.className = 'pc-body';

    var check = document.createElement('label');
    check.className = 'check';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!photo.selected;
    cb.addEventListener('change', function () {
      photo.selected = cb.checked;
      card.classList.toggle('is-selected', photo.selected);
      invalidateSheet();
      renderLibrary();
    });
    check.appendChild(cb);
    check.appendChild(document.createTextNode('Include'));
    body.appendChild(check);

    var copies = document.createElement('div');
    copies.className = 'copies';
    var copiesLabel = document.createElement('span');
    copiesLabel.className = 'copies-label';
    copiesLabel.textContent = 'Copies';

    var stepper = document.createElement('div');
    stepper.className = 'stepper';
    var minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '\u2212';
    minus.setAttribute('aria-label', 'Decrease copies');
    var input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(MAX_COPIES);
    input.value = String(photo.copies);
    input.setAttribute('aria-label', 'Copies');
    var plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Increase copies');

    function setCopies(value) {
      var n = clamp(Math.round(Number(value)), 0, MAX_COPIES);
      if (isNaN(n)) n = 0;
      photo.copies = n;
      input.value = String(n);
      minus.disabled = n <= 0;
      plus.disabled = n >= MAX_COPIES;
      card.classList.toggle('is-excluded', n === 0);
      invalidateSheet();
      updateSheetSummaryOnly();
    }
    minus.disabled = photo.copies <= 0;
    plus.disabled = photo.copies >= MAX_COPIES;
    minus.addEventListener('click', function () { setCopies(photo.copies - 1); });
    plus.addEventListener('click', function () { setCopies(photo.copies + 1); });
    input.addEventListener('change', function () { setCopies(input.value); });

    stepper.appendChild(minus);
    stepper.appendChild(input);
    stepper.appendChild(plus);
    copies.appendChild(copiesLabel);
    copies.appendChild(stepper);
    body.appendChild(copies);

    /* actions */
    var actions = document.createElement('div');
    actions.className = 'pc-actions';
    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () { openEditor(photo); });

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-sm';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', function () { deletePhoto(photo); });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    body.appendChild(actions);

    card.appendChild(body);
    return card;
  }

  function renderFailed() {
    var list = dom.failedList;
    list.innerHTML = '';
    dom.failedPanel.hidden = state.failed.length === 0;

    state.failed.forEach(function (photo) {
      var row = document.createElement('div');
      row.className = 'failed-item';

      var info = document.createElement('div');
      var n = document.createElement('div');
      n.className = 'fi-name';
      n.textContent = photo.name;
      var m = document.createElement('div');
      m.className = 'fi-msg';
      m.textContent = photo.error && photo.error.message ? photo.error.message : 'Background removal failed';
      info.appendChild(n);
      info.appendChild(m);

      var acts = document.createElement('div');
      acts.className = 'fi-actions';
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-sm btn-primary';
      retry.textContent = 'Retry';
      retry.addEventListener('click', function () { retryPhoto(photo); });
      var drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'btn btn-sm';
      drop.textContent = 'Cancel';
      drop.addEventListener('click', function () { dropFailed(photo); });
      acts.appendChild(retry);
      acts.appendChild(drop);

      row.appendChild(info);
      row.appendChild(acts);
      list.appendChild(row);
    });
  }

  async function deletePhoto(photo) {
    var choice = await modal.choose({
      title: 'Delete photo ' + photo.number,
      message: 'Remove this photo from the library?',
      buttons: [
        { id: 'cancel', label: 'Keep it' },
        { id: 'delete', label: 'Delete', className: 'btn-danger' },
      ],
      cancelId: 'cancel',
    });
    if (choice !== 'delete') return;

    if (photo.sourceUrl && photo.sourceUrl.indexOf('blob:') === 0) URL.revokeObjectURL(photo.sourceUrl);
    state.photos = state.photos.filter(function (p) { return p.id !== photo.id; });
    state.failed = state.failed.filter(function (p) { return p.id !== photo.id; });
    invalidateSheet();
    renderAll();
    toast('Photo deleted.', 'ok');
  }

  /* ---------------------------------------------------------------- editor */

  async function openEditor(photo) {
    var result = await global.Editor.open(photo);
    if (!result) return;

    photo.settings = result.settings;

    if (result.recrop) {
      // The crop changed, so the old cutout no longer matches: it must go
      // through background removal again.
      photo.crop = result.recrop;
      photo.pendingRecrop = null;
      photo.status = 'cropped';
      toast('Re-cropped — sending to ClearBackdrop again.', 'warn');
      renderLibrary();
      await runRemoval([photo], 1, 0);
      return;
    }

    invalidateSheet();
    renderAll();
    toast('Edits applied to photo ' + photo.number + '.', 'ok');
  }

  /* ------------------------------------------------------------ A4 preview */

  function sheetItems() {
    return readyPhotos()
      .filter(function (p) { return p.selected && p.copies > 0; })
      .map(function (p) {
        return {
          id: p.id,
          label: 'Photo ' + p.number,
          copies: p.copies,
          cutout: p.cutout,
          settings: p.settings,
        };
      });
  }

  function signature(items) {
    return items.map(function (i) {
      return i.id + ':' + i.copies + ':' + JSON.stringify(i.settings);
    }).join('|') + '#dpi' + state.dpi;
  }

  function invalidateSheet() {
    state.sheet = null;
    state.fullSheets = null;
    state.fullSignature = null;
  }

  function updateSheetSummaryOnly() {
    var items = sheetItems();
    var copies = items.reduce(function (a, b) { return a + b.copies; }, 0);
    if (!items.length) {
      dom.sheetSummary.textContent = 'Select photos and set copies to build a sheet.';
    } else {
      dom.sheetSummary.innerHTML = '';
      var strong = document.createElement('strong');
      strong.textContent = items.length + ' photo' + (items.length > 1 ? 's' : '') + ' \u00b7 ' + copies + ' cop' + (copies === 1 ? 'y' : 'ies');
      dom.sheetSummary.appendChild(strong);
      var rest = document.createTextNode(' \u00b7 35\u00d745 mm on 210\u00d7297 mm \u00b7 ' + state.dpi + ' DPI export');
      dom.sheetSummary.appendChild(rest);
    }
  }

  async function getCutoutImage(item) {
    if (!item._img) item._img = await global.Crop.loadImage(item.cutout);
    return item._img;
  }

  async function generateSheet() {
    var items = sheetItems();
    dom.sheetPages.innerHTML = '';

    if (!items.length) {
      dom.sheetPreviewEmpty.hidden = false;
      invalidateSheet();
      setSheetButtons(false);
      return null;
    }

    for (var i = 0; i < items.length; i++) await getCutoutImage(items[i]);

    var layout = global.A4.layout(items.map(function (it) {
      return { id: it.id, label: it.label, copies: it.copies, img: it._img, settings: it.settings };
    }), {});

    var previews = global.A4.renderSheets(layout, global.A4.PREVIEW_DPI);

    dom.sheetPreviewEmpty.hidden = true;
    previews.forEach(function (canvas, idx) {
      var fig = document.createElement('figure');
      fig.className = 'sheet-page';
      fig.style.margin = '0';
      var img = document.createElement('img');
      img.src = canvas.toDataURL('image/png');
      img.alt = 'A4 preview page ' + (idx + 1);
      var cap = document.createElement('figcaption');
      cap.textContent = 'Page ' + (idx + 1) + ' of ' + previews.length + ' \u00b7 ' + layout.pages[idx].count + ' photos \u00b7 ' +
        layout.pages[idx].grid.cols + '\u00d7' + layout.pages[idx].grid.rows + ' grid';
      fig.appendChild(img);
      fig.appendChild(cap);
      dom.sheetPages.appendChild(fig);
    });

    state.sheet = { layout: layout, signature: signature(items), items: items };
    state.fullSheets = null;
    state.fullSignature = null;
    setSheetButtons(true);
    updateSheetSummaryOnly();
    return layout;
  }

  function setSheetButtons(enabled) {
    dom.printBtn.disabled = !enabled;
    dom.downloadPdfBtn.disabled = !enabled;
    dom.downloadPngBtn.disabled = !enabled;
  }

  /** Full-resolution sheets, cached until something changes. */
  async function fullSheets() {
    if (!state.sheet) await generateSheet();
    if (!state.sheet) throw new Error('Nothing to export yet.');

    var sig = state.sheet.signature;
    if (state.fullSheets && state.fullSignature === sig) return state.fullSheets;

    // The stored layout already carries the decoded images and exact geometry
    // used for the preview, so the export matches the preview pixel-for-pixel
    // (only the resolution differs).
    var canvases = global.A4.renderSheets(state.sheet.layout, state.dpi);
    state.fullSheets = canvases;
    state.fullSignature = sig;
    return canvases;
  }

  function withBusy(button, label, fn) {
    return async function () {
      if (button.dataset.busy === '1') return;
      var original = button.textContent;
      button.dataset.busy = '1';
      button.disabled = true;
      button.innerHTML = '';
      var sp = document.createElement('span');
      sp.className = 'spinner';
      button.appendChild(sp);
      button.appendChild(document.createTextNode(label));
      try {
        await fn();
      } catch (e) {
        toast((e && e.message) || 'Something went wrong.', 'error');
      } finally {
        button.dataset.busy = '0';
        button.disabled = false;
        button.textContent = original;
      }
    };
  }

  /* ----------------------------------------------------------------- demo */

  function makeSamplePortrait(seed) {
    var c = document.createElement('canvas');
    c.width = 700;
    c.height = 900;
    var ctx = c.getContext('2d');

    var bgColors = [
      ['#7fa8d8', '#3f6ba3'],
      ['#b6c9a8', '#5f7d4f'],
      ['#d9b38c', '#9a6a3f'],
    ];
    var pair = bgColors[seed % bgColors.length];
    var g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, pair[0]);
    g.addColorStop(1, pair[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);

    // Shoulders.
    ctx.fillStyle = '#2b3446';
    ctx.beginPath();
    ctx.ellipse(c.width / 2, c.height * 1.02, 300, 240, 0, Math.PI, 0);
    ctx.fill();

    // Neck.
    ctx.fillStyle = '#e0b48f';
    ctx.fillRect(c.width / 2 - 55, 520, 110, 150);

    // Head.
    ctx.fillStyle = '#f0c8a4';
    ctx.beginPath();
    ctx.ellipse(c.width / 2, 400, 165, 210, 0, 0, Math.PI * 2);
    ctx.fill();

    // Hair.
    ctx.fillStyle = '#2a2118';
    ctx.beginPath();
    ctx.ellipse(c.width / 2, 300, 172, 140, 0, Math.PI, 0);
    ctx.fill();

    // Eyes + mouth.
    ctx.fillStyle = '#22303f';
    ctx.beginPath(); ctx.ellipse(c.width / 2 - 60, 400, 15, 10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(c.width / 2 + 60, 400, 15, 10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#9a5b4a';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(c.width / 2, 470, 42, 0.25 * Math.PI, 0.75 * Math.PI);
    ctx.stroke();

    return c.toDataURL('image/jpeg', 0.92);
  }

  function loadSamples() {
    var made = [];
    for (var i = 0; i < 3; i++) {
      state.photos.push({
        id: uid(),
        name: 'sample-' + (i + 1) + '.jpg',
        status: 'pending',
        sourceUrl: makeSamplePortrait(i),
        crop: null,
        cutout: null,
        settings: Object.assign({}, global.Editor.DEFAULTS),
        selected: true,
        copies: 1,
        number: 0,
        error: null,
      });
      made.push(state.photos[state.photos.length - 1].id);
    }
    made.forEach(function (id) { state.cropQueue.push(id); });
    state.cropCancelled = false;
    runCropQueue();
  }

  /* ------------------------------------------------------------ clear all */

  async function clearAll() {
    if (!state.photos.length && !state.failed.length) return;
    var choice = await modal.choose({
      title: 'Clear everything?',
      message: 'This removes all photos, crops and the current A4 sheet.',
      buttons: [
        { id: 'cancel', label: 'Keep them' },
        { id: 'clear', label: 'Clear all', className: 'btn-danger' },
      ],
      cancelId: 'cancel',
    });
    if (choice !== 'clear') return;

    state.photos.forEach(function (p) {
      if (p.sourceUrl && p.sourceUrl.indexOf('blob:') === 0) URL.revokeObjectURL(p.sourceUrl);
    });
    state.photos = [];
    state.failed = [];
    state.cropQueue = [];
    state.cropCancelled = true;
    state.removalCancelled = true;
    invalidateSheet();
    dom.sheetPages.innerHTML = '';
    dom.sheetPreviewEmpty.hidden = false;
    setSheetButtons(false);
    renderAll();
  }

  /* ---------------------------------------------------------------- render */

  function renderAll() {
    renderLibrary();
  }

  /* ------------------------------------------------------------------ init */

  function wire() {
    dom.dropzone.addEventListener('click', function () { dom.fileInput.click(); });
    dom.dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.fileInput.click(); }
    });
    dom.fileInput.addEventListener('change', function () {
      handleFiles(dom.fileInput.files);
      dom.fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
      dom.dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        dom.dropzone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dom.dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        dom.dropzone.classList.remove('is-dragover');
      });
    });
    dom.dropzone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });
    // Never let the browser navigate away when a file misses the dropzone.
    ['dragover', 'drop'].forEach(function (evt) {
      global.addEventListener(evt, function (e) { e.preventDefault(); });
    });

    dom.batchCancelBtn.addEventListener('click', function () {
      state.cropCancelled = true;
      state.removalCancelled = true;
      toast('Cancelling after the current step…', 'warn');
    });

    dom.selectAllBtn.addEventListener('click', function () {
      readyPhotos().forEach(function (p) { p.selected = true; });
      invalidateSheet();
      renderLibrary();
    });
    dom.clearSelBtn.addEventListener('click', function () {
      readyPhotos().forEach(function (p) { p.selected = false; });
      invalidateSheet();
      renderLibrary();
    });

    dom.dpiSelect.addEventListener('change', function () {
      state.dpi = Number(dom.dpiSelect.value) || 300;
      var hadSheet = !!state.sheet || dom.sheetPages.children.length > 0;
      invalidateSheet();
      updateSheetSummaryOnly();
      if (hadSheet) generateSheet();
    });

    dom.regenerateBtn.addEventListener('click', function () { generateSheet(); });

    dom.printBtn.addEventListener('click', withBusy(dom.printBtn, 'Preparing', async function () {
      var canvases = await fullSheets();
      await global.A4.print(canvases, dom.printArea);
    }));

    dom.downloadPdfBtn.addEventListener('click', withBusy(dom.downloadPdfBtn, 'Building PDF', async function () {
      var canvases = await fullSheets();
      try {
        await global.A4.downloadPdf(canvases);
        toast('PDF downloaded (' + canvases.length + ' page' + (canvases.length > 1 ? 's' : '') + ').', 'ok');
      } catch (e) {
        if (e && e.code === 'pdf_unavailable') {
          await global.A4.downloadPng(canvases);
          toast(e.message, 'warn', 7000);
        } else {
          throw e;
        }
      }
    }));

    dom.downloadPngBtn.addEventListener('click', withBusy(dom.downloadPngBtn, 'Rendering', async function () {
      var canvases = await fullSheets();
      await global.A4.downloadPng(canvases);
      toast('PNG downloaded (' + canvases.length + ' file' + (canvases.length > 1 ? 's' : '') + ').', 'ok');
    }));

    dom.loadSamplesBtn.addEventListener('click', loadSamples);
    dom.clearAllBtn.addEventListener('click', clearAll);

    dom.modalCloseBtn.addEventListener('click', function () { modal.dismiss(); });
    dom.modalRoot.querySelector('.modal-backdrop').addEventListener('click', function () { modal.dismiss(); });
    global.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.isOpen) modal.dismiss();
    });
  }

  function init() {
    dom = {
      dropzone: $('dropzone'),
      fileInput: $('fileInput'),
      batchPanel: $('batchPanel'),
      batchLabel: $('batchLabel'),
      batchStage: $('batchStage'),
      batchBar: $('batchBar'),
      batchCancelBtn: $('batchCancelBtn'),
      photoGrid: $('photoGrid'),
      libraryEmpty: $('libraryEmpty'),
      failedPanel: $('failedPanel'),
      failedList: $('failedList'),
      selectAllBtn: $('selectAllBtn'),
      clearSelBtn: $('clearSelBtn'),
      sheetSummary: $('sheetSummary'),
      sheetPages: $('sheetPages'),
      sheetPreviewEmpty: $('sheetPreviewEmpty'),
      regenerateBtn: $('regenerateBtn'),
      dpiSelect: $('dpiSelect'),
      printBtn: $('printBtn'),
      downloadPdfBtn: $('downloadPdfBtn'),
      downloadPngBtn: $('downloadPngBtn'),
      loadSamplesBtn: $('loadSamplesBtn'),
      clearAllBtn: $('clearAllBtn'),
      quotaText: $('quotaText'),
      quotaDot: $('quotaDot'),
      modalRoot: $('modalRoot'),
      modalCard: document.querySelector('.modal-card'),
      modalTitle: $('modalTitle'),
      modalBody: $('modalBody'),
      modalFoot: $('modalFoot'),
      modalCloseBtn: $('modalCloseBtn'),
      printArea: $('printArea'),
      toastStack: $('toastStack'),
    };

    wire();
    renderAll();
    setSheetButtons(false);
    checkBackend();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ---------------------------------------------------------- public surface */

  global.App = {
    Modal: modal,
    toast: toast,
    state: state,
    handleFiles: handleFiles,
    generateSheet: generateSheet,
    fullSheets: fullSheets,
    readyPhotos: readyPhotos,
    checkBackend: checkBackend,
  };
})(typeof window !== 'undefined' ? window : globalThis);
