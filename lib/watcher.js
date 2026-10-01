"use strict";

const { EventEmitter } = require("events");
const client = require("./client");
const { toStats } = require("./fd-table");
const { httpToFsError } = require("./errors");

function _normalizePath(p) {
  if (Buffer.isBuffer(p)) p = p.toString("utf8");
  p = String(p);
  if (p.indexOf("\\") !== -1) p = p.split("\\").join("/");
  const transform = client.pathTransform;
  if (transform) p = transform(p);
  return p;
}

// ─── FSWatcher (via SSE) ─────────────────────────────────
// fs.watch() returns this. Emits: "change" (eventType, filename), "error", "close".

class FSWatcher extends EventEmitter {
  constructor(filename, options, listener) {
    super();
    this._filename = _normalizePath(filename);
    this._options = typeof options === "function" ? {} : (options || {});
    this._closed = false;
    this._res = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;

    // encoding option affects filename
    this._encoding = this._options.encoding || "utf8";

    if (typeof options === "function") {
      this.on("change", options);
    } else if (typeof listener === "function") {
      this.on("change", listener);
    }

    // Handle AbortSignal
    if (this._options.signal) {
      this._options.signal.addEventListener("abort", () => this.close());
    }

    this._connect();
  }

  async _connect() {
    if (this._closed) return;

    const p = encodeURIComponent(this._filename);
    const recursive = this._options.recursive === true;
    const interval = this._options.interval || 500;
    const url = `/api/fs/watch?path=${p}&recursive=${recursive}&interval=${interval}`;

    try {
      const res = await client.getStream(url);
      this._res = res;
      this._reconnectDelay = 1000; // reset backoff on success

      let buffer = "";

      res.on("data", (chunk) => {
        if (this._closed) return;
        buffer += chunk.toString("utf8");
        const parts = buffer.split("\n\n");
        buffer = parts.pop(); // keep incomplete chunk

        for (const part of parts) {
          const dataLine = part
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!dataLine) continue;

          try {
            const event = JSON.parse(dataLine.slice(6));
            // Node's fs.watch callback: (eventType, filename)
            // eventType is "change" or "rename"
            // filename is relative path or null
            let filename = event.filename;
            if (filename && this._encoding === "buffer") {
              filename = Buffer.from(filename, "utf8");
            }
            this.emit("change", event.event, filename);
          } catch {
            // Ignore malformed events
          }
        }
      });

      res.on("end", () => {
        if (!this._closed) {
          this._scheduleReconnect();
        }
      });

      res.on("error", (err) => {
        if (!this._closed) {
          this.emit("error", err);
          this._scheduleReconnect();
        }
      });
    } catch (err) {
      if (!this._closed) {
        this.emit("error", err);
        this._scheduleReconnect();
      }
    }
  }

  _scheduleReconnect() {
    if (this._closed) return;
    this._reconnectTimer = setTimeout(() => {
      this._connect();
    }, this._reconnectDelay);
    // Exponential backoff, capped at 5s
    this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 5000);
  }

  close() {
    if (this._closed) return;
    this._closed = true;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._res) {
      this._res.destroy();
      this._res = null;
    }
    this.emit("close");
    this.removeAllListeners();
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

// ─── StatWatcher (via stat polling) ──────────────────────
// fs.watchFile() returns this. Emits: "change" (curr, prev), "stop".

class StatWatcher extends EventEmitter {
  constructor(filename, options, listener) {
    super();
    this._filename = _normalizePath(filename);
    this._options = typeof options === "function" ? { interval: 5007 } : (options || {});
    this._interval = this._options.interval || 5007;
    this._persistent = this._options.persistent !== false;
    this._closed = false;
    this._prev = null;
    this._timer = null;
    this._listener = null;

    if (typeof options === "function") {
      this._listener = options;
      this.on("change", options);
    } else if (typeof listener === "function") {
      this._listener = listener;
      this.on("change", listener);
    }

    // Handle AbortSignal
    if (this._options.signal) {
      this._options.signal.addEventListener("abort", () => this.stop());
    }

    this._poll();
  }

  async _poll() {
    if (this._closed) return;

    let curr = null;
    try {
      const info = await client.getJSON(
        `/api/fs/stat?path=${encodeURIComponent(this._filename)}`
      );
      curr = toStats(info);
    } catch {
      // File doesn't exist — curr stays null
    }

    if (this._prev !== null || curr !== null) {
      // Emit on first stat if file exists, or on subsequent changes
      if (this._prev === null && curr !== null) {
        // First poll: set prev, don't emit (Node behavior)
      } else if (
        curr === null ||
        this._prev === null ||
        curr.mtimeMs !== this._prev.mtimeMs ||
        curr.size !== this._prev.size
      ) {
        this.emit("change", curr, this._prev);
      }
    }

    this._prev = curr;

    if (!this._closed) {
      this._timer = setTimeout(() => this._poll(), this._interval);
      if (!this._persistent) {
        this._timer.unref();
      }
    }
  }

  stop() {
    if (this._closed) return;
    this._closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.emit("stop");
    this.removeAllListeners();
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

// ─── Registry for unwatchFile ────────────────────────────
const _statWatchers = new Map();

function watch(filename, options, listener) {
  return new FSWatcher(filename, options, listener);
}

function watchFile(filename, options, listener) {
  const watcher = new StatWatcher(filename, options, listener);
  const key = _normalizePath(filename);

  if (!_statWatchers.has(key)) {
    _statWatchers.set(key, new Set());
  }
  _statWatchers.get(key).add(watcher);

  return watcher;
}

function unwatchFile(filename, listener) {
  const key = _normalizePath(filename);
  const watchers = _statWatchers.get(key);

  if (!watchers) return;

  if (listener) {
    // Remove only watchers with this specific listener
    for (const w of watchers) {
      if (w._listener === listener) {
        w.stop();
        watchers.delete(w);
      }
    }
  } else {
    // Remove all watchers for this filename
    for (const w of watchers) {
      w.stop();
    }
    watchers.clear();
  }

  if (watchers.size === 0) {
    _statWatchers.delete(key);
  }
}

module.exports = {
  FSWatcher,
  StatWatcher,
  watch,
  watchFile,
  unwatchFile,
};