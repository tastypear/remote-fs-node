"use strict";

const Module = require("module");
const { patchGracefulFs } = require("./graceful");
const { patchBinding, restoreBinding, isBindingPatched } = require("./binding");
const { globalFdTable: _remoteFdTable } = require("./fd-table");

let _originalFs = null;
let _originalValues = null;
let _patched = false;
let _origResolveFilename = null;
let _patchSync = false;
let _inBypass = false;
// Depth counter so nested/overlapping async bypass() calls don't clobber each
// other. Only the OUTERMOST bypass (depth 0 → 1) swaps to local fs, and only
// the outermost exit (depth 1 → 0) repatches remote fs. Inner bypass calls
// just bump/decrement without touching the patch state, so concurrent remote
// callers keep seeing remote fs while an outer bypass is active.
let _bypassDepth = 0;
let _remoteFsRef = null;

// Check if a path should stay local (not routed to remote server).
// Mirrors binding.js _isLocalPath but also respects the shouldRemote callback.
function _shouldLocalPath(p) {
  if (typeof p !== "string") return false;
  const client = require("./client");
  const custom = client.shouldRemote;
  if (custom) return !custom(p);
  if (/^[A-Za-z]:/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  if (p.includes("\\")) return true;
  if (!p.startsWith("/") && !p.startsWith("\\")) return true;
  return false;
}

// Wrap a remote method so that calls with a local first-arg path fall through
// to the original (pre-patch) fs method. This covers JS-level methods that
// bypass the binding layer (realpathSync, existsSync, etc.).
// Also handles fd-based ops (writeSync, readSync, closeSync, etc.) — if the
// fd is not in the remote fd table, fall back to native (e.g. fd=1 stdout).
function _wrapMethod(remoteFn, origFn) {
  const wrapped = function (...args) {
    // null/undefined path → stdio stream (process.stdin/stdout/stderr) or an
    // invalid fs call; either way use native. Without this, new ReadStream(null)
    // (how Node creates process.stdin) routes to the remote ReadStream, which
    // fetches /api/fs/read?path=null from the server on every stdin access.
    if (args[0] == null) {
      return new.target ? Reflect.construct(origFn, args, origFn) : origFn.apply(this, args);
    }
    if (typeof args[0] === "string" && _shouldLocalPath(args[0])) {
      return new.target ? Reflect.construct(origFn, args, origFn) : origFn.apply(this, args);
    }
    if (typeof args[0] === "number" && !_remoteFdTable.has(args[0])) {
      return new.target ? Reflect.construct(origFn, args, origFn) : origFn.apply(this, args);
    }
    return new.target ? Reflect.construct(remoteFn, args, remoteFn) : remoteFn.apply(this, args);
  };
  // Share prototype so `new fs.ReadStream(...)` produces an instance whose
  // prototype chain has the remote class's methods (_fetch, _read, close, …).
  // Reflect.construct(remoteFn, args, remoteFn) gives the instance remoteFn's
  // prototype; setting wrapped.prototype = remoteFn.prototype makes
  // `instanceof fs.ReadStream` hold for the common (remote) path.
  if (remoteFn && remoteFn.prototype) wrapped.prototype = remoteFn.prototype;
  return wrapped;
}

// Wrap fs.promises methods so local paths fall through to native fs.promises.
// Without this, fs.promises.readFile("D:/local") goes to the remote server.
function _wrapPromises(remotePromises, nativePromises) {
  const result = {};
  // Copy own properties (remote-fs-node's promisesApi is a plain object)
  for (const key of Object.getOwnPropertyNames(remotePromises)) {
    const remoteFn = remotePromises[key];
    const nativeFn = nativePromises[key];
    if (typeof remoteFn === "function" && typeof nativeFn === "function") {
      result[key] = function (...args) {
        if (typeof args[0] === "string" && _shouldLocalPath(args[0])) {
          return nativeFn.apply(nativePromises, args);
        }
        return remoteFn.apply(remotePromises, args);
      };
    } else {
      result[key] = remoteFn;
    }
  }
  // Also copy methods from the prototype (native fs.promises has methods on prototype)
  const nativeProto = Object.getPrototypeOf(nativePromises);
  if (nativeProto && nativeProto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(nativeProto)) {
      if (result[key] !== undefined) continue;
      const nativeFn = nativeProto[key];
      if (typeof nativeFn === "function") {
        result[key] = function (...args) {
          if (typeof args[0] === "string" && _shouldLocalPath(args[0])) {
            return nativeFn.apply(nativePromises, args);
          }
          // No remote equivalent — call native (e.g. fs.promises.open with FileHandle)
          return nativeFn.apply(nativePromises, args);
        };
      }
    }
  }
  return result;
}

// Wrap the separate node:fs/promises module (distinct from fs.promises).
// Node.js: require("fs/promises") !== require("fs").promises. Many libraries
// (including qoder's bundle) import from "node:fs/promises" directly. Without
// this, those imports get the NATIVE stat/readFile, which calls the patched
// binding — but the native promise-mode stat doesn't properly consume the
// Stats object returned by the patched binding (it reads statValues at the
// wrong time), yielding empty Stats (isFile=false, size=undefined). Routing
// through the remote promises-api directly avoids the binding entirely.
function _patchFsPromisesModule(remotePromises, nativeMod) {
  if (!remotePromises || !nativeMod || nativeMod === _originalFs.promises) return;
  for (const key of Object.getOwnPropertyNames(remotePromises)) {
    const remoteFn = remotePromises[key];
    const nativeFn = nativeMod[key];
    if (typeof remoteFn !== "function" || typeof nativeFn !== "function") continue;
    try {
      Object.defineProperty(nativeMod, key, {
        value: function (...args) {
          if (typeof args[0] === "string" && _shouldLocalPath(args[0])) {
            return nativeFn.apply(nativeMod, args);
          }
          return remoteFn.apply(remotePromises, args);
        },
        writable: true, configurable: true, enumerable: true,
      });
    } catch {}
  }
}

function patch(remoteFs, options) {
  if (_patched) return;
  const opts = options || {};
  _patchSync = opts.patchSync === true;

  _originalFs = require("fs");
  _originalValues = {};
  _remoteFsRef = remoteFs;

  for (const key of Object.keys(remoteFs)) {
    // Skip primitives (constants like F_OK=0, R_OK=4) — nothing to patch,
    // and reading _originalFs[key] for deprecated aliases (fs.F_OK) triggers
    // Node.js DEP0176. Keep functions AND objects (e.g. fs.promises).
    const val = remoteFs[key];
    if (val === null || (typeof val !== "function" && typeof val !== "object")) continue;
    // Skip sync methods unless patchSync is true
    if (!_patchSync && key.endsWith("Sync") && key !== "existsSync") {
      continue;
    }
    try {
      _originalValues[key] = _originalFs[key];
      const remoteFn = remoteFs[key];
      const origFn = _originalFs[key];

      if (key === "promises" && typeof remoteFn === "object" && typeof origFn === "object") {
        // Wrap fs.promises methods with shouldRemote fallback for local paths.
        // Without this, fs.promises.readFile("D:/local") goes to the remote server.
        const wrappedPromises = _wrapPromises(remoteFn, origFn);
        Object.defineProperty(_originalFs, key, {
          value: wrappedPromises,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        const wrapped = (typeof remoteFn === "function" && typeof origFn === "function")
          ? _wrapMethod(remoteFn, origFn) : remoteFn;
        Object.defineProperty(_originalFs, key, {
          value: wrapped,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    } catch {}
  }

  // Patch the separate node:fs/promises module (distinct from fs.promises).
  try { _patchFsPromisesModule(_remoteFsRef.promises, require("fs/promises")); } catch {}

  const symbols = Object.getOwnPropertySymbols(remoteFs);
  for (const sym of symbols) {
    try { _originalFs[sym] = remoteFs[sym]; } catch {}
  }

  const fsModulePath = require.resolve("fs");
  // Capture the current resolver in a CLOSURE local, not the module-level
  // _origResolveFilename. If another library (e.g. remote-cp-node) patches
  // the same hook and restores out of LIFO order, the module-level var gets
  // nulled — but this closure still holds a valid reference, so the wrapper
  // degrades gracefully instead of crashing with "Cannot read 'call' of null".
  const prevResolveFilename = Module._resolveFilename;
  _origResolveFilename = prevResolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === "node:fs") {
      return fsModulePath;
    }
    return prevResolveFilename.call(this, request, parent, isMain, options);
  };

  patchGracefulFs(_originalFs);

  // Patch process.binding('fs') for native code paths
  patchBinding();
  _patched = true;
}

function _repatch() {
  _inBypass = false;
  // Re-apply binding patch
  if (_remoteFsRef) patchBinding();
  // Re-apply fs/promises module patch
  try { _patchFsPromisesModule(_remoteFsRef.promises, require("fs/promises")); } catch {}
  if (_remoteFsRef && _originalFs) {
    for (const key of Object.keys(_remoteFsRef)) {
      const val = _remoteFsRef[key];
      if (val === null || (typeof val !== "function" && typeof val !== "object")) continue;
      if (!_patchSync && key.endsWith("Sync") && key !== "existsSync") {
        continue;
      }
      try {
        const remoteFn = _remoteFsRef[key];
        const origFn = _originalValues[key];
        const wrapped = (typeof remoteFn === "function" && typeof origFn === "function")
          ? _wrapMethod(remoteFn, origFn) : remoteFn;
        Object.defineProperty(_originalFs, key, {
          value: wrapped,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } catch {}
    }
  }
}

function restore() {
  if (!_patched) return;

  if (_originalFs && _originalValues) {
    for (const key of Object.keys(_originalValues)) {
      try {
        Object.defineProperty(_originalFs, key, {
          value: _originalValues[key],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } catch {}
    }
  }

  if (_origResolveFilename) {
    Module._resolveFilename = _origResolveFilename;
    _origResolveFilename = null;
  }

  restoreBinding();

  _patched = false;
  _originalFs = null;
  _originalValues = null;
  _remoteFsRef = null;
  _patchSync = false;
  _inBypass = false;
  _bypassDepth = 0;
}

function _enterBypass() {
  // Swap fs → local. Called only when depth goes 0 → 1.
  _inBypass = true;
  if (isBindingPatched()) restoreBinding();
  for (const key of Object.keys(_originalValues)) {
    try {
      Object.defineProperty(_originalFs, key, {
        value: _originalValues[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch {}
  }
}

function bypass(fn) {
  if (typeof fn !== "function") {
    throw new Error("bypass() requires a function argument");
  }
  if (!_patched || !_originalValues) {
    return fn();
  }

  // Depth: only the outermost bypass actually swaps to local fs. Nested calls
  // (sync or async) just bump the depth so the swap stays in effect until ALL
  // bypasses have exited. This prevents overlapping async bypass() calls from
  // repatching remote fs while a sibling bypass is still running its local fn.
  const wasOutermost = _bypassDepth === 0;
  _bypassDepth++;
  if (wasOutermost) _enterBypass();

  const exit = () => {
    _bypassDepth--;
    if (_bypassDepth === 0) {
      _repatch();
    }
  };

  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        (r) => { exit(); return r; },
        (err) => { exit(); throw err; }
      );
    }
    exit();
    return result;
  } catch (err) {
    exit();
    throw err;
  }
}

function isInBypass() {
  return _inBypass;
}

function isPatched() {
  return _patched;
}

module.exports = { patch, restore, isPatched, bypass, isInBypass };
