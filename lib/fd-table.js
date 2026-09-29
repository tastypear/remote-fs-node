"use strict";

const client = require("./client");
const { Stats, Dirent, Dir, toStats, toDirent, parseMode } = require("./stats");
const { flagsToString, flagsToNumeric } = require("./flags");
const constants = require("./constants");

// ─── BufferedFdEntry (sync open path) ─────────────────────────────────────
// Loads the whole file into _content on first access. This is the only viable
// sync strategy: readSync/writeSync slice the in-memory Buffer with zero forks.
// The size guard (openSync) rejects oversized files to bound memory.
class BufferedFdEntry {
  constructor(path, flags, mode) {
    this.type = "sync";
    this.path = path;
    this.flags = flagsToString(flags);
    this.mode = mode;
    this.position = 0;
    this._content = null;   // Buffer, lazy-loaded
    this._dirty = false;
    this._isWrite = false;
    this._isRead = false;
    this._isAppend = false;
    this._isTrunc = false;
    this._isExcl = false;

    const f = this.flags.toLowerCase();
    if (f.startsWith("r")) this._isRead = true;
    if (f.includes("w")) { this._isWrite = true; this._isTrunc = true; }
    if (f.includes("a")) { this._isAppend = true; this._isWrite = true; }
    if (f.includes("+")) { this._isWrite = true; this._isRead = true; }
    if (f.includes("x")) this._isExcl = true; // wx/wx+/ax — O_EXCL
  }

  async _ensureLoaded() {
    if (this._content === null) {
      if (this._isExcl) {
        try {
          await client.getJSON(`/api/fs/stat?path=${encodeURIComponent(this.path)}&follow=false`);
          const err = new Error(`EEXIST: file already exists, open '${this.path}'`);
          err.code = "EEXIST"; err.errno = -17; err.syscall = "open"; err.path = this.path;
          throw err;
        } catch (err) {
          if (err.code === "EEXIST") throw err;
        }
        this._content = Buffer.alloc(0);
        this._dirty = true;
        return this._content;
      }

      if (this._isTrunc) {
        this._content = Buffer.alloc(0);
        this._dirty = true;
      } else {
        try {
          this._content = await client.getBuffer(
            `/api/fs/read?path=${encodeURIComponent(this.path)}`
          );
        } catch (err) {
          if (err.statusCode === 404 && this._isWrite && !this._isRead) {
            this._content = Buffer.alloc(0);
          } else {
            const e = new Error(`ENOENT: no such file or directory, open '${this.path}'`);
            e.code = "ENOENT"; e.errno = -2; e.syscall = "open"; e.path = this.path;
            throw e;
          }
        }
      }
      if (this._isAppend) {
        this.position = this._content.length;
      }
    }
    return this._content;
  }

  async read(buffer, offset, length, position) {
    const content = await this._ensureLoaded();
    const pos = position != null ? position : this.position;
    const available = Math.max(0, content.length - pos);
    const toRead = Math.min(length, available);
    if (toRead > 0) {
      content.copy(buffer, offset, pos, pos + toRead);
    }
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
    if (this._dirty && this._content !== null) {
      await client.putBuffer(
        `/api/fs/write?path=${encodeURIComponent(this.path)}`,
        this._content
      );
      this._dirty = false;
    }
  }

  async stat() {
    const info = await client.getJSON(
      `/api/fs/stat?path=${encodeURIComponent(this.path)}`
    );
    return toStats(info);
  }
}

// ─── RemoteFdEntry (async open path — real server fd, SFTP parity) ───────
// Holds a server-side fd id; read/write are O(1) ranged os.pread/os.pwrite
// against the server. No whole-file _content buffer — peak client memory is
// bounded by the read/write length, not the file size.
class RemoteFdEntry {
  constructor(path, flags, mode) {
    this.type = "async";
    this.path = path;
    this.flags = flagsToString(flags);
    this.numericFlags = flagsToNumeric(flags);
    this.mode = mode;
    this.position = 0;
    this.serverFd = null;
    this.size = 0;
    this._closed = false;
  }

  async _ensureOpen() {
    if (this._closed) {
      const e = new Error(`EBADF: bad file descriptor, fd closed '${this.path}'`);
      e.code = "EBADF"; e.errno = -9; e.syscall = "open"; e.path = this.path;
      throw e;
    }
    if (this.serverFd === null) {
      try {
        const r = await client.postJSON("/api/fs/fd/open", {
          path: this.path,
          flags: this.numericFlags,
          mode: this.mode || 0o666,
        });
        this.serverFd = r.fd;
        this.size = r.size;
      } catch (err) {
        // Map HTTP errors to fs error codes for ENOENT/EEXIST parity.
        if (err.statusCode === 404) {
          const e = new Error(`ENOENT: no such file or directory, open '${this.path}'`);
          e.code = "ENOENT"; e.errno = -2; e.syscall = "open"; e.path = this.path;
          throw e;
        }
        if (err.statusCode === 409) {
          const e = new Error(`EEXIST: file already exists, open '${this.path}'`);
          e.code = "EEXIST"; e.errno = -17; e.syscall = "open"; e.path = this.path;
          throw e;
        }
        throw err;
      }
    }
  }

  async read(buffer, offset, length, position) {
    await this._ensureOpen();
    const pos = position != null ? position : this.position;
    const buf = await client.getBuffer(
      `/api/fs/fd/read?fd=${this.serverFd}&offset=${pos}&length=${length}`
    );
    const bytesRead = buf.length;
    if (bytesRead > 0) buf.copy(buffer, offset);
    if (position == null) this.position += bytesRead;
    return bytesRead;
  }

  async write(data, offset, length, position) {
    await this._ensureOpen();
    const pos = position != null ? position : -1; // -1 → use fd position
    const chunk = data.subarray(offset, offset + length);
    const r = await client.putBuffer(
      `/api/fs/fd/write?fd=${this.serverFd}&offset=${pos}`,
      chunk
    );
    if (position == null) this.position += r.bytes;
    return r.bytes;
  }

  async flush() {
    if (this.serverFd === null) return;
    await client.postJSON("/api/fs/fd/fsync", { fd: this.serverFd });
  }

  async stat() {
    await this._ensureOpen();
    const info = await client.getJSON(`/api/fs/fd/fstat?fd=${this.serverFd}`);
    return toStats(info);
  }

  async ftruncate(len) {
    await this._ensureOpen();
    await client.postJSON("/api/fs/fd/ftruncate", { fd: this.serverFd, len });
    this.size = len;
  }

  async fchmod(mode) {
    await this._ensureOpen();
    await client.postJSON("/api/fs/fd/fchmod", { fd: this.serverFd, mode });
  }

  async fchown(uid, gid) {
    await this._ensureOpen();
    await client.postJSON("/api/fs/fd/fchown", { fd: this.serverFd, uid, gid });
  }

  async futimes(atime, mtime) {
    await this._ensureOpen();
    await client.postJSON("/api/fs/fd/futimes", { fd: this.serverFd, atime, mtime });
  }

  async close() {
    if (this._closed || this.serverFd === null) {
      this._closed = true;
      return;
    }
    this._closed = true;
    try {
      await client.postJSON("/api/fs/fd/close", { fd: this.serverFd });
    } catch (_) {
      // Server may have already reaped the fd (TTL); close is best-effort.
    }
    this.serverFd = null;
  }
}

class FdTable {
  constructor() {
    this._nextFd = 10;
    this._entries = new Map();
  }

  // Async open → RemoteFdEntry (real server fd, ranged read/write).
  async open(path, flags, mode) {
    const entry = new RemoteFdEntry(path, flags, mode);
    const fd = this._nextFd++;
    this._entries.set(fd, entry);
    return fd;
  }

  // Sync open → BufferedFdEntry (whole-file preload, in-memory slicing).
  openSync(path, flags, mode) {
    const entry = new BufferedFdEntry(path, flags, mode);
    const fd = this._nextFd++;
    this._entries.set(fd, entry);
    return fd;
  }

  get(fd) {
    const entry = this._entries.get(fd);
    if (!entry) {
      const err = new Error(`EBADF: bad file descriptor, fd ${fd}`);
      err.code = "EBADF";
      err.errno = -9;
      throw err;
    }
    return entry;
  }

  has(fd) {
    return this._entries.has(fd);
  }

  async close(fd) {
    const entry = this.get(fd);
    // BufferedFdEntry.flush() PUTs dirty content; RemoteFdEntry.close() closes
    // the server fd. Both expose close()-compatible semantics.
    if (entry.type === "async") {
      await entry.close();
    } else {
      await entry.flush();
    }
    this._entries.delete(fd);
  }

  async read(fd, buffer, offset, length, position) {
    const entry = this.get(fd);
    return entry.read(buffer, offset, length, position);
  }

  async write(fd, data, offset, length, position) {
    const entry = this.get(fd);
    return entry.write(data, offset, length, position);
  }
}

// Single shared global fd table — used by BOTH the async API (fs.open →
// RemoteFdEntry) and the sync API (fs.openSync → BufferedFdEntry). binding.js
// also routes here, so all three layers share one fd namespace. An fd from
// openSync can be passed to fs.fstat (async) and vice versa.
const globalFdTable = new FdTable();

module.exports = {
  FdTable, globalFdTable,
  BufferedFdEntry, RemoteFdEntry,
  Stats, Dirent, Dir, toStats, toDirent, parseMode,
};
