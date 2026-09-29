"use strict";

const { Readable, Writable } = require("stream");
const client = require("./client");
const { httpToFsError } = require("./errors");
const { flagsToNumeric } = require("./flags");

function _normalizePath(p) {
  if (Buffer.isBuffer(p)) p = p.toString("utf8");
  p = String(p);
  // Normalize Windows backslashes to forward slashes for remote Linux server
  if (p.indexOf("\\") !== -1) p = p.split("\\").join("/");
  return p;
}

/**
 * ReadStream — mirrors Node's fs.ReadStream.
 * Inherits from stream.Readable so instanceof checks pass.
 */
class ReadStream extends Readable {
  constructor(path, options) {
    const opts = options || {};
    super(opts);

    this.path = _normalizePath(path);
    this._fd = null;
    this._bytesRead = 0;
    this._closed = false;
    this._start = opts.start || 0;
    this._end = opts.end != null ? opts.end : Infinity;
    this._autoClose = opts.autoClose !== false;
    this._res = null;      // HTTP response stream
    this._buffered = null;  // for range support
    this._fetching = false;

    // Start fetching in next tick (after potential 'data' listener)
    this._ready = false;
    process.nextTick(() => this._fetch());
  }

  async _fetch() {
    if (this._fetching || this._closed) return;
    this._fetching = true;

    try {
      const res = await client.getStream(
        `/api/fs/read?path=${encodeURIComponent(this.path)}`
      );
      if (this._closed) {
        res.destroy();
        return;
      }

      this._res = res;

      // Emit 'open' event
      this.emit("open", this._fd || 0);

      // If range requested, we need to buffer and slice
      // (HTTP server does not support Range headers)
      if (this._start > 0 || this._end !== Infinity) {
        this._buffered = [];
        let pos = 0;
        const startByte = this._start;
        const endByte = this._end;

        res.on("data", (chunk) => {
          if (this._closed) return;
          const chunkStart = pos;
          const chunkEnd = pos + chunk.length - 1;

          // Determine slice
          let sliceStart = Math.max(0, startByte - chunkStart);
          let sliceEnd = Math.min(chunk.length - 1, endByte - chunkStart);

          if (sliceEnd >= sliceStart) {
            const sliced = chunk.subarray(sliceStart, sliceEnd + 1);
            this._bytesRead += sliced.length;
            // Use push for backpressure
            if (!this.push(sliced)) {
              res.pause();
            }
          }

          pos += chunk.length;

          // If past end, we are done
          if (pos > endByte) {
            res.destroy();
            this.push(null);
          }
        });

        res.on("end", () => {
          if (!this._closed) {
            this.push(null);
            // autoClose on natural end (Node closes the fd when the stream ends
            // unless autoClose:false). super.destroy sets the destroyed flag and
            // emits 'close'; deferred so Readable's 'end' lands first.
            if (this._autoClose) {
              this._closed = true;
              if (this._res) { this._res.destroy(); this._res = null; }
              process.nextTick(() => { try { super.destroy(); } catch (_) {} });
            }
          }
        });

        res.on("error", (err) => {
          if (!this._closed) {
            this.emit("error", _errFromHttp(err, "read", this.path));
          }
        });

        // Handle backpressure resume
        this.on("drain", () => {
          if (this._res && !this._closed) {
            this._res.resume();
          }
        });

      } else {
        // No range: pipe directly with backpressure
        res.on("data", (chunk) => {
          if (this._closed) return;
          this._bytesRead += chunk.length;
          if (!this.push(chunk)) {
            res.pause();
          }
        });

        res.on("end", () => {
          if (!this._closed) {
            this.push(null);
            if (this._autoClose) {
              this._closed = true;
              if (this._res) { this._res.destroy(); this._res = null; }
              process.nextTick(() => { try { super.destroy(); } catch (_) {} });
            }
          }
        });

        res.on("error", (err) => {
          if (!this._closed) {
            this.emit("error", _errFromHttp(err, "read", this.path));
          }
        });

        // Handle backpressure resume
        this.on("drain", () => {
          if (this._res && !this._closed) {
            this._res.resume();
          }
        });
      }

    } catch (err) {
      if (!this._closed) {
        this.emit("error", _errFromHttp(err, "read", this.path));
      }
    } finally {
      this._fetching = false;
    }
  }

  _read() {
    // Data is pushed from the HTTP response stream.
    // _read is called by Readable when internal buffer needs more data.
    // We do nothing here — data flow is driven by res 'data' events.
    // If res was paused due to backpressure, resume it.
    if (this._res && this._res.isPaused()) {
      this._res.resume();
    }
  }

  close(cb) {
    if (this._closed) {
      if (cb) cb();
      return;
    }
    this._closed = true;
    if (this._res) {
      this._res.destroy();
      this._res = null;
    }
    this.push(null);
    // Let Readable finish draining, then emit close. super.destroy handles the
    // internal 'close' semantics (emits 'close' once, sets destroyed=true).
    try { super.destroy(); } catch (_) {}
    if (cb) cb();
    this.emit("close");
  }

  destroy(err) {
    if (this._closed) return this;
    this._closed = true;
    if (this._res) {
      this._res.destroy();
      this._res = null;
    }
    this.push(null);
    // super.destroy is the single source of 'error' (if err) and 'close' — it
    // also drives native AbortSignal abort (ABORT_ERR). No manual emit, to
    // avoid double-firing on signal abort.
    try { super.destroy(err); } catch (_) {}
    return this;
  }
}

class WriteStream extends Writable {
  constructor(path, options) {
    const opts = options || {};
    super(opts);

    this.path = _normalizePath(path);
    this.bytesWritten = 0;
    this._closed = false;
    this._serverFd = null;     // server fd id (lazily opened)
    this._fdPromise = null;     // in-flight open (dedupes concurrent _writev)
    this._mode = opts.mode || 0o666;
    this._flags = opts.flags || "w";
    this._numericFlags = flagsToNumeric(this._flags);
    this._start = opts.start || 0;
    this._autoClose = opts.autoClose !== false;
    this._flush = opts.flush === true;  // fsync before close (Node option)
    this._isAppend = String(this._flags).startsWith("a");

    // Emit 'open' asynchronously after the lazy server fd opens. We kick off
    // the open now so it overlaps with the first _write.
    this._ensureFd().then(() => {
      if (!this._closed) this.emit("open", this._serverFd);
    }).catch((err) => {
      // Defer error emission to _write/_final where Writable will surface it.
      this._openErr = err;
    });

    if (this._autoClose) {
      this.once("finish", () => {
        if (this._closed) return;
        this._closed = true;
        try { super.destroy(); } catch (_) {}
      });
    }
  }

  async _ensureFd() {
    if (this._serverFd !== null) return;
    if (this._fdPromise) return this._fdPromise;
    this._fdPromise = (async () => {
      const r = await client.postJSON("/api/fs/fd/open", {
        path: this.path,
        flags: this._numericFlags,
        mode: this._mode,
      });
      this._serverFd = r.fd;
    })();
    return this._fdPromise;
  }

  // _write: route through _writev so both paths share the batched pwrite.
  _write(chunk, encoding, callback) {
    this._writev([{ chunk }], callback);
  }

  async _writev(chunks, callback) {
    if (this._closed) { callback(new Error("stream closed")); return; }
    if (this._openErr) { callback(_errFromHttp(this._openErr, "write", this.path)); this._openErr = null; return; }
    try {
      await this._ensureFd();
      const buf = Buffer.concat(chunks.map((c) => c.chunk));
      // Append mode: write at current EOF (server O_APPEND would work too, but
      // we stat to get a concrete offset for bytesWritten accounting). For 'w'
      // mode the fd was O_TRUNC'd on open, so bytesWritten starts at 0.
      const offset = this._isAppend ? await this._eof() : (this._start + this.bytesWritten);
      const r = await client.putBuffer(
        `/api/fs/fd/write?fd=${this._serverFd}&offset=${offset}`, buf
      );
      this.bytesWritten += r.bytes;
      callback();
    } catch (err) {
      callback(_errFromHttp(err, "write", this.path));
    }
  }

  async _eof() {
    const info = await client.getJSON(`/api/fs/fd/fstat?fd=${this._serverFd}`);
    return info.size;
  }

  async _final(callback) {
    if (this._closed) { callback(); return; }
    if (this._openErr && this._serverFd === null) {
      callback(_errFromHttp(this._openErr, "write", this.path)); this._openErr = null; return;
    }
    try {
      await this._ensureFd();
      if (this._flush) {
        await client.postJSON("/api/fs/fd/fsync", { fd: this._serverFd });
      }
      if (this._autoClose && this._serverFd !== null) {
        await client.postJSON("/api/fs/fd/close", { fd: this._serverFd });
        this._serverFd = null;
      }
      callback();
    } catch (err) {
      callback(_errFromHttp(err, "write", this.path));
    }
  }

    close(cb) {
    if (this._closed) {
      if (cb) cb();
      return;
    }
    this.end();
    if (cb) this.once("close", cb);
  }

  destroy(err) {
    if (this._closed) return this;
    this._closed = true;
    // Best-effort close the server fd if we opened one; don't block destroy.
    if (this._serverFd !== null) {
      const fd = this._serverFd;
      this._serverFd = null;
      client.postJSON("/api/fs/fd/close", { fd }).catch(() => {});
    }
    try { super.destroy(err); } catch (_) {}
    return this;
  }
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

module.exports = { ReadStream, WriteStream };