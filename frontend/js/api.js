(function (global) {
  'use strict';

  var BACKEND_URL = 'https://passport-photo-studi.onrender.com';

  var resolvedBase = BACKEND_URL;
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
      } catch (__) {}
    }
    var code = (body && body.error) || 'http_' + res.status;
    var message = (body && body.message) || 'Backend returned error (' + res.status + ').';
    return ApiError(code, message, {
      status: res.status,
      details: body || null,
    });
  }

  async function health() {
    try {
      var res = await fetch(BACKEND_URL + '/api/health', { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('health ' + res.status);
      var data = await res.json();
      lastHealth = data;
      return data;
    } catch (e) {
      throw ApiError('backend_unreachable', 'Cannot reach backend at ' + BACKEND_URL, { cause: e.message });
    }
  }

  function base() { return BACKEND_URL; }

  function getMode() {
    return lastHealth && lastHealth.clearbackdrop && lastHealth.clearbackdrop.mode === 'mock' ? 'mock' : 'live';
  }

  async function toBlob(source) {
    if (source instanceof Blob) return source;
    if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
      return await new Promise(function (resolve, reject) {
        source.toBlob(function (b) {
          if (b) resolve(b); else reject(ApiError('encode_failed', 'Could not encode image.'));
        }, 'image/png');
      });
    }
    if (typeof source === 'string' && source.indexOf('data:') === 0) {
      var res = await fetch(source);
      return await res.blob();
    }
    throw ApiError('bad_source', 'Unsupported image source: ' + typeof source);
  }

  async function removeBackground(source, options) {
    options = options || {};
    var blob = await toBlob(source);
    var name = options.filename || 'crop.png';

    var form = new FormData();
    form.append('image', blob, name);
    if (options.simulate) form.append('simulate', options.simulate);

    var res;
    try {
      res = await fetch(BACKEND_URL + '/api/remove-background', { method: 'POST', body: form });
    } catch (e) {
      throw ApiError('network_error', 'Network failure while contacting backend: ' + e.message);
    }

    if (!res.ok) throw await parseError(res);

    var data = await res.json();
    if (!data || !data.image) {
      throw ApiError('invalid_response', 'Backend did not return a valid image.');
    }

    return {
      image: data.image,
      mime: data.mime || 'image/png',
      bytes: data.bytes || null,
      size: data.size || null,
      cached: !!data.cached,
      mock: !!data.mock,
      quota: data.quota || {},
      tookMs: data.took_ms || null,
    };
  }

  async function quota() {
    try {
      var res = await fetch(BACKEND_URL + '/api/quota', { cache: 'no-store' });
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