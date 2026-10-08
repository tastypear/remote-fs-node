"use strict";

/**
 * Binding-level interception for process.binding('fs').
 *
 * This patches the native C++ fs binding so that Node's internal
 * code paths (fs.readFile, fs.stat, fs.readdir, etc.) route through
 * our HTTP backend instead of real syscalls.
 *
 * Strategy (same as mock-fs):
 *   1. Wrap each binding method with a dispatcher
 *   2. When _mockedBinding is set, dispatch to our implementation
 *   3. When _mockedBinding is not set, call the original
 *
 * Three call modes are supported:
 *   - Promise:  last meaningful arg is kUsePromises symbol → return Promise
 *   - Callback: arg includes FSReqCallback object → call req.oncomplete(err, val)
 *   - Sync:     no req arg → return value directly
 */

const realBinding = process.binding("fs");
const kUsePromises = realBinding.kUsePromises;
const statValues = realBinding.statValues;
const bigintStatValues = realBinding.bigintStatValues;

// Store original methods
const _origMethods = {};
let _mockImpl = null;

// Stats conversion: fill statValues Float64Array with stat data
// Node expects: [dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks,
//                atimeMs, mtimeMs, ctimeMs, birthtimeMs, ...]
// Server (_stat_to_dict) sends timestamps as integer epoch ms already; use them
// directly (no *1000). Fall back to mtime for any missing timestamp field.
function _fillStatValues(info, useBigint) {
  const arr = useBigint ? bigintStatValues : statValues;
  const mode = (typeof info.fullMode === "number") ? info.fullMode : (_modeFromTypeBinding(info.type) | _parseMode(info.mode));
  const ms = (k) => (typeof info[k] === "number" ? info[k] : (info.mtime || 0));

  arr[0] = info.dev || 0;                              // dev
  arr[1] = mode;                                       // mode (incl. S_IFMT)
  arr[2] = info.nlink || 1;                            // nlink
  arr[3] = info.uid || 0;                              // uid
  arr[4] = info.gid || 0;                              // gid
  arr[5] = info.rdev || 0;                             // rdev
  arr[6] = info.blksize || 4096;                       // blksize
  arr[7] = info.ino || 0;                              // ino
  arr[8] = info.size || 0;                             // size
  arr[9] = (typeof info.blocks === "number") ? info.blocks : Math.ceil((info.size || 0) / 512); // blocks
  arr[10] = ms("atime");                               // atimeMs
  arr[11] = ms("mtime");                               // mtimeMs
  arr[12] = ms("ctime");                               // ctimeMs
  arr[13] = ms("birthtime");                           // birthtimeMs
  // 14-17 are atimeNs, mtimeNs, ctimeNs, birthtimeNs (optional)
}

function _parseMode(modeStr) {
  if (typeof modeStr === "number") return modeStr;
  if (typeof modeStr === "string") return parseInt(modeStr.replace(/^0o/, ""), 8);
  return 0o644;
}

function _modeFromTypeBinding(type) {
  switch (type) {
    case "dir": return 0o040000;
    case "symlink": return 0o120000;
    case "blockdev": return 0o060000;
    case "chardev": return 0o020000;
    case "fifo": return 0o010000;
    case "socket": return 0o140000;
    default: return 0o100000;
  }
}

// ─── Dispatch helpers ────────────────────────────────────

/**
 * Detect call mode from arguments.
 * Returns: { mode: 'promise'|'callback'|'sync', req, args }
 */
function _detectMode(args) {
  // Check for kUsePromises in args (usually 3rd or 4th position)
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === kUsePromises) {
      return { mode: "promise", promiseSymbol: args[i], restArgs: args.slice(0, i) };
    }
  }

  // Check for FSReqCallback (has oncomplete method)
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] && typeof args[i] === "object" && typeof args[i].oncomplete === "function") {
      return { mode: "callback", req: args[i], restArgs: args.slice(0, i) };
    }
  }

  // Sync mode — no req
  return { mode: "sync", restArgs: args };
}

/**
 * Execute an async operation and handle the result based on call mode.
 * For promise mode: return a Promise.
 * For callback mode: call req.oncomplete(err, value).
 * For sync mode: return value (operation must be sync).
 */
// Convert raw HTTP errors to fs errors at the dispatch level so all binding
// callers (including Node.js internals that bypass JS-level fs) get proper
// ENOENT/EACCES/etc. errors. Methods that already convert (e.g. access) are
// unaffected — httpToFsError returns errors without statusCode as-is.
function _convertHttpError(err) {
  if (err && err.statusCode) {
    const { httpToFsError } = require("./errors");
    const fsErr = httpToFsError(err.statusCode, err.message);
    if (err.path) fsErr.path = err.path;
    return fsErr;
  }
  return err;
}

function _dispatch(fn, args) {
  const { mode, req, restArgs, promiseSymbol } = _detectMode(args);

  if (mode === "promise") {
    return new Promise((resolve, reject) => {
      fn(restArgs).then(resolve, (err) => reject(_convertHttpError(err)));
    });
  }

  if (mode === "callback") {
    fn(restArgs).then(
      (value) => { req.oncomplete(null, value); },
      (err) => { req.oncomplete(_convertHttpError(err)); }
    );
    return; // binding methods return undefined for callback mode
  }

  // Sync mode — fn must return synchronously
  try {
    return fn(restArgs);
  } catch (err) {
    throw _convertHttpError(err);
  }
}

// ─── Binding method implementations ──────────────────────
// Each takes restArgs (without the req/promise symbol) and returns a Promise
// or value.

const _impl = {
  async stat(args) {
    // args: [path, useBigint, isRecordAccess]
    const [path, useBigint] = args;
    const client = require("./client");
    const { toStats } = require("./stats");
    const info = await client.getJSON(`/api/fs/stat?path=${encodeURIComponent(path)}&follow=true`);
    const stats = toStats(info);
    _fillStatValues(info, useBigint);
    return stats;
  },

  async lstat(args) {
    // follow=false: do NOT follow symlinks (os.lstat on the server).
    const [path, useBigint] = args;
    const client = require("./client");
    const { toStats } = require("./stats");
    const info = await client.getJSON(`/api/fs/stat?path=${encodeURIComponent(path)}&follow=false`);
    const stats = toStats(info);
    _fillStatValues(info, useBigint);
    return stats;
  },

  async fstat(args) {
    // args: [fd, useBigint]
    const [fd, useBigint] = args;
    const entry = _getFdEntry(fd);
    if (!entry) {
      const err = new Error(`EBADF: bad file descriptor, fd ${fd}`);
      err.code = "EBADF";
      err.errno = -9;
      throw err;
    }
    // RemoteFdEntry.stat() hits /api/fs/fd/fstat (true fd semantics);
    // BufferedFdEntry.stat() hits /api/fs/stat by path.
    const stats = await entry.stat();
    return stats;
  },

  async open(args) {
    // args: [path, flags, mode]
    const [path, flags, mode] = args;
    const { flagsToString } = require("./flags");
    const flagStr = flagsToString(flags);
    // Return a fake fd — the fd table is managed by async-api's _fdTable
    // But binding open is called directly by Node internals
    // We need our own fd table for binding-level opens
    return _bindingFdTable.open(path, flagStr, mode);
  },

  async read(args) {
    // args: [fd, buffer, offset, length, position]
    const [fd, buffer, offset, length, position] = args;
    const entry = _bindingFdTable.get(fd);
    if (!entry) throw _ebadf(fd);
    const bytesRead = await entry.read(buffer, offset, length, position);
    return bytesRead;
  },

  async writeBuffer(args) {
    // args: [fd, buffer, offset, length, position, req?]
    // The req is already stripped by _detectMode
    const [fd, buffer, offset, length, position] = args;
    const entry = _bindingFdTable.get(fd);
    if (!entry) throw _ebadf(fd);
    const written = await entry.write(buffer, offset, length, position);
    return written;
  },

  writeBuffers(args) {
    // args: [fd, buffers, position]
    return _impl.writeBuffer(args);
  },

  async writeString(args) {
    // args: [fd, string, position, encoding]
    const [fd, string, position, encoding] = args;
    const buf = Buffer.from(string, encoding || "utf8");
    return _impl.writeBuffer([fd, buf, 0, buf.length, position]);
  },

  async close(args) {
    const [fd] = args;
    await _bindingFdTable.close(fd);
    return undefined;
  },

  async readdir(args) {
    // args: [path, encoding, withFileTypes]
    const [path, encoding, withFileTypes] = args;
    const client = require("./client");
    const entries = await client.getJSON(`/api/fs/list?path=${encodeURIComponent(path)}`);
    if (withFileTypes) {
      // Return array of { name, type } — Node converts to Dirent internally
      return entries.map(e => ({
        name: e.name,
        type: e.type === "dir" ? 2 : e.type === "symlink" ? 3 : e.type === "file" ? 1 : 0,
      }));
    }
    return entries.map(e => e.name);
  },

  async access(args) {
    // args: [path, mode]
    const [path, mode] = args;
    const client = require("./client");
    const modeStr = (mode || 0).toString(8);
    try {
      await client._asyncRequest("GET", `/api/fs/access?path=${encodeURIComponent(path)}&mode=${modeStr}`);
    } catch (err) {
      const { httpToFsError } = require("./errors");
      throw httpToFsError(err.statusCode, err.message);
    }
    return undefined;
  },

  // Sync methods (return directly, not Promise)
  existsSync(args) {
    const [path] = args;
    const client = require("./client");
    // We can't do sync HTTP here without curl — but existsSync is
    // critical for require(). We'll use the original binding for sync.
    // This is the key insight: sync methods should NOT be patched by default.
    return _origMethods.existsSync.apply(realBinding, args);
  },

  // mkdir, unlink, rename, etc. — forward to async API
  async mkdir(args) {
    const [path, mode] = args;
    const client = require("./client");
    const modeStr = mode ? "0o" + (mode & 0o777).toString(8) : null;
    await client.postJSON("/api/fs/mkdir", { path, mode: modeStr });
    client.invalidatePath(path);
    return undefined;
  },

  async rmdir(args) {
    const [path] = args;
    const client = require("./client");
    await client.postJSON("/api/fs/delete", { path });
    client.invalidatePath(path);
    return undefined;
  },

  async unlink(args) {
    return _impl.rmdir(args);
  },

  async rename(args) {
    const [oldPath, newPath] = args;
    const client = require("./client");
    await client.postJSON("/api/fs/move", { src: oldPath, dst: newPath });
    client.invalidatePath(oldPath); client.invalidatePath(newPath);
    return undefined;
  },

  async copyFile(args) {
    const [src, dst, mode] = args;
    const client = require("./client");
    await client.postJSON("/api/fs/copy", { src, dst });
    client.invalidatePath(dst);
    return undefined;
  },

  async chmod(args) {
    const [path, mode] = args;
    const client = require("./client");
    const modeStr = "0" + (mode & 0o777).toString(8);
    await client.postJSON("/api/fs/chmod", { path, mode: modeStr });
    client.invalidatePath(path);
    return undefined;
  },

  async chown(args) {
    const [path, uid, gid] = args;
    const client = require("./client");
    await client.postJSON("/api/fs/chown", { path, uid, gid, follow: true });
    client.invalidatePath(path);
    return undefined;
  },

  async symlink(args) {
    const [target, path] = args;
    const client = require("./client");
    await client.postJSON("/api/fs/symlink", { target, link: path });
    client.invalidatePath(path);
    return undefined;
  },

  async readlink(args) {
    const [path] = args;
    const client = require("./client");
    const result = await client.getJSON(`/api/fs/readlink?path=${encodeURIComponent(path)}`);
    return result.target;
  },

  async realpath(args) {
    const [path] = args;
    const client = require("./client");
    const result = await client.postJSON("/api/fs/realpath", { path });
    return result.realpath;
  },

  async truncate(args) {
    const [path, len] = args;
    const client = require("./client");
    await client.postJSON("/api/fs/truncate", { path, len: len || 0 });
    client.invalidatePath(path);
    return undefined;
  },

  async ftruncate(args) {
    const [fd, len] = args;
    const entry = _bindingFdTable.get(fd);
    if (!entry) throw _ebadf(fd);
    if (entry.type === "async") {
      await entry.ftruncate(len || 0);
    } else {
      await entry._ensureLoaded();
      if (len < entry._content.length) {
        entry._content = entry._content.subarray(0, len);
      } else if (len > entry._content.length) {
        const newBuf = Buffer.alloc(len);
        entry._content.copy(newBuf);
        entry._content = newBuf;
      }
      entry._dirty = true;
    }
    return undefined;
  },

  async fsync(args) {
    const [fd] = args;
    const entry = _bindingFdTable.get(fd);
    if (!entry) throw _ebadf(fd);
    // Flush pending writes to the server; do NOT close — the fd must remain
    // valid for subsequent read/write/fstat. (Previous impl closed+reopened
    // via a nonexistent _closedEntries field, which threw TypeError and lost
    // the fd.)
    await entry.flush();
    return undefined;
  },

  async mkdtemp(args) {
    const [prefix] = args;
    const client = require("./client");
    const result = await client.postJSON("/api/fs/mkdtemp", { prefix });
    return result.path;
  },

  async link(args) {
    const [existingPath, newPath] = args;
    const client = require("./client");
    await client.postJSON("/api/fs/link", { existing: existingPath, newpath: newPath });
    client.invalidatePath(newPath);
    return undefined;
  },

  async utimes(args) {
    const [path, atime, mtime] = args;
    const client = require("./client");
    // atime/mtime arrive as seconds (float) or ms — normalize to epoch ms.
    const toMs = (t) => {
      if (typeof t === "number") return t > 1e12 ? Math.trunc(t) : Math.trunc(t * 1000);
      const d = new Date(t);
      return isNaN(d) ? Date.now() : d.getTime();
    };
    await client.postJSON("/api/fs/utimes", { path, atime: toMs(atime), mtime: toMs(mtime), follow: true });
    client.invalidatePath(path);
    return undefined;
  },

  // readFileUtf8 — Node's fast path for readFile('utf8')
  async readFileUtf8(args) {
    const [path, flags] = args;
    const client = require("./client");
    const buf = await client.getBuffer(`/api/fs/read?path=${encodeURIComponent(path)}`);
    return buf.toString("utf8");
  },

  // writeFileUtf8
  async writeFileUtf8(args) {
    const [path, data, flags, mode] = args;
    // Handle numeric fd — Node.js allows fs.writeFileSync(fd, data)
    if (typeof path === "number") {
      const entry = _getGlobalFdTable().get(path);
      if (entry && entry._content !== null) {
        entry._content = Buffer.from(data, "utf8");
        entry._dirty = true;
        return data.length;
      }
    }
    const client = require("./client");
    const buf = Buffer.from(data, "utf8");
    await client.putBuffer(`/api/fs/write?path=${encodeURIComponent(path)}`, buf);
    return data.length;
  },

  // fdatasync — same as fsync
  fdatasync(args) {
    return _impl.fsync(args);
  },

  // fchmod
  async fchmod(args) {
    const [fd, mode] = args;
    const entry = _bindingFdTable.get(fd);
    if (!entry) throw _ebadf(fd);
    if (entry.type === "async") {
      await entry.fchmod(typeof mode === "number" ? mode : parseInt(String(mode), 8));
    } else {
      return _impl.chmod([entry.path, mode]);
    }
    return undefined;
  },

  // fchown
  async fchown(args) {
    const [fd, uid, gid] = args;
    const entry = _bindingFdTable.get(fd);
    if (!entry) throw _ebadf(fd);
    if (entry.type === "async") {
      await entry.fchown(uid, gid);
    } else {
      const client = require("./client");
      await client.postJSON("/api/fs/chown", { path: entry.path, uid, gid, follow: true });
    }
    return undefined;
  },

  // lchown
  async lchown(args) {
    const [path, uid, gid] = args;
    const client = require("./client");
    await client.postJSON("/api/fs/chown", { path, uid, gid, follow: false });
    client.invalidatePath(path);
    return undefined;
  },

  // lchmod — Linux doesn't support lchmod (returns ENOSYS on real fs too);
  // fall through to chmod for best-effort.
  lchmod(args) {
    return _impl.chmod(args);
  },

  // lutimes
  async lutimes(args) {
    const [path, atime, mtime] = args;
    const client = require("./client");
    const toMs = (t) => {
      if (typeof t === "number") return t > 1e12 ? Math.trunc(t) : Math.trunc(t * 1000);
      const d = new Date(t);
      return isNaN(d) ? Date.now() : d.getTime();
    };
    await client.postJSON("/api/fs/utimes", { path, atime: toMs(atime), mtime: toMs(mtime), follow: false });
    client.invalidatePath(path);
    return undefined;
  },

  // futimes
  async futimes(args) {
    const [fd, atime, mtime] = args;
    const entry = _bindingFdTable.get(fd);
    if (!entry) throw _ebadf(fd);
    if (entry.type === "async") {
      const toMs = (t) => {
        if (typeof t === "number") return t > 1e12 ? Math.trunc(t) : Math.trunc(t * 1000);
        const d = new Date(t);
        return isNaN(d) ? Date.now() : d.getTime();
      };
      await entry.futimes(toMs(atime), toMs(mtime));
      return undefined;
    }
    return _impl.utimes([entry.path, atime, mtime]);
  },

  // rmSync — used by fs.rmSync
  async rmSync(args) {
    const [path, options] = args;
    const client = require("./client");
    await client.postJSON("/api/fs/delete", { path });
    client.invalidatePath(path);
    return undefined;
  },
};

// ─── Binding FD table ────────────────────────────────────
// The binding layer shares the SAME global fd table as async-api and sync-api
// (lib/fd-table.js globalFdTable), so an fd opened via process.binding('fs').open
// is valid for fs.fstat (JS layer) and vice versa. We import it lazily to avoid
// a require cycle (fd-table → client → ... is fine, but keep it explicit).

function _getGlobalFdTable() {
  return require("./fd-table").globalFdTable;
}

// BindingFdEntry/BidingFdTable are kept as a thin compatibility shim for any
// internal call that still routes through _impl.open (binding-level open). In
// practice the binding open() below delegates to the global table.
class BindingFdEntry {
  constructor(path, flags, mode) {
    this.path = path;
    this.flags = flags;
    this.mode = mode;
    this.position = 0;
    this._content = null;
    this._dirty = false;

    const f = flags.toLowerCase();
    this._isWrite = f.includes("w") || f.includes("a") || f.includes("+");
    this._isAppend = f.includes("a");
    this._isTrunc = f.includes("w") && !f.includes("+");
  }

  async _ensureLoaded() {
    if (this._content === null) {
      if (this._isTrunc) {
        this._content = Buffer.alloc(0);
      } else {
        try {
          const client = require("./client");
          this._content = await client.getBuffer(
            `/api/fs/read?path=${encodeURIComponent(this.path)}`
          );
        } catch (err) {
          if (err.statusCode === 404 && this._isWrite) {
            this._content = Buffer.alloc(0);
          } else {
            throw err;
          }
        }
      }
      if (this._isAppend) this.position = this._content.length;
    }
    return this._content;
  }

  async read(buffer, offset, length, position) {
    const content = await this._ensureLoaded();
    const pos = position != null ? position : this.position;
    const available = Math.max(0, content.length - pos);
    const toRead = Math.min(length, available);
    if (toRead > 0) content.copy(buffer, offset, pos, pos + toRead);
    if (position == null) this.position += toRead;
    return toRead;
  }

  async write(data, offset, length, position) {
    await this._ensureLoaded();
    const pos = position != null ? position : this.position;
    const writeData = data.subarray(offset, offset + length);
    const endPos = pos + writeData.length;
    if (endPos > this._content.length) {
      const newBuf = Buffer.alloc(endPos);
      this._content.copy(newBuf);
      this._content = newBuf;
    }
    writeData.copy(this._content, pos);
    this._dirty = true;
    if (position == null) this.position = endPos;
    return writeData.length;
  }

  async flush() {
    if (this._dirty) {
      const client = require("./client");
      await client.putBuffer(`/api/fs/write?path=${encodeURIComponent(this.path)}`, this._content);
      this._dirty = false;
    }
  }
}

const _bindingFdTable = {
  // Delegate to the global table so fds are shared across layers.
  open(path, flags, mode) {
    return _getGlobalFdTable().openSync(path, flags, mode);
  },
  get(fd) {
    return _getGlobalFdTable().get(fd);
  },
  close(fd) {
    return _getGlobalFdTable().close(fd);
  },
};

function _ebadf(fd) {
  const err = new Error(`EBADF: bad file descriptor, fd ${fd}`);
  err.code = "EBADF";
  err.errno = -9;
  return err;
}

// Resolve an fd to its entry across whichever table holds it (just the global
// table now — unified). Used by fstat/ftruncate/fsync/fchown/futimes.
function _getFdEntry(fd) {
  try {
    return _getGlobalFdTable().get(fd);
  } catch (_) {
    return null;
  }
}


// ─── Local path fallback ─────────────────────────────────
// If a path looks like a local Windows path (has drive letter or backslash),
// fall back to the original binding method. This allows require() and
// local file operations to work alongside remote operations.
function _isLocalPath(p) {
  if (typeof p !== "string") return false;
  // Windows drive letter: C:\, D:\, etc.
  if (/^[A-Za-z]:/.test(p)) return true;
  // UNC path
  if (p.startsWith("\\\\")) return true;
  // Backslash in path (Windows-style)
  if (p.includes("\\")) return true;
  // Relative path (no leading /)
  if (!p.startsWith("/") && !p.startsWith("\\")) return true;
  return false;
}

function _shouldFallback(args) {
  const client = require("./client");
  const custom = client.shouldRemote;
  // Check fd FIRST (for fd-based ops like read/write/close/fstat).
  // Must precede the string check — writeString(fd, data, ...) has data
  // as a string arg, and if data starts with "/" it would be misclassified
  // as a remote path, routing stdout writes to the remote server.
  if (typeof args[0] === "number") {
    return !_getGlobalFdTable().has(args[0]);
  }
  // Then check string args (for path-based ops like stat/open/readdir)
  for (const arg of args) {
    if (typeof arg === "string") {
      return custom ? !custom(arg) : _isLocalPath(arg);
    }
  }
  return false;
}

// ─── Patch / Restore ─────────────────────────────────────

function _patchKey(key) {
  const existingMethod = realBinding[key];
  if (typeof existingMethod !== "function") return;
  if (key === "Stats" || key === "StatWatcher") return; // constructors
  if (key === "FSReqCallback" || key === "FileHandle") return; // classes
  if (key === "openFileHandle" || key === "legacyMainResolve") return;
  if (key === "getFormatOfExtensionlessFile") return;
  if (key === "internalModuleStat") return; // used by require(), keep real
  if (key === "kUsePromises") return; // symbol
  if (key === "statValues" || key === "bigintStatValues") return; // typed arrays
  if (key === "cpSyncCheckPaths" || key === "cpSyncOverrideFile" || key === "cpSyncCopyDir") return;

  _origMethods[key] = existingMethod;

  realBinding[key] = function (...args) {
    if (_mockImpl && _impl[key] && !_shouldFallback(args)) {
      const transform = require("./client").pathTransform;
      if (transform) {
        args = args.map(a => (typeof a === "string" && a.startsWith("/")) ? transform(a) : a);
      }
      const impl = _impl[key];
      if (key === "existsSync") {
        return impl.call(_impl, args);
      }
      return _dispatch(impl.bind(_impl), args);
    }
    return existingMethod.apply(this, args);
  }.bind(realBinding);
}

function patchBinding(fdTable) {
  // fdTable arg is accepted for API compatibility but ignored — the binding
  // layer always uses the shared global fd table (lib/fd-table.js globalFdTable)
  // so fds are unified across all three layers.

  for (const key of Object.getOwnPropertyNames(realBinding)) {
    if (!_origMethods[key]) {
      _patchKey(key);
    }
  }

  _mockImpl = _impl;
}

function restoreBinding() {
  for (const key of Object.keys(_origMethods)) {
    try {
      realBinding[key] = _origMethods[key];
    } catch {}
  }
  _mockImpl = null;
}

function isBindingPatched() {
  return _mockImpl !== null;
}

module.exports = {
  patchBinding,
  restoreBinding,
  isBindingPatched,
  _bindingFdTable,
  _impl,
  _fillStatValues,
};