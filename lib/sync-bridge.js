"use strict";

// Sync HTTP bridge — provides synchronous HTTP via a worker thread + SharedArrayBuffer.
// Replaces execFileSync("curl") which spawned a new process per call.
//
// The main thread writes the request to a SharedArrayBuffer, posts a message
// to the worker, and blocks on Atomics.wait. The worker does http.request
// (keep-alive), writes the response, and Atomics.notify wakes the main thread.

const { Worker } = require("worker_threads");
const path = require("path");

let _worker = null;
let _signal = null;
let _dataBuf = null;
let _ready = false;
let _dead = false;

function init(opts) {
  if (_worker) return;
  if (typeof SharedArrayBuffer === "undefined") return false;

  const sabSignal = new SharedArrayBuffer(16);
  const sabData = new SharedArrayBuffer(16 * 1024 * 1024);
  _signal = new Int32Array(sabSignal);
  _dataBuf = Buffer.from(sabData);

  try {
    _worker = new Worker(path.join(__dirname, "sync-worker.js"), {
      workerData: {
        sabSignal,
        sabData,
        baseURL: opts.baseURL,
        token: opts.token,
        tls: opts.baseURL.startsWith("https://"),
      },
    });
  } catch (e) {
    _worker = null;
    return false;
  }

  _worker.on("message", (msg) => {
    if (msg.type === "ready") _ready = true;
    else if (msg.type === "error") {
      // Worker reported an error; don't mark dead — it may recover
    }
  });
  _worker.on("error", () => { _dead = true; });
  _worker.on("exit", () => { _dead = true; });

  // Allow the process to exit even if the worker is still alive
  try { _worker.unref(); } catch (e) {}

  process.on("exit", () => {
    if (_worker) { try { _worker.terminate(); } catch (e) {} }
  });

  // Wait for worker ready (up to 8s)
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (Atomics.load(_signal, 1) === 1) { _ready = true; break; }
    Atomics.wait(_signal, 1, 0, 500);
  }
  return _ready;
}

function isAvailable() {
  return _worker && _ready && !_dead;
}

// ── Response cache for GET /api/fs/* requests ───────────────────────────
// Avoids redundant HTTP round-trips for repeated stat/read/readdir calls.
// TTL-based; cleared on mutation via clearCache/invalidatePath.
const _fsCache = new Map();
const _FS_CACHE_TTL = 60000;
let _fsCacheEnabled = false;

function enableFsCache(on) { _fsCacheEnabled = !!on; }

function clearFsCache() { _fsCache.clear(); }

function invalidateFsPath(path) {
  const enc = encodeURIComponent(path);
  for (const key of [..._fsCache.keys()]) {
    if (key.includes("path=" + enc) || key.includes("path=" + enc + "&")) _fsCache.delete(key);
  }
}

function setFsCacheEntry(urlPath, statusCode, body) {
  _fsCache.set(urlPath, { v: { statusCode, body: Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8") }, t: Date.now() });
}

// method: 0=GET, 1=POST, 2=PUT
function syncRequest(methodCode, urlPath, body, reqId) {
  if (!isAvailable()) return null; // caller falls back to curl

  // Check cache for GET /api/fs/* requests
  if (_fsCacheEnabled && methodCode === 0 && urlPath.startsWith("/api/fs/")) {
    const entry = _fsCache.get(urlPath);
    if (entry && Date.now() - entry.t < _FS_CACHE_TTL) return entry.v;
  }

  const pathLen = Buffer.byteLength(urlPath, "utf8");
  _dataBuf.writeInt32LE(methodCode, 0);
  _dataBuf.writeInt32LE(pathLen, 4);
  _dataBuf.write(urlPath, 8, "utf8");
  let off = 8 + pathLen;

  if (body != null) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    _dataBuf.writeInt32LE(buf.length, off);
    off += 4;
    if (off + buf.length > _dataBuf.length) {
      // Too large for SAB — fall back to curl
      return null;
    }
    buf.copy(_dataBuf, off);
  } else {
    _dataBuf.writeInt32LE(0, off);
  }

  Atomics.store(_signal, 0, 0);
  _worker.postMessage({ type: "request", reqId });
  const r = Atomics.wait(_signal, 0, 0, 30000);
  if (r !== "ok" || Atomics.load(_signal, 0) !== 1) {
    return null; // timeout — caller falls back to curl
  }

  const statusCode = _dataBuf.readInt32LE(0);
  const bodyLen = _dataBuf.readInt32LE(4);
  const respBody = bodyLen > 0 ? Buffer.allocUnsafe(bodyLen) : Buffer.alloc(0);
  if (bodyLen > 0) _dataBuf.copy(respBody, 0, 8, 8 + bodyLen);
  const result = { statusCode, body: respBody };

  // Cache successful GET /api/fs/* responses (including 404 — negative cache)
  if (_fsCacheEnabled && methodCode === 0 && urlPath.startsWith("/api/fs/") && (statusCode === 200 || statusCode === 404 || statusCode === 204)) {
    _fsCache.set(urlPath, { v: result, t: Date.now() });
  }

  return result;
}

module.exports = { init, isAvailable, syncRequest, enableFsCache, clearFsCache, invalidateFsPath, setFsCacheEntry };
