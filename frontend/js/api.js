/* ==========================================================================
 * api.js — frontend ⇄ OUR BACKEND only.
 *
 * The browser never talks to ClearBackdrop and never sees a credential.
 * Every background-removal request goes to our own Node server, which relays
 * it to ClearBackdrop and hands back the transparent PNG.
 *
 *   Browser  →  POST /api/remove-background  →  backend  →  ClearBackdrop
 * ========================================================================== */
(function (global) {
  'use strict';

  var CONFIG = global.APP_CONFIG || {};

  // Same-origin first; fall back to a local backend when the page is opened
  // from a different origin (Live Server, file://, static host, ...).
  function candidateBases() {
    var list = [];
    if (CONFIG.apiBase) list.push(String(CONFIG.apiBase).replace(/\/+$/, ''));

    var loc = global.location;
    if (loc && loc.protocol && loc.protocol.indexOf('http') === 0) {
      list.push(''); // same origin
      var host = loc.hostname;
      [8787, 3000].forEach(function (port) {
        var guess = loc.protocol + '//' + host + ':' + port;
        if (guess !== loc.origin) list.push(guess);
      });
    } else {
      // file:// — assume the backend runs locally.
      list.push('http://localhost:8787', 'http://127.0.0.1:8787');
    }

    // de-duplicate, keep order
    return list.filter(function (v, i) { return list.indexOf(v) === i; });
  }

  var resolvedBase = null;
  var lastHealth = null;

  function ApiError(code, message, details) {
    var e = new Error(message);
    e.name = 'ApiError';
    e.code = code || 'api_error';
    e.message = message;
    Object.assign(e, details || {});
    return e;
  }

  async function parseError(res) {
    var body = null;
    try {
      body = await res.json();
    } catch (_) {
      try {
        body = { message: (await res.text()).slice(0, 300) };
      } catch (__) { /* ignore */ }
    }
    var code = (body && body.error) || 'http_' + res.status;
    var message =
      (body && body.message) ||
      (res.status === 504 ? 'The request timed out.' : 'The backend returned an unexpected response (' + res.status + ').');
    return ApiError(code, message, {
      status: res.status,
      retryable: !!(body && body.retryable) || res.status === 429 || res.status >= 500,
      retryAfterSeconds: (body && body.retry_after_seconds) || null,
      upstreamError: (body && body.upstream_error) || null,
      details: body || null,
    });
  }

  /** Probe the backend so the UI can warn early instead of failing mid-batch. */
  async function health() {
    var bases = candidateBases();
    var lastErr = null;
    for (var i = 0; i < bases.length; i++) {
      try {
        var res = await fetch(bases[i] + '/api/health', { method: 'GET', cache: 'no-store' });
        if (!res.ok) throw new Error('health ' + res.status);
        var data = await res.json();
        resolvedBase = bases[i];
        lastHealth = data;
        return data;
      } catch (e) {
        lastErr = e;
      }
    }
    resolvedBase = null;
    throw ApiError('backend_unreachable',
      'Cannot reach the Passport Photo Studio backend. Start it with `npm start` in backend/ (tried: ' +
      (bases.join(', ') || 'none') + ').',
      { cause: lastErr && lastErr.message });
  }

  function base() { return resolvedBase === null ? candidateBases()[0] : resolvedBase; }

  function getMode() {
    var cb = lastHealth && lastHealth.clearbackdrop;
    return cb && cb.mode === 'mock' ? 'mock' : 'live';
  }

  /** Accepts a Blob | File | HTMLCanvasElement | dataURL string. */
  async function toBlob(source, fallbackName) {
    if (source instanceof Blob) return source;
    if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
      return await new Promise(function (resolve, reject) {
        source.toBlob(function (b) {
          if (b) resolve(b); else reject(ApiError('encode_failed', 'Could not encode the cropped image.'));
        }, 'image/png');
      });
    }
    if (typeof source === 'string' && source.indexOf('data:') === 0) {
      var res = await fetch(source);
      return await res.blob();
    }
    throw ApiError('bad_source', 'Unsupported image source: ' + typeof source);
  }

  /**
   * Remove the background of one (already cropped) image.
   * Resolves with { image, mime, size, cached, quota }.
   * Rejects with an ApiError — the caller decides Retry / Cancel.
   * There is deliberately NO fallback to the original image here.
   */
  async function removeBackground(source, options) {
    options = options || {};
    var blob = await toBlob(source, options.filename);
    var name = options.filename || 'crop.png';

    // The upstream limit is 15MB; a re-encoded crop should stay well under it,
    // but guard anyway so the user gets a clear message instead of a 413.
    var MAX = 15 * 1024 * 1024;
    if (blob.size > MAX) {
      throw ApiError('file_too_large',
        'The cropped image is ' + (blob.size / 1048576).toFixed(1) + 'MB. ClearBackdrop accepts up to 15MB.',
        { status: 413 });
    }

    var form = new FormData();
    form.append('image', blob, name);
    if (options.simulate) form.append('simulate', options.simulate);

    var res;
    try {
      res = await fetch(base() + '/api/remove-background', { method: 'POST', body: form });
    } catch (e) {
      throw ApiError('network_error',
        'Network failure while contacting the backend. Is `npm start` running in backend/?',
        { cause: e && e.message });
    }

    if (!res.ok) throw await parseError(res);

    var data;
    try {
      data = await res.json();
    } catch (_) {
      throw ApiError('invalid_response', 'The backend response was not valid JSON.', { status: res.status });
    }

    if (!data || !data.image || typeof data.image !== 'string' || data.image.indexOf('data:image/') !== 0) {
      throw ApiError('invalid_response', 'The backend did not return a processed image.', { details: data });
    }

    var quota = data.quota || {
      remaining: header(res, 'x-quota-remaining'),
      limit_per_hour: header(res, 'x-quota-limit'),
      reset_seconds: header(res, 'x-quota-reset'),
    };

    return {
      image: data.image,
      mime: data.mime || 'image/png',
      bytes: data.bytes || null,
      size: data.size || null,
      cached: !!data.cached,
      mock: !!data.mock,
      quota: quota,
      tookMs: data.took_ms || null,
    };
  }

  function header(res, name) {
    var v = res.headers.get(name);
    return v === null || v === undefined ? null : Number(v);
  }

  async function quota() {
    try {
      var res = await fetch(base() + '/api/quota', { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  global.API = {
    health: health,
    quota: quota,
    removeBackground: removeBackground,
    getBase: base,
    getMode: getMode,
    getHealth: function () { return lastHealth; },
    ApiError: ApiError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
