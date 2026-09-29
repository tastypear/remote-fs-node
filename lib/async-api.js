"use strict";

const client = require("./client");
const constants = require("./constants");
const { globalFdTable } = require("./fd-table");
const { httpToFsError, notImplemented } = require("./errors");
const { Readable, Writable, PassThrough } = require("stream");
const { FSWatcher, StatWatcher, watch: _watch, watchFile: _watchFile, unwatchFile: _unwatchFile } = require("./watcher");
const path = require("path");
const { Stats, Dirent, Dir, toStats, toDirent } = require("./stats");
const { ReadStream, WriteStream } = require("./streams");
const globHelper = require("./glob");

// Shared global fd table — same instance used by sync-api and binding.js, so
// fds are valid across all three layers (openSync → fs.fstat, open → fstatSync).
let _fdTable = globalFdTable;

// ─── Helpers ─────────────────────────────────────────────
function _callbackWrapper(promise, callback) {
  if (typeof callback === "function") {
    promise.then(
      (result) => callback(null, result),
      (err) => callback(err)
    );
  }
  return promise;
}

// Spread variant for methods whose Node callback takes multiple success args,
// e.g. fs.read → cb(err, bytesRead, buffer), fs.write → cb(err, bytesWritten, buffer).
// The promise resolves to an object; we spread its values positionally.
function _callbackWrapperSpread(promise, callback, keys) {
  if (typeof callback === "function") {
    promise.then(
      (result) => { const args = keys.map((k) => result[k]); callback(null, ...args); },
      (err) => callback(err)
    );
  }
  return promise;
}

function _normalizePath(p) {
  if (Buffer.isBuffer(p)) p = p.toString("utf8");
  p = String(p);
  // Normalize Windows backslashes to forward slashes for remote Linux server
  if (p.indexOf("\\") !== -1) p = p.split("\\").join("/");
  return p;
}

function _errFromHttp(err, syscall, path) {
  if (err.statusCode) {
    const fsErr = httpToFsError(err.statusCode, err.message);
    fsErr.syscall = syscall;
    if (path) fsErr.path = path;
    return fsErr;
  }
  return err;
}

// ─── Stats conversion ────────────────────────────────────
// follow=true → os.stat (follow symlinks); follow=false → os.lstat.
function _statAsync(targetPath, followSymlinks) {
  const p = _normalizePath(targetPath);
  return client
    .getJSON(`/api/fs/stat?path=${encodeURIComponent(p)}&follow=${followSymlinks ? "true" : "false"}`)
    .then(toStats)
    .catch((err) => {
      throw _errFromHttp(err, followSymlinks ? "stat" : "lstat", p);
    });
}

function _statSync(targetPath, followSymlinks) {
  const p = _normalizePath(targetPath);
  try {
    const buf = client.getBufferSync(
      `/api/fs/stat?path=${encodeURIComponent(p)}&follow=${followSymlinks ? "true" : "false"}`
    );
    return toStats(JSON.parse(buf.toString("utf8")));
  } catch (err) {
    throw _errFromHttp(err, followSymlinks ? "stat" : "lstat", p);
  }
}

// ─── Time normalization ──────────────────────────────────
// Node fs.utimes accepts atime/mtime as seconds (number), ms (number > 1e12),
// Date, or ISO string. Normalize to integer epoch ms for the wire contract.
function _timeToMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t > 1e12 ? Math.trunc(t) : Math.trunc(t * 1000);
  const d = new Date(t);
  return isNaN(d) ? Date.now() : d.getTime();
}

// ─── Async callback API ──────────────────────────────────
// Each function returns a promise AND supports callback style.

function readFile(path, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const opts = typeof options === "string" ? { encoding: options } : (options || {});

  const promise = client.getBuffer(`/api/fs/read?path=${encodeURIComponent(p)}`)
    .then((buf) => {
      if (opts.encoding) return buf.toString(opts.encoding);
      return buf;
    })
    .catch((err) => { throw _errFromHttp(err, "read", p); });

  return _callbackWrapper(promise, callback);
}

function writeFile(path, data, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const opts = typeof options === "string" ? { encoding: options } : (options || {});
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), opts.encoding || "utf8");
  const mode = opts.mode ? `&mode=${opts.mode}` : "";

  const promise = client.putBuffer(
    `/api/fs/write?path=${encodeURIComponent(p)}${mode}`, buf
  )
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "write", p); });

  return _callbackWrapper(promise, callback);
}

function appendFile(path, data, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const opts = typeof options === "string" ? { encoding: options } : (options || {});
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), opts.encoding || "utf8");
  const mode = opts.mode ? `&mode=${opts.mode}` : "";

  // Use the server's append=true so we don't read-then-rewrite the whole file
  // (was unbounded memory + TOCTOU race). Server opens in "ab" mode.
  const promise = client.putBuffer(
    `/api/fs/write?path=${encodeURIComponent(p)}${mode}&append=true`, buf
  ).then(() => {})
    .catch((err) => { throw _errFromHttp(err, "append", p); });

  return _callbackWrapper(promise, callback);
}

function readdir(path, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const opts = typeof options === "string" ? { encoding: options } : (options || {});
  const withFileTypes = opts.withFileTypes === true;
  const recursive = opts.recursive === true;
  const listUrl = `/api/fs/list?path=${encodeURIComponent(p)}` + (recursive ? "&recursive=true" : "");

  const promise = client.getJSON(listUrl)
    .then((entries) => {
      if (withFileTypes) {
        return entries.map((e) => new Dirent(e.name, e.type, p));
      }
      return entries.map((e) => e.name);
    })
    .catch((err) => { throw _errFromHttp(err, "readdir", p); });

  return _callbackWrapper(promise, callback);
}

function stat(path, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const useBigint = !!(options && options.bigint);
  const promise = _statAsync(p, true).then((s) => useBigint ? s.toBigInt() : s);
  return _callbackWrapper(promise, callback);
}

function lstat(path, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const useBigint = !!(options && options.bigint);
  const promise = _statAsync(p, false).then((s) => useBigint ? s.toBigInt() : s);
  return _callbackWrapper(promise, callback);
}

function mkdir(path, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const opts = options || {};
  const mode = opts.mode ? (typeof opts.mode === "number" ? "0o" + (opts.mode & 0o777).toString(8) : opts.mode) : null;
  const recursive = opts.recursive === true;

  const promise = client.postJSON("/api/fs/mkdir", { path: p, mode, recursive })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "mkdir", p); });

  return _callbackWrapper(promise, callback);
}

function rmdir(path, callback) {
  const p = _normalizePath(path);
  const promise = client.postJSON("/api/fs/delete", { path: p })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "rmdir", p); });
  return _callbackWrapper(promise, callback);
}

function rm(path, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const promise = client.postJSON("/api/fs/delete", { path: p })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "rm", p); });
  return _callbackWrapper(promise, callback);
}

function unlink(path, callback) {
  const p = _normalizePath(path);
  const promise = client.postJSON("/api/fs/delete", { path: p })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "unlink", p); });
  return _callbackWrapper(promise, callback);
}

function rename(oldPath, newPath, callback) {
  const op = _normalizePath(oldPath);
  const np = _normalizePath(newPath);
  const promise = client.postJSON("/api/fs/move", { src: op, dst: np })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "rename", op); });
  return _callbackWrapper(promise, callback);
}

function copyFile(src, dest, mode, callback) {
  if (typeof mode === "function") { callback = mode; mode = undefined; }
  const sp = _normalizePath(src);
  const dp = _normalizePath(dest);
  const promise = client.postJSON("/api/fs/copy", { src: sp, dst: dp })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "copyfile", sp); });
  return _callbackWrapper(promise, callback);
}

function chmod(path, mode, callback) {
  const p = _normalizePath(path);
  const modeStr = typeof mode === "number" ? "0" + mode.toString(8).slice(-3) : String(mode);
  const promise = client.postJSON("/api/fs/chmod", { path: p, mode: modeStr })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "chmod", p); });
  return _callbackWrapper(promise, callback);
}

function symlink(target, path, type, callback) {
  if (typeof type === "function") { callback = type; type = undefined; }
  const tp = _normalizePath(target);
  const lp = _normalizePath(path);
  const promise = client.postJSON("/api/fs/symlink", { target: tp, link: lp })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "symlink", lp); });
  return _callbackWrapper(promise, callback);
}

function readlink(path, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const promise = client.getJSON(`/api/fs/readlink?path=${encodeURIComponent(p)}`)
    .then((result) => result.target)
    .catch((err) => { throw _errFromHttp(err, "readlink", p); });
  return _callbackWrapper(promise, callback);
}

realpath.native = function(path, options, callback) {
  return realpath(path, options, callback);
};

function realpath(path, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const promise = client.postJSON("/api/fs/realpath", { path: p }).then((r) => r.realpath)
    .catch((err) => { throw _errFromHttp(err, "realpath", p); });
  return _callbackWrapper(promise, callback);
}

function exists(path, callback) {
  const p = _normalizePath(path);
  client.getJSON(`/api/fs/stat?path=${encodeURIComponent(p)}`)
    .then(() => { if (callback) callback(true); })
    .catch(() => { if (callback) callback(false); });
}

function access(path, mode, callback) {
  if (typeof mode === "function") { callback = mode; mode = constants.F_OK; }
  const p = _normalizePath(path);
  const modeStr = typeof mode === "number" ? mode.toString(8) : String(mode);
  const promise = client._asyncRequest("GET", `/api/fs/access?path=${encodeURIComponent(p)}&mode=${modeStr}`)
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "access", p); });
  return _callbackWrapper(promise, callback);
}

function truncate(path, len, callback) {
  if (typeof len === "function") { callback = len; len = 0; }
  const p = _normalizePath(path);
  const promise = client.postJSON("/api/fs/truncate", { path: p, len: len || 0 })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "truncate", p); });
  return _callbackWrapper(promise, callback);
}

function touch(path, mode, callback) {
  if (typeof mode === "function") { callback = mode; mode = null; }
  const p = _normalizePath(path);
  const promise = client.postJSON("/api/fs/touch", { path: p, mode })
    .catch((err) => { throw _errFromHttp(err, "touch", p); });
  return _callbackWrapper(promise, callback);
}

function chown(path, uid, gid, callback) {
  const p = _normalizePath(path);
  const promise = client.postJSON("/api/fs/chown", { path: p, uid, gid, follow: true })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "chown", p); });
  return _callbackWrapper(promise, callback);
}

function lchown(path, uid, gid, callback) {
  const p = _normalizePath(path);
  const promise = client.postJSON("/api/fs/chown", { path: p, uid, gid, follow: false })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "lchown", p); });
  return _callbackWrapper(promise, callback);
}

function utimes(path, atime, mtime, callback) {
  const p = _normalizePath(path);
  const atMs = _timeToMs(atime);
  const mtMs = _timeToMs(mtime);
  const promise = client.postJSON("/api/fs/utimes", { path: p, atime: atMs, mtime: mtMs, follow: true })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "utimes", p); });
  return _callbackWrapper(promise, callback);
}

function link(existingPath, newPath, callback) {
  const ep = _normalizePath(existingPath);
  const np = _normalizePath(newPath);
  const promise = client.postJSON("/api/fs/link", { existing: ep, newpath: np })
    .then(() => {})
    .catch((err) => { throw _errFromHttp(err, "link", ep); });
  return _callbackWrapper(promise, callback);
}

function mkdtemp(prefix, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(prefix);
  const promise = client.postJSON("/api/fs/mkdtemp", { prefix: p }).then((r) => r.path)
    .catch((err) => { throw _errFromHttp(err, "mkdtemp", p); });
  return _callbackWrapper(promise, callback);
}

// ─── File descriptor operations ──────────────────────────
function open(path, flags, mode, callback) {
  if (typeof mode === "function") { callback = mode; mode = 0o666; }
  const p = _normalizePath(path);
  // Async open → RemoteFdEntry (real server fd). The fd is issued locally now;
  // the server fd is opened lazily on first read/write (_ensureOpen) so open()
  // itself is a pure-local operation matching Node's "open resolves fast" feel.
  const promise = _fdTable.open(p, flags, mode);
  return _callbackWrapper(promise, callback);
}

function read(fd, buffer, offset, length, position, callback) {
  if (typeof position === "function") { callback = position; position = null; }
  const promise = _fdTable.read(fd, buffer, offset, length, position);
  // Node's fs.read callback signature is (err, bytesRead, buffer) — three
  // positional args. The buffer is the SAME buffer passed in (now filled).
  return _callbackWrapperSpread(
    promise.then((bytesRead) => ({ bytesRead, buffer })),
    callback,
    ["bytesRead", "buffer"]
  );
}

function write(fd, data, offset, length, position, callback) {
  // Handle overloads:
  // write(fd, buffer, offset, length, position, callback)
  // write(fd, string, position, encoding, callback)
  // write(fd, buffer, offset, length, callback)
  // write(fd, string, callback)
  if (typeof position === "function") { callback = position; position = null; }
  if (typeof length === "function") { callback = length; length = undefined; }
  if (typeof offset === "function") { callback = offset; offset = 0; }

  let buf, writeOffset, writeLength, writePos;

  if (typeof data === "string") {
    // String write: offset = position, length = encoding
    buf = Buffer.from(data, typeof length === "string" ? length : "utf8");
    writeOffset = 0;
    writeLength = buf.length;
    writePos = offset != null ? offset : null;
  } else {
    buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    writeOffset = offset || 0;
    writeLength = length != null ? length : buf.length;
    writePos = position != null ? position : null;
  }

  const promise = _fdTable.write(fd, buf, writeOffset, writeLength, writePos);
  // Node's fs.write callback signature is (err, bytesWritten, buffer) — three
  // positional args. The buffer is the buffer passed in (for buffer writes) or
  // the string passed in (Node returns the original input for string writes).
  return _callbackWrapperSpread(
    promise.then((bytesWritten) => ({ bytesWritten, buffer: data })),
    callback,
    ["bytesWritten", "buffer"]
  );
}

function close(fd, callback) {
  const promise = _fdTable.close(fd);
  return _callbackWrapper(promise, callback);
}

function fstat(fd, callback) {
  const entry = _fdTable.get(fd);
  const promise = entry.stat();
  return _callbackWrapper(promise, callback);
}

function fsync(fd, callback) {
  const entry = _fdTable.get(fd);
  const promise = entry.flush();
  return _callbackWrapper(promise, callback);
}

function ftruncate(fd, len, callback) {
  if (typeof len === "function") { callback = len; len = 0; }
  const entry = _fdTable.get(fd);
  const promise = entry.type === "async"
    ? entry.ftruncate(len || 0)
    : (async () => {
        await entry._ensureLoaded();
        if (len < entry._content.length) {
          entry._content = entry._content.subarray(0, len);
        } else if (len > entry._content.length) {
          const newBuf = Buffer.alloc(len);
          entry._content.copy(newBuf);
          entry._content = newBuf;
        }
        entry._dirty = true;
      })();
  return _callbackWrapper(promise, callback);
}

function fchmod(fd, mode, callback) {
  const entry = _fdTable.get(fd);
  const promise = entry.type === "async"
    ? entry.fchmod(typeof mode === "number" ? mode : parseInt(String(mode), 8))
    : (async () => {
        const modeStr = typeof mode === "number" ? "0" + mode.toString(8).slice(-3) : String(mode);
        await client.postJSON("/api/fs/chmod", { path: entry.path, mode: modeStr });
      })();
  return _callbackWrapper(promise.then(() => {}), callback);
}

function fchown(fd, uid, gid, callback) {
  const entry = _fdTable.get(fd);
  const promise = entry.type === "async"
    ? entry.fchown(uid, gid)
    : client.postJSON("/api/fs/chown", { path: entry.path, uid, gid, follow: true }).then(() => {});
  return _callbackWrapper(promise, callback);
}

function futimes(fd, atime, mtime, callback) {
  const entry = _fdTable.get(fd);
  if (entry.type === "async") {
    return _callbackWrapper(entry.futimes(_timeToMs(atime), _timeToMs(mtime)), callback);
  }
  return utimes(entry.path, atime, mtime, callback);
}

function writev(fd, buffers, position, callback) {
  if (typeof position === "function") { callback = position; position = null; }
  const entry = _fdTable.get(fd);
  const promise = (async () => {
    let total = 0;
    for (const buf of buffers) {
      const written = await entry.write(buf, 0, buf.length, position);
      total += written;
      if (position != null) position += written;
    }
    return { bytesWritten: total, buffers };
  })();
  // Node's fs.writev callback is (err, bytesWritten, buffers) — three args.
  return _callbackWrapperSpread(promise, callback, ["bytesWritten", "buffers"]);
}

// readv: scatter read from an fd into multiple buffers. Node's callback is
// (err, bytesRead, buffers). Each buffer is filled in turn; position advances
// only when an explicit position is given (otherwise the fd's cursor moves).
function readv(fd, buffers, position, callback) {
  if (typeof position === "function") { callback = position; position = null; }
  const entry = _fdTable.get(fd);
  const promise = (async () => {
    let total = 0;
    for (const buf of buffers) {
      const bytesRead = await entry.read(buf, 0, buf.length, position);
      total += bytesRead;
      if (position != null) position += bytesRead;
      if (bytesRead < buf.length) break; // EOF mid-vector
    }
    return { bytesRead: total, buffers };
  })();
  return _callbackWrapperSpread(promise, callback, ["bytesRead", "buffers"]);
}

// ─── openAsBlob ──────────────────────────────────────────
// Node 19+: fs.openAsBlob(path) → Promise<Blob>. Reads the file fully and
// wraps it in a Blob. `options.type` sets the MIME type (default empty).
function openAsBlob(path, options) {
  const p = _normalizePath(path);
  const opts = options || {};
  const type = opts.type || "";
  return client.getBuffer(`/api/fs/read?path=${encodeURIComponent(p)}`)
    .then((buf) => new Blob([buf], { type }))
    .catch((err) => { throw _errFromHttp(err, "read", p); });
}

// ─── opendir ─────────────────────────────────────────────
function opendir(path, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const p = _normalizePath(path);
  const opts = options || {};
  const withFileTypes = opts.withFileTypes === true;
  const promise = client.getJSON(`/api/fs/list?path=${encodeURIComponent(p)}`)
    .then((entries) => {
      // Build Dirent-shaped entries so Dir.read returns real Dirents when
      // withFileTypes is set; otherwise {name}-only (Node returns Dirent
      // regardless, but callers mostly use .name when not withFileTypes).
      const items = entries.map((e) => {
        const d = new Dirent(e.name, e.type, p);
        return withFileTypes ? d : { name: e.name, ...d };
      });
      return new Dir(p, items);
    })
    .catch((err) => { throw _errFromHttp(err, "opendir", p); });
  return _callbackWrapper(promise, callback);
}

// ─── glob ─────────────────────────────────────────────────
// fs.glob(pattern[, options], callback) — callback-style (err, matches),
// returns undefined (like fs.readFile). Matching runs server-side; exclude,
// includeHidden, deep, withFileTypes, caseSensitive are applied client-side.
function glob(pattern, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const opts = options || {};
  const withFileTypes = opts.withFileTypes === true;
  const promise = globHelper.fetchMatches(pattern, opts)
    .then((matches) => globHelper.buildResult(matches, withFileTypes));
  return _callbackWrapper(promise, callback);
}

// ─── cp (recursive copy) ─────────────────────────────────
function cp(src, dest, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const sp = _normalizePath(src);
  const dp = _normalizePath(dest);
  const opts = options || {};
  // Real fs.cp defaults recursive to FALSE (only copies a single file unless
  // recursive:true). The server /api/fs/copy auto-recurses for dirs, so for
  // non-recursive we must reject dirs client-side.
  const recursive = opts.recursive === true;

  const promise = (async () => {
    const srcStat = await client.getJSON(`/api/fs/stat?path=${encodeURIComponent(sp)}&follow=false`);
    if (srcStat.type === "dir" && !recursive) {
      const err = new Error(`EISDIR: illegal operation on a directory, copy '${sp}'`);
      err.code = "EISDIR"; err.errno = -21; err.syscall = "copy"; err.path = sp;
      throw err;
    }
    if (typeof opts.filter === "function") {
      // filter(src, dest) → boolean | Promise<boolean>. Await handles both.
      if (!(await opts.filter(sp, dp))) return;
      await _cpFiltered(sp, dp, opts);
    } else {
      await client.postJSON("/api/fs/copy", { src: sp, dst: dp });
    }
  })().catch((err) => { throw _errFromHttp(err, "cp", sp); });

  return _callbackWrapper(promise, callback);
}

// Helper: filtered recursive copy (walks tree, applies filter per entry as
// (src, dest) — matching Node's fs.cp filter signature).
async function _cpFiltered(src, dst, opts) {
  const filter = opts.filter;
  const entries = await client.getJSON(`/api/fs/list?path=${encodeURIComponent(src)}`);

  // Ensure dst exists (the root already passed the filter above).
  await client.postJSON("/api/fs/mkdir", { path: dst, recursive: true });

  for (const entry of entries) {
    const srcPath = src + "/" + entry.name;
    const dstPath = dst + "/" + entry.name;

    if (!(await filter(srcPath, dstPath))) continue;

    if (entry.type === "dir") {
      await _cpFiltered(srcPath, dstPath, opts);
    } else {
      await client.postJSON("/api/fs/copy", { src: srcPath, dst: dstPath });
    }
  }
}

// ─── Watchers (best-effort, not fully implemented) ───────
function watch(filename, options, listener) {
  return _watch(filename, options, listener);
}

function watchFile(filename, options, listener) {
  return _watchFile(filename, options, listener);
}

function unwatchFile(filename, listener) {
  return _unwatchFile(filename, listener);
}

// ─── Streams ─────────────────────────────────────────────
function createReadStream(filePath, options) {
  return new ReadStream(filePath, options);
}

function createWriteStream(filePath, options) {
  return new WriteStream(filePath, options);
}

module.exports = {
  // Core async (callback-style, also return promises)
  readFile, writeFile, appendFile, readdir,
  stat, lstat, fstat,
  statfs: (p, o, cb) => {
    if (typeof o === "function") { cb = o; o = {}; }
    const path = _normalizePath(p);
    const promise = client.getJSON(`/api/fs/statfs?path=${encodeURIComponent(path)}`)
      .catch((err) => { throw _errFromHttp(err, "statfs", path); });
    return _callbackWrapper(promise, cb);
  },
  mkdir, rmdir, rm, unlink, rename, copyFile, cp,
  chmod, lchmod: (p, m, cb) => chmod(p, m, cb), lchown,
  chown, utimes, lutimes: (p, a, m, cb) => utimes(p, a, m, cb),
  truncate, touch,
  symlink, readlink, link, realpath,
  exists, access, mkdtemp, opendir,
  openAsBlob,
  glob,
  // FD operations
  open, read, write, close, writev, readv,
  fsync, fdatasync: (fd, cb) => fsync(fd, cb), ftruncate, fchmod, fchown, futimes,
  // Streams
  createReadStream, createWriteStream,
  // Watchers
  watch, watchFile, unwatchFile,
  // Constants
  constants,
  // Stats helper
  _toStats: toStats,
  // Internal
  _fdTable: _fdTable,
  _configure: (opts) => {
    if (opts.fdTable) _fdTable = opts.fdTable;
  },
};