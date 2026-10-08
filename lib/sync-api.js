"use strict";

const client = require("./client");
const constants = require("./constants");
const { globalFdTable, Stats, Dirent, Dir, toStats, toDirent } = require("./fd-table");
const { httpToFsError, notImplemented } = require("./errors");
const { flagsToString } = require("./flags");
const globHelper = require("./glob");

function _normalizePath(p) {
  if (Buffer.isBuffer(p)) p = p.toString("utf8");
  p = String(p);
  // Normalize Windows backslashes to forward slashes for remote Linux server
  if (p.indexOf("\\") !== -1) p = p.split("\\").join("/");
  const transform = client.pathTransform;
  if (transform) p = transform(p);
  return p;
}

function _errFromHttp(err, syscall, p) {
  if (err.statusCode) {
    const fsErr = httpToFsError(err.statusCode, err.message);
    fsErr.syscall = syscall;
    if (p) fsErr.path = p;
    return fsErr;
  }
  return err;
}

function _timeToMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t > 1e12 ? Math.trunc(t) : Math.trunc(t * 1000);
  const d = new Date(t);
  return isNaN(d) ? Date.now() : d.getTime();
}

// ─── Sync implementations ────────────────────────────────
function readFileSync(path, options) {
  const p = _normalizePath(path);
  const opts = typeof options === "string" ? { encoding: options } : (options || {});
  try {
    const buf = client.getBufferSync(`/api/fs/read?path=${encodeURIComponent(p)}`);
    if (opts.encoding) return buf.toString(opts.encoding);
    return buf;
  } catch (err) {
    throw _errFromHttp(err, "read", p);
  }
}

function writeFileSync(path, data, options) {
  // Handle numeric fd — Node.js allows fs.writeFileSync(fd, data)
  if (typeof path === "number") {
    const entry = globalFdTable.get(path);
    if (entry && entry._content !== null) {
      const opts = typeof options === "string" ? { encoding: options } : (options || {});
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), opts.encoding || "utf8");
      entry._content = buf;
      entry._dirty = true;
      return;
    }
  }
  const p = _normalizePath(path);
  const opts = typeof options === "string" ? { encoding: options } : (options || {});
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), opts.encoding || "utf8");
  const mode = opts.mode ? `&mode=${opts.mode}` : "";
  try {
    client.putBufferSync(`/api/fs/write?path=${encodeURIComponent(p)}${mode}`, buf);
  } catch (err) {
    throw _errFromHttp(err, "write", p);
  }
}

function appendFileSync(path, data, options) {
  const p = _normalizePath(path);
  const opts = typeof options === "string" ? { encoding: options } : (options || {});
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), opts.encoding || "utf8");
  const mode = opts.mode ? `&mode=${opts.mode}` : "";
  try {
    // Server append=true opens in "ab" mode — no client-side read-rewrite.
    client.putBufferSync(`/api/fs/write?path=${encodeURIComponent(p)}${mode}&append=true`, buf);
  } catch (err) {
    throw _errFromHttp(err, "append", p);
  }
}

function readdirSync(path, options) {
  const p = _normalizePath(path);
  const opts = typeof options === "string" ? { encoding: options } : (options || {});
  const withFileTypes = opts.withFileTypes === true;
  const recursive = opts.recursive === true;
  const listUrl = `/api/fs/list?path=${encodeURIComponent(p)}` + (recursive ? "&recursive=true" : "");
  try {
    const buf = client.getBufferSync(listUrl);
    const entries = JSON.parse(buf.toString("utf8"));
    if (withFileTypes) {
      return entries.map((e) => new Dirent(e.name, e.type, p));
    }
    return entries.map((e) => e.name);
  } catch (err) {
    throw _errFromHttp(err, "readdir", p);
  }
}

function statSync(path, options) {
  const p = _normalizePath(path);
  const useBigint = !!(options && options.bigint);
  try {
    const buf = client.getBufferSync(`/api/fs/stat?path=${encodeURIComponent(p)}&follow=true`);
    const s = toStats(JSON.parse(buf.toString("utf8")));
    return useBigint ? s.toBigInt() : s;
  } catch (err) {
    throw _errFromHttp(err, "stat", p);
  }
}

function lstatSync(path, options) {
  const p = _normalizePath(path);
  const useBigint = !!(options && options.bigint);
  try {
    const buf = client.getBufferSync(`/api/fs/stat?path=${encodeURIComponent(p)}&follow=false`);
    const s = toStats(JSON.parse(buf.toString("utf8")));
    return useBigint ? s.toBigInt() : s;
  } catch (err) {
    throw _errFromHttp(err, "lstat", p);
  }
}

function mkdirSync(path, options) {
  const p = _normalizePath(path);
  const opts = options || {};
  const mode = opts.mode ? (typeof opts.mode === "number" ? "0o" + (opts.mode & 0o777).toString(8) : opts.mode) : null;
  const recursive = opts.recursive === true;
  try {
    client.postJSONSync("/api/fs/mkdir", { path: p, mode, recursive });
    client.invalidatePath(p);
  } catch (err) {
    throw _errFromHttp(err, "mkdir", p);
  }
}

function rmdirSync(path, options) {
  const p = _normalizePath(path);
  try {
    client.postJSONSync("/api/fs/delete", { path: p });
    client.invalidatePath(p);
  } catch (err) {
    throw _errFromHttp(err, "rmdir", p);
  }
}

function rmSync(path, options) {
  const p = _normalizePath(path);
  try {
    client.postJSONSync("/api/fs/delete", { path: p });
    client.invalidatePath(p);
  } catch (err) {
    throw _errFromHttp(err, "rm", p);
  }
}

function unlinkSync(path) {
  const p = _normalizePath(path);
  try {
    client.postJSONSync("/api/fs/delete", { path: p });
    client.invalidatePath(p);
  } catch (err) {
    throw _errFromHttp(err, "unlink", p);
  }
}

function renameSync(oldPath, newPath) {
  const op = _normalizePath(oldPath);
  const np = _normalizePath(newPath);
  try {
    client.postJSONSync("/api/fs/move", { src: op, dst: np });
    client.invalidatePath(op); client.invalidatePath(np);
  } catch (err) {
    throw _errFromHttp(err, "rename", op);
  }
}

function copyFileSync(src, dest) {
  const sp = _normalizePath(src);
  const dp = _normalizePath(dest);
  try {
    client.postJSONSync("/api/fs/copy", { src: sp, dst: dp });
    client.invalidatePath(dp);
  } catch (err) {
    throw _errFromHttp(err, "copyfile", sp);
  }
}

function cpSync(src, dest, options) {
  const sp = _normalizePath(src);
  const dp = _normalizePath(dest);
  const opts = options || {};
  const recursive = opts.recursive === true;
  // Check src type; reject dirs when not recursive (matching real fs.cp).
  let srcType = "file";
  try {
    const buf = client.getBufferSync(`/api/fs/stat?path=${encodeURIComponent(sp)}&follow=false`);
    srcType = JSON.parse(buf.toString("utf8")).type;
  } catch (err) { throw _errFromHttp(err, "cp", sp); }
  if (srcType === "dir" && !recursive) {
    const err = new Error(`EISDIR: illegal operation on a directory, copy '${sp}'`);
    err.code = "EISDIR"; err.errno = -21; err.syscall = "copy"; err.path = sp;
    throw err;
  }
  try {
    client.postJSONSync("/api/fs/copy", { src: sp, dst: dp });
  } catch (err) {
    throw _errFromHttp(err, "cp", sp);
  }
}

function chmodSync(path, mode) {
  const p = _normalizePath(path);
  const modeStr = typeof mode === "number" ? "0" + mode.toString(8).slice(-3) : String(mode);
  try {
    client.postJSONSync("/api/fs/chmod", { path: p, mode: modeStr });
    client.invalidatePath(p);
  } catch (err) {
    throw _errFromHttp(err, "chmod", p);
  }
}

function lchmodSync(path, mode) {
  return chmodSync(path, mode);
}

function chownSync(path, uid, gid) {
  const p = _normalizePath(path);
  try {
    client.postJSONSync("/api/fs/chown", { path: p, uid, gid, follow: true });
    client.invalidatePath(p);
  } catch (err) {
    throw _errFromHttp(err, "chown", p);
  }
}

function lchownSync(path, uid, gid) {
  const p = _normalizePath(path);
  try {
    client.postJSONSync("/api/fs/chown", { path: p, uid, gid, follow: false });
    client.invalidatePath(p);
  } catch (err) {
    throw _errFromHttp(err, "lchown", p);
  }
}

function utimesSync(path, atime, mtime) {
  const p = _normalizePath(path);
  try {
    client.postJSONSync("/api/fs/utimes", { path: p, atime: _timeToMs(atime), mtime: _timeToMs(mtime), follow: true });
    client.invalidatePath(p);
  } catch (err) {
    throw _errFromHttp(err, "utimes", p);
  }
}

function lutimesSync(path, atime, mtime) {
  const p = _normalizePath(path);
  try {
    client.postJSONSync("/api/fs/utimes", { path: p, atime: _timeToMs(atime), mtime: _timeToMs(mtime), follow: false });
    client.invalidatePath(p);
  } catch (err) {
    throw _errFromHttp(err, "lutimes", p);
  }
}

function truncateSync(path, len) {
  const p = _normalizePath(path);
  try {
    client.postJSONSync("/api/fs/truncate", { path: p, len: len || 0 });
    client.invalidatePath(p);
  } catch (err) {
    throw _errFromHttp(err, "truncate", p);
  }
}

function symlinkSync(target, path, type) {
  const tp = _normalizePath(target);
  const lp = _normalizePath(path);
  try {
    client.postJSONSync("/api/fs/symlink", { target: tp, link: lp });
    client.invalidatePath(lp);
  } catch (err) {
    throw _errFromHttp(err, "symlink", lp);
  }
}

function readlinkSync(path, options) {
  const p = _normalizePath(path);
  try {
    const buf = client.getBufferSync(`/api/fs/readlink?path=${encodeURIComponent(p)}`);
    return JSON.parse(buf.toString("utf8")).target;
  } catch (err) {
    throw _errFromHttp(err, "readlink", p);
  }
}

function linkSync(existingPath, newPath) {
  const ep = _normalizePath(existingPath);
  const np = _normalizePath(newPath);
  try {
    client.postJSONSync("/api/fs/link", { existing: ep, newpath: np });
    client.invalidatePath(np);
  } catch (err) {
    throw _errFromHttp(err, "link", ep);
  }
}

realpathSync.native = function(path, options) {
  return realpathSync(path, options);
};

function realpathSync(path, options) {
  const p = _normalizePath(path);
  try {
    const result = client.postJSONSync("/api/fs/realpath", { path: p });
    return result.realpath;
  } catch (err) {
    throw _errFromHttp(err, "realpath", p);
  }
}

function existsSync(path) {
  const p = _normalizePath(path);
  try {
    client.getBufferSync(`/api/fs/stat?path=${encodeURIComponent(p)}&follow=false`);
    return true;
  } catch {
    return false;
  }
}

function accessSync(path, mode) {
  const p = _normalizePath(path);
  const modeStr = typeof mode === "number" ? mode.toString(8) : String(mode || 0);
  try {
    client.getBufferSync(`/api/fs/access?path=${encodeURIComponent(p)}&mode=${modeStr}`);
  } catch (err) {
    throw _errFromHttp(err, "access", p);
  }
}

function mkdtempSync(prefix, options) {
  const p = _normalizePath(prefix);
  try {
    const result = client.postJSONSync("/api/fs/mkdtemp", { prefix: p });
    return result.path;
  } catch (err) {
    throw _errFromHttp(err, "mkdtemp", p);
  }
}

function statfsSync(path) {
  const p = _normalizePath(path);
  try {
    const buf = client.getBufferSync(`/api/fs/statfs?path=${encodeURIComponent(p)}`);
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    throw _errFromHttp(err, "statfs", p);
  }
}

// opendirSync: returns a Dir with sync read/close + Symbol.iterator.
// Mirrors the async opendir Dir shape so code can use either interchangeably.
function opendirSync(path, options) {
  const p = _normalizePath(path);
  const opts = options || {};
  const withFileTypes = opts.withFileTypes === true;
  let entries;
  try {
    const buf = client.getBufferSync(`/api/fs/list?path=${encodeURIComponent(p)}`);
    entries = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    throw _errFromHttp(err, "opendir", p);
  }
  const items = entries.map((e) => {
    const d = new Dirent(e.name, e.type, p);
    return withFileTypes ? d : { name: e.name, ...d };
  });
  return new Dir(p, items);
}

// globSync: synchronous glob. Returns string[] or Dirent[] (withFileTypes).
function globSync(pattern, options) {
  const opts = options || {};
  const withFileTypes = opts.withFileTypes === true;
  const matches = globHelper.fetchMatchesSync(pattern, opts);
  return globHelper.buildResult(matches, withFileTypes);
}

// mkdtempDisposableSync: mkdtemp + auto-remove on [Symbol.dispose] (the `using`
// syntax). Returns a prototype-less {path, remove, [Symbol.dispose]} matching
// Node's shape. remove() is idempotent (safe to call / dispose twice).
function mkdtempDisposableSync(prefix, options) {
  const dirPath = mkdtempSync(prefix, options);
  let removed = false;
  const obj = Object.create(null);
  obj.path = dirPath;
  obj.remove = function remove() {
    if (removed) return;
    removed = true;
    try { rmSync(dirPath, { recursive: true, force: true }); } catch (_) {}
  };
  obj[Symbol.dispose] = obj.remove;
  return obj;
}

// ─── Sync FD operations ──────────────────────────────────
// Uses the SHARED global fd table (same instance as the async API + binding
// layer) so an fd from openSync is valid for fs.fstat (async) and vice versa.
// Content is loaded synchronously here (curl); the FdEntry.read/write helpers
// are async, so sync read/write operate on the entry's _content directly.

function openSync(path, flags, mode) {
  const p = _normalizePath(path);
  const fd = globalFdTable.openSync(p, flags, mode);
  const entry = globalFdTable.get(fd);

  const f = entry.flags.toLowerCase();
  const isRead = f.startsWith("r");
  const isWrite = f.includes("w") || f.includes("a") || f.includes("+");
  const isTrunc = (f.includes("w") && !f.includes("+")) || f === "w+";
  const isExcl = f.includes("x");
  const isAppend = f.includes("a");

  // O_EXCL: file must NOT exist, else EEXIST.
  if (isExcl) {
    try {
      client.getBufferSync(`/api/fs/stat?path=${encodeURIComponent(p)}&follow=false`);
      const err = new Error(`EEXIST: file already exists, open '${p}'`);
      err.code = "EEXIST"; err.errno = -17; err.syscall = "open"; err.path = p;
      throw err;
    } catch (err) {
      if (err.code === "EEXIST") throw err;
    }
  }

  if (isTrunc && !isExcl) {
    entry._content = Buffer.alloc(0);
    entry._dirty = true;
  } else {
    // Size guard: openSync preloads the whole file into _content, so reject
    // oversized files to bound memory — guide callers to async fs.promises.open
    // (RemoteFdEntry, ranged O(1) read) for large files.
    try {
      const statBuf = client.getBufferSync(`/api/fs/stat?path=${encodeURIComponent(p)}&follow=false`);
      const size = JSON.parse(statBuf.toString("utf8")).size;
      const max = client.syncMaxFileBytes;
      if (typeof size === "number" && size > max) {
        const e = new Error(`ERR_FS_FILE_TOO_LARGE: file too large for openSync (${size} > ${max}), use fs.promises.open instead, open '${p}'`);
        e.code = "ERR_FS_FILE_TOO_LARGE"; e.errno = -10; e.syscall = "open"; e.path = p;
        throw e;
      }
    } catch (err) {
      if (err.code === "ERR_FS_FILE_TOO_LARGE") throw err;
      // stat failed (ENOENT etc.) — fall through; the read below surfaces it.
    }
    try {
      const buf = client.getBufferSync(`/api/fs/read?path=${encodeURIComponent(p)}`);
      entry._content = buf;
      if (isAppend) entry.position = buf.length;
    } catch (err) {
      if (isWrite && !isRead) {
        entry._content = Buffer.alloc(0);
      } else {
        const e = new Error(`ENOENT: no such file or directory, open '${p}'`);
        e.code = "ENOENT"; e.errno = -2; e.syscall = "open"; e.path = p;
        throw e;
      }
    }
  }
  return fd;
}

function readSync(fd, buffer, offset, length, position) {
  const entry = globalFdTable.get(fd);
  const content = entry._content;
  if (content === null) {
    const err = new Error(`EBADF: bad file descriptor, fd ${fd} (not loaded)`);
    err.code = "EBADF"; err.errno = -9; throw err;
  }
  const pos = position != null ? position : entry.position;
  const available = Math.max(0, content.length - pos);
  const toRead = Math.min(length, available);
  if (toRead > 0) {
    content.copy(buffer, offset, pos, pos + toRead);
  }
  if (position == null) entry.position += toRead;
  return toRead;
}

function writeSync(fd, buffer, offset, length, position) {
  if (typeof buffer === "string") {
    buffer = Buffer.from(buffer);
    offset = 0;
    length = buffer.length;
  }
  const entry = globalFdTable.get(fd);
  const content = entry._content;
  if (content === null) {
    const err = new Error(`EBADF: bad file descriptor, fd ${fd} (not loaded)`);
    err.code = "EBADF"; err.errno = -9; throw err;
  }
  const pos = position != null ? position : entry.position;
  const writeData = Buffer.isBuffer(buffer) ? buffer.subarray(offset, offset + length) : Buffer.from(String(buffer).substring(offset, offset + length));
  const endPos = pos + writeData.length;
  if (endPos > content.length) {
    const newBuf = Buffer.alloc(endPos);
    content.copy(newBuf);
    entry._content = newBuf;
  }
  writeData.copy(entry._content, pos);
  entry._dirty = true;
  if (position == null) entry.position = endPos;
  return writeData.length;
}

function closeSync(fd) {
  const entry = globalFdTable.get(fd);
  if (entry._dirty && entry._content !== null) {
    client.putBufferSync(`/api/fs/write?path=${encodeURIComponent(entry.path)}`, entry._content);
    entry._dirty = false;
    _applyPendingMeta(entry);
  } else {
    _applyPendingMeta(entry);
  }
  // Remove from the shared table so the fd can't be reused accidentally.
  globalFdTable._entries.delete(fd);
}

// readvSync: scatter read into multiple buffers (sync). Returns total bytesRead.
function readvSync(fd, buffers, position) {
  let total = 0;
  let pos = position != null ? position : null;
  for (const buf of buffers) {
    const bytesRead = readSync(fd, buf, 0, buf.length, pos);
    total += bytesRead;
    if (pos != null) pos += bytesRead;
    if (bytesRead < buf.length) break;
  }
  return total;
}

// writevSync: gather write from multiple buffers (sync). Returns total bytesWritten.
function writevSync(fd, buffers, position) {
  let total = 0;
  let pos = position != null ? position : null;
  for (const buf of buffers) {
    const written = writeSync(fd, buf, 0, buf.length, pos);
    total += written;
    if (pos != null) pos += written;
  }
  return total;
}

function fstatSync(fd) {
  const entry = globalFdTable.get(fd);
  return statSync(entry.path);
}

function ftruncateSync(fd, len) {
  const entry = globalFdTable.get(fd);
  const content = entry._content;
  if (content === null) {
    const err = new Error(`EBADF: bad file descriptor, fd ${fd} (not loaded)`);
    err.code = "EBADF"; err.errno = -9; throw err;
  }
  if (len < content.length) {
    entry._content = content.subarray(0, len);
  } else if (len > content.length) {
    const newBuf = Buffer.alloc(len);
    content.copy(newBuf);
    entry._content = newBuf;
  }
  entry._dirty = true;
}

function fsyncSync(fd) {
  const entry = globalFdTable.get(fd);
  if (entry._dirty && entry._content !== null) {
    client.putBufferSync(`/api/fs/write?path=${encodeURIComponent(entry.path)}`, entry._content);
    entry._dirty = false;
    _applyPendingMeta(entry);
  }
}

function fchmodSync(fd, mode) {
  const entry = globalFdTable.get(fd);
  if (entry._dirty) {
    entry._pendingMode = mode;
  } else {
    chmodSync(entry.path, mode);
  }
}

function fchownSync(fd, uid, gid) {
  const entry = globalFdTable.get(fd);
  if (entry._dirty) {
    entry._pendingChown = [uid, gid];
  } else {
    chownSync(entry.path, uid, gid);
  }
}

function futimesSync(fd, atime, mtime) {
  const entry = globalFdTable.get(fd);
  if (entry._dirty) {
    entry._pendingUtimes = [atime, mtime];
  } else {
    utimesSync(entry.path, atime, mtime);
  }
}

// Apply deferred fchmod/fchown/futimes after a dirty entry is flushed to the
// server. openSync('w') defers file creation to closeSync/fsyncSync, so a
// path-based chmod/chown/utimes would 404 (file doesn't exist yet). We stash
// the metadata on the entry and apply it once the file exists.
function _applyPendingMeta(entry) {
  if (entry._pendingMode !== undefined) {
    chmodSync(entry.path, entry._pendingMode);
    entry._pendingMode = undefined;
  }
  if (entry._pendingChown) {
    chownSync(entry.path, entry._pendingChown[0], entry._pendingChown[1]);
    entry._pendingChown = null;
  }
  if (entry._pendingUtimes) {
    utimesSync(entry.path, entry._pendingUtimes[0], entry._pendingUtimes[1]);
    entry._pendingUtimes = null;
  }
}

function batchSync(ops) {
  const resp = client.postJSONSync("/api/fs/batch", { ops: ops });
  return resp.results;
}

module.exports = {
  readFileSync, writeFileSync, appendFileSync,
  readdirSync, statSync, lstatSync,
  mkdirSync, rmdirSync, rmSync, unlinkSync,
  renameSync, copyFileSync, cpSync,
  chmodSync, lchmodSync, chownSync, lchownSync,
  utimesSync, lutimesSync, truncateSync,
  symlinkSync, readlinkSync, linkSync, realpathSync,
  existsSync, accessSync, mkdtempSync, mkdtempDisposableSync, statfsSync, opendirSync, globSync,
  // FD ops
  openSync, readSync, writeSync, closeSync, readvSync, writevSync,
  fstatSync, ftruncateSync, fsyncSync, fdatasyncSync: (fd) => fsyncSync(fd),
  fchmodSync, fchownSync, futimesSync,
  // Batch
  batchSync,
};