"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const _config = {
  baseURL: "http://127.0.0.1:8765",
  token: "",
  curlPath: null, // auto-detect
  syncMaxFileBytes: 64 * 1024 * 1024, // 64MB — openSync refuses larger, use async
  shouldRemote: null, // callback(path) => boolean; null = use built-in local path detection
  pathTransform: null, // callback(path) => string; transform path before sending to remote (e.g. strip prefix)
};

// Shared keepAlive agents — every async call reuses pooled sockets instead of
// opening a fresh TCP connection (and TLS handshake) per request. This is the
// single biggest async-throughput lever for chatty workloads (stat/readdir
// storms, fd read/write loops).
const _httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 1000 });
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 1000 });

function configure(opts) {
  Object.assign(_config, opts);
  // Initialize the worker-thread sync bridge (replaces curl for sync HTTP)
  if (opts.baseURL) {
    _syncBridge.init({ baseURL: opts.baseURL, token: opts.token, tls: opts.tls });
  }
}

// ─── Cache provider hook ─────────────────────────────────
// Downstream injects { get, set, invalidate } to cache GET responses at the
// transport level. Checked in _asyncRequest and getBufferSync — the two exit
// points for all HTTP traffic. Client calls the hooks; downstream owns the logic.
let _cacheProvider = null;

function setCacheProvider(provider) {
  _cacheProvider = provider;
}

// ─── Async HTTP ──────────────────────────────────────────
function _asyncRequest(method, path, { body, headers = {}, responseType = "buffer" } = {}) {
  // Cache provider: short-circuit GET if cached (including 404 negative cache)
  if (method === "GET" && _cacheProvider) {
    const cached = _cacheProvider.get(path);
    if (cached) {
      if (cached.statusCode >= 400) {
        const err = new Error(`HTTP ${cached.statusCode}: ${cached.body.toString("utf8")}`);
        err.statusCode = cached.statusCode;
        err.body = cached.body;
        return Promise.reject(err);
      }
      return Promise.resolve({ buffer: cached.body, statusCode: cached.statusCode, headers: {} });
    }
  }
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(path, _config.baseURL);
    const lib = fullUrl.protocol === "https:" ? https : http;

    const reqHeaders = { ...headers };
    if (_config.token) {
      reqHeaders["Authorization"] = "Bearer " + _config.token;
    }

    const opts = {
      method,
      hostname: fullUrl.hostname,
      port: fullUrl.port,
      path: fullUrl.pathname + fullUrl.search,
      headers: reqHeaders,
      agent: fullUrl.protocol === "https:" ? _httpsAgent : _httpAgent,
    };

    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (method === "GET" && _cacheProvider) {
          _cacheProvider.set(path, res.statusCode, buf);
        }
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode}: ${buf.toString("utf8")}`);
          err.statusCode = res.statusCode;
          err.body = buf;
          reject(err);
        } else {
          resolve({
            buffer: buf,
            statusCode: res.statusCode,
            headers: res.headers,
          });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error("Request timeout"));
    });

    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body) || typeof body === "string") {
        req.write(body);
      } else {
        req.setHeader("Content-Type", "application/json");
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

// ─── Sync HTTP (via worker thread) ──────────────────────
const _syncBridge = require("./sync-bridge");

function _syncRequest(method, path, { body } = {}) {
  const methodCode = method === "GET" ? 0 : method === "POST" ? 1 : 2;

  let bodyBuf = null;
  if (body !== undefined && body !== null) {
    if (Buffer.isBuffer(body)) bodyBuf = body;
    else if (typeof body === "string") bodyBuf = Buffer.from(body, "utf8");
    else bodyBuf = Buffer.from(JSON.stringify(body), "utf8");
  }

  if (_syncBridge.isAvailable()) {
    const result = _syncBridge.syncRequest(methodCode, path, bodyBuf);
    if (result && result.statusCode > 0) {
      if (result.statusCode >= 400) {
        const err = new Error(`HTTP ${result.statusCode}: ${result.body.toString("utf8")}`);
        err.statusCode = result.statusCode;
        err.body = result.body;
        throw err;
      }
      return result.body;
    }
  }

  throw new Error("sync HTTP unavailable (worker bridge not ready) for " + method + " " + path);
}

// ─── Sync read cache ─────────────────────────────────────
// Sync fs ops fork a curl process per call (5-15ms each). Repeated statSync/
// existsSync/readdirSync on the same path (e.g. require() resolution, cpSync
// walks) fork N times for identical results. A short-TTL cache collapses those
// to one fork per window. Any mutating call clears the cache immediately.
const _syncCache = new Map();
const _SYNC_CACHE_DEFAULT_TTL = 500;
const _SYNC_CACHEABLE = /^\/api\/fs\/(stat|list|access|read|readlink|glob|statfs)\b/;

function _syncCacheGet(path) {
  const ttl = _config.syncCacheTtlMs != null ? _config.syncCacheTtlMs : _SYNC_CACHE_DEFAULT_TTL;
  if (ttl <= 0) return null;
  if (!_SYNC_CACHEABLE.test(path)) return null;
  const entry = _syncCache.get(path);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _syncCache.delete(path);
    return null;
  }
  return entry.body;
}

function _syncCacheSet(path, body) {
  if (!_SYNC_CACHEABLE.test(path)) return;
  const ttl = _config.syncCacheTtlMs != null ? _config.syncCacheTtlMs : _SYNC_CACHE_DEFAULT_TTL;
  if (ttl <= 0) return;
  _syncCache.set(path, { body, expiresAt: Date.now() + ttl });
}

function _syncCacheClear() {
  _syncCache.clear();
}

// ─── Public API ──────────────────────────────────────────
module.exports = {
  configure,
  setCacheProvider,
  get syncMaxFileBytes() { return _config.syncMaxFileBytes; },
  get shouldRemote() { return _config.shouldRemote; },
  get pathTransform() { return _config.pathTransform; },

  // Async helpers
  async getJSON(path) {
    const { buffer } = await _asyncRequest("GET", path);
    return JSON.parse(buffer.toString("utf8"));
  },

  async getBuffer(path) {
    const { buffer } = await _asyncRequest("GET", path);
    return buffer;
  },

  async getStream(path) {
    // Cache provider: return cached buffer as a stream if available
    if (_cacheProvider) {
      const cached = _cacheProvider.get(path);
      if (cached) {
        if (cached.statusCode >= 400) {
          const err = new Error(`HTTP ${cached.statusCode}: ${cached.body.toString()}`);
          err.statusCode = cached.statusCode;
          err.body = cached.body;
          throw err;
        }
        const { Readable } = require("stream");
        return Readable.from([cached.body]);
      }
    }
    // Returns a promise that resolves to the response object (a readable stream)
    return new Promise((resolve, reject) => {
      const fullUrl = new URL(path, _config.baseURL);
      const lib = fullUrl.protocol === "https:" ? https : http;
      const reqHeaders = {};
      if (_config.token) reqHeaders["Authorization"] = "Bearer " + _config.token;

      const req = lib.request(
        {
          method: "GET",
          hostname: fullUrl.hostname,
          port: fullUrl.port,
          path: fullUrl.pathname + fullUrl.search,
          headers: reqHeaders,
          agent: fullUrl.protocol === "https:" ? _httpsAgent : _httpAgent,
        },
        (res) => {
          if (res.statusCode >= 400) {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const err = new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`);
              err.statusCode = res.statusCode;
              err.body = Buffer.concat(chunks);
              reject(err);
            });
            return;
          }
          resolve(res);
        }
      );
      req.on("error", reject);
      req.end();
    });
  },

  async putBuffer(path, buf) {
    _syncCacheClear();
    if (_cacheProvider) _cacheProvider.invalidate(path);
    const { buffer } = await _asyncRequest("PUT", path, {
      body: buf,
      headers: { "Content-Type": "application/octet-stream" },
    });
    return JSON.parse(buffer.toString("utf8"));
  },

  async putString(path, str) {
    _syncCacheClear();
    if (_cacheProvider) _cacheProvider.invalidate(path);
    const { buffer } = await _asyncRequest("PUT", path, {
      body: str,
      headers: { "Content-Type": "application/octet-stream" },
    });
    return JSON.parse(buffer.toString("utf8"));
  },

  async postJSON(path, obj) {
    _syncCacheClear();
    if (_cacheProvider) _cacheProvider.invalidate(path);
    const { buffer } = await _asyncRequest("POST", path, {
      body: JSON.stringify(obj),
      headers: { "Content-Type": "application/json" },
    });
    return JSON.parse(buffer.toString("utf8"));
  },

  async postRaw(path, body) {
    _syncCacheClear();
    if (_cacheProvider) _cacheProvider.invalidate(path);
    const { buffer } = await _asyncRequest("POST", path, {
      body: body,
      headers: { "Content-Type": "application/octet-stream" },
    });
    return JSON.parse(buffer.toString("utf8"));
  },

  // Sync helpers
  getBufferSync(path) {
    if (_cacheProvider) {
      const cached = _cacheProvider.get(path);
      if (cached) {
        if (cached.statusCode >= 400) {
          const err = new Error(`HTTP ${cached.statusCode}: ${cached.body.toString("utf8")}`);
          err.statusCode = cached.statusCode;
          err.body = cached.body;
          throw err;
        }
        return cached.body;
      }
    }
    const cached = _syncCacheGet(path);
    if (cached !== null) return cached;
    try {
      const body = _syncRequest("GET", path);
      _syncCacheSet(path, body);
      if (_cacheProvider) _cacheProvider.set(path, 200, body);
      return body;
    } catch (err) {
      if (err.statusCode && _cacheProvider) _cacheProvider.set(path, err.statusCode, err.body);
      throw err;
    }
  },

  putBufferSync(path, buf) {
    _syncCacheClear();
    if (_cacheProvider) _cacheProvider.invalidate(path);
    const out = _syncRequest("PUT", path, { body: buf });
    return JSON.parse(out.toString("utf8"));
  },

  putStringSync(path, str) {
    _syncCacheClear();
    if (_cacheProvider) _cacheProvider.invalidate(path);
    const out = _syncRequest("PUT", path, { body: str });
    return JSON.parse(out.toString("utf8"));
  },

  postJSONSync(path, obj) {
    // Only mutating POSTs reach here (mkdir/delete/move/etc). Clear the cache
    // so a subsequent statSync sees the new state, not a stale cached one.
    _syncCacheClear();
    if (_cacheProvider) _cacheProvider.invalidate(path);
    const out = _syncRequest("POST", path, { body: obj });
    return JSON.parse(out.toString("utf8"));
  },

  // Low-level async (for custom use)
  _asyncRequest,
};