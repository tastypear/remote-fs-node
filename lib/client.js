"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { execFileSync } = require("child_process");

const _config = {
  baseURL: "http://127.0.0.1:8765",
  token: "",
  curlPath: null, // auto-detect
  syncMaxFileBytes: 64 * 1024 * 1024, // 64MB — openSync refuses larger, use async
};

// Shared keepAlive agents — every async call reuses pooled sockets instead of
// opening a fresh TCP connection (and TLS handshake) per request. This is the
// single biggest async-throughput lever for chatty workloads (stat/readdir
// storms, fd read/write loops).
const _httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 1000 });
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 1000 });

function configure(opts) {
  Object.assign(_config, opts);
}

function _curlPath() {
  if (_config.curlPath) return _config.curlPath;
  try {
    // Windows has curl.exe, Linux has /usr/bin/curl
    return "curl";
  } catch {
    throw new Error("curl not found — required for sync fs methods");
  }
}

// ─── Async HTTP ──────────────────────────────────────────
function _asyncRequest(method, path, { body, headers = {}, responseType = "buffer" } = {}) {
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

// ─── Sync HTTP (via curl) ────────────────────────────────
function _syncRequest(method, path, { body } = {}) {
  const fullUrl = new URL(path, _config.baseURL).href;
  const curl = _curlPath();
  // -w "\n%{http_code}" appends HTTP status code as last line
  const args = ["-s", "-S", "--max-time", "120", "-w", "\n%{http_code}", "-X", method, fullUrl];

  if (_config.token) {
    args.push("-H", "Authorization: Bearer " + _config.token);
  }
  if (body !== undefined && body !== null) {
    if (Buffer.isBuffer(body)) {
      args.push("--data-binary", "@-");
    } else if (typeof body === "string") {
      args.push("--data-binary", body);
    } else {
      args.push("-H", "Content-Type: application/json");
      args.push("--data", JSON.stringify(body));
    }
  }

  const input = Buffer.isBuffer(body) ? body : undefined;
  const output = execFileSync(curl, args, {
    input: input,
    maxBuffer: 1024 * 1024 * 512,
  });

  // Last line is the HTTP status code
  const lastNl = output.lastIndexOf(0x0a); // \n
  const httpCode = parseInt(output.subarray(lastNl + 1).toString("utf8").trim(), 10);
  const bodyData = output.subarray(0, lastNl);

  if (httpCode >= 400) {
    const err = new Error(`HTTP ${httpCode}: ${bodyData.toString("utf8")}`);
    err.statusCode = httpCode;
    err.body = bodyData;
    throw err;
  }

  return bodyData;
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
  get syncMaxFileBytes() { return _config.syncMaxFileBytes; },

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
    const { buffer } = await _asyncRequest("PUT", path, {
      body: buf,
      headers: { "Content-Type": "application/octet-stream" },
    });
    return JSON.parse(buffer.toString("utf8"));
  },

  async putString(path, str) {
    _syncCacheClear();
    const { buffer } = await _asyncRequest("PUT", path, {
      body: str,
      headers: { "Content-Type": "application/octet-stream" },
    });
    return JSON.parse(buffer.toString("utf8"));
  },

  async postJSON(path, obj) {
    _syncCacheClear();
    const { buffer } = await _asyncRequest("POST", path, {
      body: JSON.stringify(obj),
      headers: { "Content-Type": "application/json" },
    });
    return JSON.parse(buffer.toString("utf8"));
  },

  async postRaw(path, body) {
    _syncCacheClear();
    const { buffer } = await _asyncRequest("POST", path, {
      body: body,
      headers: { "Content-Type": "application/octet-stream" },
    });
    return JSON.parse(buffer.toString("utf8"));
  },

  // Sync helpers
  getBufferSync(path) {
    const cached = _syncCacheGet(path);
    if (cached !== null) return cached;
    const body = _syncRequest("GET", path);
    _syncCacheSet(path, body);
    return body;
  },

  putBufferSync(path, buf) {
    _syncCacheClear();
    const out = _syncRequest("PUT", path, { body: buf });
    return JSON.parse(out.toString("utf8"));
  },

  putStringSync(path, str) {
    _syncCacheClear();
    const out = _syncRequest("PUT", path, { body: str });
    return JSON.parse(out.toString("utf8"));
  },

  postJSONSync(path, obj) {
    // Only mutating POSTs reach here (mkdir/delete/move/etc). Clear the cache
    // so a subsequent statSync sees the new state, not a stale cached one.
    _syncCacheClear();
    const out = _syncRequest("POST", path, { body: obj });
    return JSON.parse(out.toString("utf8"));
  },

  // Low-level async (for custom use)
  _asyncRequest,
};