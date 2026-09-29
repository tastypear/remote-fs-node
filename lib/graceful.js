"use strict";

/**
 * graceful-fs compatibility layer.
 *
 * graceful-fs (used by many npm packages) monkey-patches require("fs")
 * with retry logic for EMFILE/ENFILE errors.  When we patch fs, we
 * need to also patch the graceful-fs copy if it has been loaded.
 *
 * Strategy: after patching the real fs, check if graceful-fs is in the
 * require cache.  If so, overwrite its exports to point to our patched fs.
 */

const Module = require("module");

/**
 * Patch graceful-fs if it has been loaded.
 * Call this AFTER the main fs patch is applied.
 *
 * @param {object} patchedFs - The patched fs exports object
 */
function patchGracefulFs(patchedFs) {
  // Walk the require cache to find graceful-fs
  for (const [id, mod] of Object.entries(require.cache)) {
    if (id.includes("graceful-fs") && id.endsWith("graceful-fs.js")) {
      try {
        // graceful-fs exports the same object as fs (it patches in place)
        // plus adds a `gracefulify` method and `Queue` properties.
        // We overwrite the key methods it patched back to our implementations.
        const gfs = mod.exports;
        for (const key of Object.keys(patchedFs)) {
          try {
            if (typeof gfs[key] !== "undefined" || key in gfs) {
              Object.defineProperty(gfs, key, {
                value: patchedFs[key],
                writable: true,
                enumerable: true,
                configurable: true,
              });
            }
          } catch {}
        }
        // Also patch gfs.promises if present
        if (gfs.promises && patchedFs.promises) {
          for (const key of Object.keys(patchedFs.promises)) {
            try {
              gfs.promises[key] = patchedFs.promises[key];
            } catch {}
          }
        }
      } catch {}
    }
  }

  // Also handle the case where graceful-fs patches process.cwd / chdir
  // graceful-fs replaces fs.realpath and fs.realpathNative with its own
  // We skip those — they should work fine since our realpath uses exec.
}

module.exports = { patchGracefulFs };