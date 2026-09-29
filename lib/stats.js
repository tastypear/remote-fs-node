"use strict";

/**
 * Stats class — mirrors Node's fs.Stats.
 * Supports instanceof checks: stats instanceof fs.Stats === true.
 */
class Stats {
  constructor(info) {
    // Server (_stat_to_dict) returns fullMode (raw st_mode incl. S_IFMT bits)
    // when available; fall back to reconstructing from `type` + `mode` (perm
    // bits only, octal string). fullMode is authoritative.
    const rawMode = typeof info.fullMode === "number"
      ? info.fullMode
      : _modeFromType(info.type) | _parseMode(info.mode);

    const mode = _parseMode(info.mode);

    // Timestamps: server sends integer EPOCH MILLISECONDS (atime/mtime/ctime/
    // birthtime). Use mtime as the fallback for any missing field so a stale
    // server still yields sane-ish dates rather than 1970.
    const ms = (k) => (typeof info[k] === "number" ? info[k] : (info.mtime || 0));
    const atimeMs = ms("atime");
    const mtimeMs = ms("mtime");
    const ctimeMs = ms("ctime");
    const birthtimeMs = ms("birthtime");

    this.dev = info.dev || 0;
    this.ino = info.ino || 0;
    this.mode = rawMode;
    this.nlink = info.nlink || 1;
    this.uid = info.uid || 0;
    this.gid = info.gid || 0;
    this.rdev = info.rdev || 0;
    this.size = info.size || 0;
    this.blksize = info.blksize || 4096;
    this.blocks = typeof info.blocks === "number" ? info.blocks : Math.ceil((info.size || 0) / 512);
    this.atimeMs = atimeMs;
    this.mtimeMs = mtimeMs;
    this.ctimeMs = ctimeMs;
    this.birthtimeMs = birthtimeMs;
    this.atime = new Date(atimeMs);
    this.mtime = new Date(mtimeMs);
    this.ctime = new Date(ctimeMs);
    this.birthtime = new Date(birthtimeMs);

    // _is* derived from the authoritative rawMode when possible.
    const S_IFMT = 0o170000;
    const ifmt = rawMode & S_IFMT;
    this._isDir = ifmt === 0o040000;
    this._isFile = ifmt === 0o100000;
    this._isLink = ifmt === 0o120000;
    // Fallback to the type string if rawMode didn't carry S_IFMT.
    if (!this._isDir && !this._isFile && !this._isLink) {
      this._isDir = info.type === "dir";
      this._isFile = info.type === "file";
      this._isLink = info.type === "symlink";
    }
  }

  isDirectory() { return this._isDir; }
  isFile() { return this._isFile; }
  isSymbolicLink() { return this._isLink; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }

  // Returns a Stats-like object with BigInt numeric fields (for {bigint:true}).
  // Real Node's bigint stats is NOT an instanceof fs.Stats (it's a separate
  // internal BigInt-Stats class), so we return a plain object with the same
  // shape + methods — matching the observable behavior, not the instanceof.
  toBigInt() {
    const out = Object.create(Stats.prototype);
    for (const key of Object.keys(this)) {
      const v = this[key];
      if (typeof v === "number") {
        out[key] = BigInt(Math.trunc(v));
      } else if (v instanceof Date) {
        out[key] = BigInt(Math.floor(v.getTime()));
      } else {
        out[key] = v;
      }
    }
    // Copy the _is* flags so the inherited is* methods work.
    out._isDir = this._isDir;
    out._isFile = this._isFile;
    out._isLink = this._isLink;
    return out;
  }
}

/**
 * Dirent class — mirrors Node's fs.Dirent.
 * Supports instanceof checks: dirent instanceof fs.Dirent === true.
 */
class Dirent {
  // parentPath (Node v20.12+, Stable) is the directory this entry lives in.
  // readdir/opendir set it to the listed path; glob sets it to the match's
  // dirname (relative to cwd). Real Node removed the non-standard .path in
  // favor of parentPath, so we expose parentPath only.
  constructor(name, type, parentPath) {
    this.name = name;
    this._type = type;
    this.parentPath = parentPath || "";
  }

  isDirectory() { return this._type === "dir"; }
  isFile() { return this._type === "file"; }
  isSymbolicLink() { return this._type === "symlink"; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

function _parseMode(modeStr) {
  if (typeof modeStr === "number") return modeStr;
  if (typeof modeStr === "string") {
    return parseInt(modeStr.replace(/^0o/, ""), 8);
  }
  return 0o644;
}

// Reconstruct the S_IFMT portion from the server's `type` string, for servers
// that don't send fullMode. Matches Linux st_mode S_IF* constants.
function _modeFromType(type) {
  switch (type) {
    case "dir": return 0o040000;
    case "symlink": return 0o120000;
    case "blockdev": return 0o060000;
    case "chardev": return 0o020000;
    case "fifo": return 0o010000;
    case "socket": return 0o140000;
    default: return 0o100000; // file
  }
}

function toStats(info) {
  return new Stats(info);
}

function toDirent(entry, parentPath) {
  return new Dirent(entry.name, entry.type, parentPath);
}

// Dir — mirrors Node's fs.Dir (returned by opendir/opendirSync). Holds a list
// of entries and a cursor; supports async read/close + sync readSync/closeSync
// + both async and sync iteration. Built by opendir/opendirSync.
class Dir {
  constructor(path, items) {
    this.path = path;
    this._items = items;
    this._idx = 0;
    this._closed = false;
  }
  read() {
    if (this._closed || this._idx >= this._items.length) return Promise.resolve(null);
    return Promise.resolve(this._items[this._idx++]);
  }
  readSync() {
    if (this._closed || this._idx >= this._items.length) return null;
    return this._items[this._idx++];
  }
  close() { this._closed = true; return Promise.resolve(); }
  closeSync() { this._closed = true; }
  // Explicit Resource Management (Node v22+): `using dir = opendirSync(...)`
  // and `await using dir = await opendir(...)` auto-close on scope exit.
  [Symbol.dispose]() { this.closeSync(); }
  [Symbol.asyncDispose]() { return this.close(); }
  [Symbol.iterator]() {
    const self = this;
    return {
      next() {
        if (self._idx >= self._items.length) return { value: undefined, done: true };
        return { value: self._items[self._idx++], done: false };
      },
    };
  }
  [Symbol.asyncIterator]() {
    const self = this;
    return {
      async next() {
        if (self._idx >= self._items.length) return { value: undefined, done: true };
        return { value: self._items[self._idx++], done: false };
      },
    };
  }
}

module.exports = { Stats, Dirent, Dir, toStats, toDirent, parseMode: _parseMode };