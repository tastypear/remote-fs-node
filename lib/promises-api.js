"use strict";

const asyncApi = require("./async-api");
const client = require("./client");
const { globalFdTable, Dirent } = require("./fd-table");
const { ReadStream, WriteStream } = require("./streams");
const globHelper = require("./glob");

// fs.promises — all methods return promises, no callbacks needed.
function _promise(fn) {
  return function (...args) {
    return new Promise((resolve, reject) => {
      fn.apply(null, [...args, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }]);
    });
  };
}

const promises = {
  readFile: _promise(asyncApi.readFile),
  writeFile: _promise(asyncApi.writeFile),
  appendFile: _promise(asyncApi.appendFile),
  readdir: _promise(asyncApi.readdir),
  stat: _promise(asyncApi.stat),
  lstat: _promise(asyncApi.lstat),
  statfs: _promise(asyncApi.statfs),
  mkdir: _promise(asyncApi.mkdir),
  rmdir: _promise(asyncApi.rmdir),
  rm: _promise(asyncApi.rm),
  unlink: _promise(asyncApi.unlink),
  rename: _promise(asyncApi.rename),
  copyFile: _promise(asyncApi.copyFile),
  cp: _promise(asyncApi.cp),
  chmod: _promise(asyncApi.chmod),
  lchmod: _promise(asyncApi.lchmod),
  chown: _promise(asyncApi.chown),
  lchown: _promise(asyncApi.lchown),
  utimes: _promise(asyncApi.utimes),
  lutimes: _promise(asyncApi.lutimes),
  truncate: _promise(asyncApi.truncate),
  symlink: _promise(asyncApi.symlink),
  readlink: _promise(asyncApi.readlink),
  link: _promise(asyncApi.link),
  realpath: _promise(asyncApi.realpath),
  access: _promise(asyncApi.access),
  mkdtemp: _promise(asyncApi.mkdtemp),
  opendir: _promise(asyncApi.opendir),
  // fs.promises.glob(pattern[, options]) → AsyncIterableIterator<string|Dirent>.
  // Returns the iterator synchronously (matching Node's contract); the first
  // next() triggers the server fetch. return() ends early (break/AbortSignal).
  glob(pattern, options) {
    const opts = options || {};
    const withFileTypes = opts.withFileTypes === true;
    let fetchPromise = null;
    let matches = null;
    let i = 0;
    let done = false;
    const ensure = () => {
      if (!fetchPromise) fetchPromise = globHelper.fetchMatches(pattern, opts);
      return fetchPromise;
    };
    const toValue = (m) => {
      if (!withFileTypes) return m.path;
      const sep = m.path.lastIndexOf("/");
      const name = sep >= 0 ? m.path.slice(sep + 1) : m.path;
      const parentPath = sep >= 0 ? m.path.slice(0, sep) : ".";
      return new Dirent(name, m.type, parentPath);
    };
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        return ensure().then((m) => {
          if (matches === null) matches = m;
          if (done || i >= matches.length) { done = true; return { value: undefined, done: true }; }
          return { value: toValue(matches[i++]), done: false };
        });
      },
      return() {
        done = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  },
  // fs.promises.mkdtempDisposable(prefix[, options]) → {path, remove, [Symbol.asyncDispose]}.
  // For `await using dir = await fs.promises.mkdtempDisposable(...)`.
  mkdtempDisposable(prefix, options) {
    return this.mkdtemp(prefix, options).then((dirPath) => {
      let removed = false;
      const obj = Object.create(null);
      obj.path = dirPath;
      obj.remove = async function remove() {
        if (removed) return;
        removed = true;
        try { await promises.rm(dirPath, { recursive: true, force: true }); } catch (_) {}
      };
      obj[Symbol.asyncDispose] = obj.remove;
      return obj;
    });
  },
  // fs.promises.watch(filename, options) → AsyncIterator<{eventType, filename}>.
  // Node 15+. Wraps the existing FSWatcher's 'change' events. The iterator
  // closes the watcher on return()/throw() or when the AbortSignal aborts.
  watch(filename, options) {
    const { FSWatcher } = require("./watcher");
    const opts = options || {};
    const watcher = new FSWatcher(filename, opts);
    const queue = [];
    let resolveWait = null;
    let done = false;

    watcher.on("change", (eventType, filename) => {
      const item = { eventType, filename };
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r({ value: item, done: false });
      } else {
        queue.push(item);
      }
    });
    watcher.on("close", () => {
      done = true;
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r({ value: undefined, done: true });
      }
    });

    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift(), done: false });
            }
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => { resolveWait = resolve; });
          },
          return() {
            done = true;
            try { watcher.close(); } catch (_) {}
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  },
  // FD ops
  open(path, flags, mode) {
    return new Promise((resolve, reject) => {
      asyncApi.open(path, flags, mode, (err, fd) => {
        if (err) reject(err);
        else resolve(new promises.FileHandle(fd));
      });
    });
  },
  // fs.promises.fstat(fd) — Node exposes this directly (not just via FileHandle).
  fstat: _promise(asyncApi.fstat),
  // fs.promises.read(fd, buf, off, len, pos) → {bytesRead, buffer}
  read(fd, buffer, offset, length, position) {
    return new Promise((resolve, reject) => {
      asyncApi.read(fd, buffer, offset, length, position, (err, bytesRead, buf) => {
        if (err) reject(err);
        else resolve({ bytesRead, buffer: buf });
      });
    });
  },
  // fs.promises.write(fd, ...) → {bytesWritten, buffer}
  write(fd, data, offset, length, position) {
    return new Promise((resolve, reject) => {
      const args = Array.from(arguments);
      // Detect string overload: write(fd, string, position, encoding)
      if (typeof data === "string") {
        asyncApi.write(fd, data, offset, length, (err, bytesWritten, buffer) => {
          if (err) reject(err);
          else resolve({ bytesWritten, buffer });
        });
      } else {
        asyncApi.write(fd, data, offset, length, position, (err, bytesWritten, buffer) => {
          if (err) reject(err);
          else resolve({ bytesWritten, buffer });
        });
      }
    });
  },
  fsync: _promise(asyncApi.fsync),
  fdatasync: _promise(asyncApi.fdatasync),
  ftruncate: _promise(asyncApi.ftruncate),
  fchmod: _promise(asyncApi.fchmod),
  // readv/writev return {bytesRead|bytesWritten, buffers}
  readv(fd, buffers, position) {
    return new Promise((resolve, reject) => {
      asyncApi.readv(fd, buffers, position, (err, bytesRead, buffers) => {
        if (err) reject(err);
        else resolve({ bytesRead, buffers });
      });
    });
  },
  writev(fd, buffers, position) {
    return new Promise((resolve, reject) => {
      asyncApi.writev(fd, buffers, position, (err, bytesWritten, buffers) => {
        if (err) reject(err);
        else resolve({ bytesWritten, buffers });
      });
    });
  },
  fchown: _promise(asyncApi.fchown),
  futimes: _promise(asyncApi.futimes),

  // FileHandle class (simplified)
  FileHandle: class FileHandle {
    constructor(fd) {
      this.fd = fd;
    }
    read(buffer, offset, length, position) {
      return new Promise((resolve, reject) => {
        asyncApi.read(this.fd, buffer, offset, length, position, (err, bytesRead, buf) => {
          if (err) reject(err);
          else resolve({ bytesRead, buffer: buf });
        });
      });
    }
    write(data, offset, length, position) {
      return new Promise((resolve, reject) => {
        if (typeof data === "string") {
          // String overload: write(fd, string, position, encoding)
          const buf = Buffer.from(data, (typeof length === "string" ? length : "utf8"));
          const pos = offset != null ? offset : null;
          asyncApi.write(this.fd, buf, 0, buf.length, pos, (err, bytesWritten, buffer) => {
            if (err) reject(err);
            else resolve({ bytesWritten, buffer: data });
          });
        } else {
          const off = offset || 0;
          const len = length != null ? length : data.length;
          const pos = position != null ? position : null;
          asyncApi.write(this.fd, data, off, len, pos, (err, bytesWritten, buffer) => {
            if (err) reject(err);
            else resolve({ bytesWritten, buffer: data });
          });
        }
      });
    }
    close() {
      return _promise(asyncApi.close)(this.fd);
    }
    stat() {
      return _promise(asyncApi.fstat)(this.fd);
    }
    sync() {
      return _promise(asyncApi.fsync)(this.fd);
    }
    truncate(len) {
      return _promise(asyncApi.ftruncate)(this.fd, len);
    }
    chmod(mode) {
      return _promise(asyncApi.fchmod)(this.fd, mode);
    }
    chown(uid, gid) {
      return _promise(asyncApi.fchown)(this.fd, uid, gid);
    }
    utimes(atime, mtime) {
      return _promise(asyncApi.futimes)(this.fd, atime, mtime);
    }
    // Node v22+ Explicit Resource Management: `await using h = await open(...)`.
    [Symbol.asyncDispose]() { return this.close(); }
    getAsyncId() { return this.fd; }
    datasync() { return _promise(asyncApi.fdatasync)(this.fd); }
    readv(buffers, position) {
      return new Promise((resolve, reject) => {
        asyncApi.readv(this.fd, buffers, position, (err, bytesRead, bufs) => {
          if (err) reject(err); else resolve({ bytesRead, buffers: bufs });
        });
      });
    }
    writev(buffers, position) {
      return new Promise((resolve, reject) => {
        asyncApi.writev(this.fd, buffers, position, (err, bytesWritten, bufs) => {
          if (err) reject(err); else resolve({ bytesWritten, buffers: bufs });
        });
      });
    }
    // readFile/writeFile/appendFile: type-aware. RemoteFdEntry reads via ranged
    // fd-read (chunked, no whole-file _content); BufferedFdEntry uses its
    // in-memory _content so unflushed writes are visible.
    readFile(options) {
      const entry = globalFdTable.get(this.fd);
      const opts = typeof options === "string" ? { encoding: options } : (options || {});
      if (entry.type === "async") {
        return (async () => {
          await entry._ensureOpen();
          const chunks = [];
          let pos = 0;
          while (true) {
            const buf = await client.getBuffer(`/api/fs/fd/read?fd=${entry.serverFd}&offset=${pos}&length=65536`);
            if (buf.length === 0) break;
            chunks.push(buf);
            pos += buf.length;
          }
          const full = Buffer.concat(chunks);
          if (opts.encoding) return full.toString(opts.encoding);
          return full;
        })();
      }
      return entry._ensureLoaded().then((content) => {
        if (opts.encoding) return content.toString(opts.encoding);
        return Buffer.from(content);
      });
    }
    writeFile(data, options) {
      const entry = globalFdTable.get(this.fd);
      const opts = typeof options === "string" ? { encoding: options } : (options || {});
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), opts.encoding || "utf8");
      if (entry.type === "async") {
        return (async () => {
          await entry._ensureOpen();
          // Truncate to 0 first so writeFile replaces content (not appends).
          await client.postJSON("/api/fs/fd/ftruncate", { fd: entry.serverFd, len: 0 });
          const r = await client.putBuffer(`/api/fs/fd/write?fd=${entry.serverFd}&offset=0`, buf);
          entry.position = r.bytes;
          entry.size = r.bytes;
        })();
      }
      return (async () => {
        await entry._ensureLoaded();
        entry._content = Buffer.from(buf);
        entry._dirty = true;
        entry.position = buf.length;
      })();
    }
    appendFile(data, options) {
      const entry = globalFdTable.get(this.fd);
      const opts = typeof options === "string" ? { encoding: options } : (options || {});
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), opts.encoding || "utf8");
      if (entry.type === "async") {
        return (async () => {
          await entry._ensureOpen();
          // Write at the current end-of-file. os.pwrite (offset>=0) doesn't
          // move the fd position, so we can't rely on offset=-1 + os.write —
          // the fd position is stale after earlier pwrite calls. Stat to get
          // the real EOF, then pwrite there.
          const info = await client.getJSON(`/api/fs/fd/fstat?fd=${entry.serverFd}`);
          const r = await client.putBuffer(`/api/fs/fd/write?fd=${entry.serverFd}&offset=${info.size}`, buf);
          entry.position = info.size + r.bytes;
          entry.size = info.size + r.bytes;
        })();
      }
      return (async () => {
        await entry._ensureLoaded();
        const combined = Buffer.alloc(entry._content.length + buf.length);
        entry._content.copy(combined);
        buf.copy(combined, entry._content.length);
        entry._content = combined;
        entry._dirty = true;
        entry.position = combined.length;
      })();
    }
    // createReadStream/createWriteStream are path-backed approximations (the fd
    // and path share content for read handles; dirty write handles flush on
    // close, so a stream opened before close reads pre-flush server content).
    createReadStream(options) {
      const entry = globalFdTable.get(this.fd);
      return new ReadStream(entry.path, options);
    }
    createWriteStream(options) {
      const entry = globalFdTable.get(this.fd);
      return new WriteStream(entry.path, options);
    }
    // readLines: yields lines via readline over the file's content.
    readLines(options) {
      const readline = require("readline");
      const opts = options || {};
      return readline.createInterface({
        input: this.createReadStream(opts),
        crlfDelay: opts.crlfDelay !== undefined ? opts.crlfDelay : Infinity,
      });
    }
    // readableWebStream: WHATWG ReadableStream of Uint8Array chunks.
    readableWebStream(options) {
      const { Readable } = require("stream");
      return Readable.toWeb(this.createReadStream(options));
    }
  },
};

module.exports = promises;