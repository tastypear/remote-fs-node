"use strict";

const Module = require("module");
const { patchGracefulFs } = require("./graceful");
const { patchBinding, restoreBinding, isBindingPatched } = require("./binding");

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

function patch(remoteFs, options) {
  if (_patched) return;
  const opts = options || {};
  _patchSync = opts.patchSync === true;

  _originalFs = require("fs");
  _originalValues = {};
  _remoteFsRef = remoteFs;

  for (const key of Object.keys(remoteFs)) {
    // Skip sync methods unless patchSync is true
    if (!_patchSync && key.endsWith("Sync") && key !== "existsSync") {
      continue;
    }
    try {
      _originalValues[key] = _originalFs[key];
      Object.defineProperty(_originalFs, key, {
        value: remoteFs[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch {}
  }

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
  if (_remoteFsRef && _originalFs) {
    for (const key of Object.keys(_remoteFsRef)) {
      if (!_patchSync && key.endsWith("Sync") && key !== "existsSync") {
        continue;
      }
      try {
        Object.defineProperty(_originalFs, key, {
          value: _remoteFsRef[key],
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
