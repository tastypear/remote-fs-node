"use strict";

// Glob matching — shared by the callback (fs.glob), sync (fs.globSync), and
// promises (fs.promises.glob) layers. Matching itself runs on the server
// (Python glob.glob, no shell), so patterns with spaces/$/backticks are safe.
// This module handles the client-side options the server does not: exclude
// (function | string[]), includeHidden (default false), deep, withFileTypes,
// and the caseSensitive:false fallback (server glob is case-sensitive).

const client = require("./client");
const { Dirent } = require("./stats");
function _normalizePath(p) {
  if (Buffer.isBuffer(p)) p = p.toString("utf8");
  p = String(p);
  if (p.indexOf("\\") !== -1) p = p.split("\\").join("/");
  return p;
}

// Convert a glob pattern to a RegExp. Supports *, ** (cross-/), ?, [...],
// and brace alternation {a,b}. Used only for the exclude check and the
// caseSensitive:false fallback — the primary match is server-side.
function globToRegex(pattern, caseSensitive) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1; // a/**/b also matches a/b
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "[") {
      let cls = "[";
      i += 1;
      while (i < pattern.length && pattern[i] !== "]") cls += pattern[i++];
      if (i < pattern.length) { cls += "]"; i += 1; }
      re += cls;
    } else if (c === "{") {
      const alts = [];
      let cur = "";
      i += 1;
      while (i < pattern.length && pattern[i] !== "}") {
        if (pattern[i] === ",") { alts.push(cur); cur = ""; }
        else cur += pattern[i];
        i += 1;
      }
      alts.push(cur);
      if (i < pattern.length) i += 1;
      re += "(?:" + alts.map(_escapeRegex).join("|") + ")";
    } else {
      re += _escapeRegex(c);
      i += 1;
    }
  }
  return new RegExp("^" + re + "$", caseSensitive ? "" : "i");
}

function _escapeRegex(s) {
  return s.replace(/[.+^${}()|\\]/g, "\\$&");
}

// exclude: function(relPath | Dirent) => truthy-to-exclude, OR string[] of glob
// patterns. When withFileTypes is set, real Node passes a Dirent to the
// function (not a string), so we mirror that for parity.
function _isExcluded(relPath, type, parentPath, withFileTypes, exclude) {
  if (!exclude) return false;
  let arg = relPath;
  if (withFileTypes) {
    arg = new Dirent(
      relPath.includes("/") ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath,
      type,
      parentPath
    );
  }
  if (typeof exclude === "function") {
    try { return !!exclude(arg); } catch (_) { return false; }
  }
  if (Array.isArray(exclude)) {
    return exclude.some((pat) => globToRegex(pat, true).test(relPath));
  }
  return false;
}

// includeHidden default false: skip paths with a dotfile segment.
function _isHidden(relPath) {
  return relPath.split("/").some((seg) => seg.length > 0 && seg.startsWith("."));
}

// deep: max recursion depth (number of path separators in the relative path).
function _tooDeep(relPath, deep) {
  if (deep == null) return false;
  const depth = relPath.split("/").length - 1;
  return depth > deep;
}

function _applyFilters(matches, opts) {
  const exclude = opts.exclude;
  const withFileTypes = opts.withFileTypes === true;
  const includeHidden = opts.includeHidden === true;
  const deep = typeof opts.deep === "number" ? opts.deep : null;

  // Sort parents before children so that excluding a directory prunes its
  // subtree (real Node prunes during traversal; we simulate client-side by
  // tracking excluded directory prefixes).
  const sorted = matches.slice().sort((a, b) => {
    const da = a.path.split("/").length;
    const db = b.path.split("/").length;
    return da - db || (a.path < b.path ? -1 : 1);
  });

  const excludedDirs = [];
  const out = [];
  for (const m of sorted) {
    const rel = m.path;
    // Pruned by an excluded ancestor?
    if (excludedDirs.some((p) => rel === p || rel.startsWith(p + "/"))) continue;
    if (!includeHidden && _isHidden(rel)) continue;
    const sep = rel.lastIndexOf("/");
    const parentPath = sep >= 0 ? rel.slice(0, sep) : ".";
    if (_isExcluded(rel, m.type, parentPath, withFileTypes, exclude)) {
      if (m.type === "dir") excludedDirs.push(rel);
      continue;
    }
    if (_tooDeep(rel, deep)) continue;
    out.push(m);
  }
  // Preserve the server's original order in the output.
  const byPath = new Map(out.map((m) => [m.path, m]));
  return matches.filter((m) => byPath.has(m.path));
}

// Fallback for caseSensitive:false (server glob is case-sensitive on Linux)
// and includeHidden:true (Python's * never matches leading-dot files, so the
// server glob cannot return them). Lists the base dir recursively and matches
// with a client-side regex whose * DOES match dotfiles.
async function _fetchCaseInsensitive(pattern, opts) {
  const cwd = opts.cwd != null ? _normalizePath(opts.cwd) : null;
  const base = cwd || ".";
  const entries = await client.getJSON(
    `/api/fs/list?path=${encodeURIComponent(base)}&recursive=true`
  );
  const re = globToRegex(pattern, opts.caseSensitive !== false);
  const matches = [];
  for (const e of entries) {
    if (re.test(e.name)) matches.push({ path: e.name, type: e.type || "file" });
  }
  return _applyFilters(matches, opts);
}

function _fetchCaseInsensitiveSync(pattern, opts) {
  const cwd = opts.cwd != null ? _normalizePath(opts.cwd) : null;
  const base = cwd || ".";
  const buf = client.getBufferSync(
    `/api/fs/list?path=${encodeURIComponent(base)}&recursive=true`
  );
  const entries = JSON.parse(buf.toString("utf8"));
  const re = globToRegex(pattern, opts.caseSensitive !== false);
  const matches = [];
  for (const e of entries) {
    if (re.test(e.name)) matches.push({ path: e.name, type: e.type || "file" });
  }
  return _applyFilters(matches, opts);
}

async function fetchMatches(pattern, options) {
  const opts = options || {};
  if (opts.caseSensitive === false || opts.includeHidden === true) {
    return _fetchCaseInsensitive(pattern, opts);
  }
  const cwd = opts.cwd != null ? _normalizePath(opts.cwd) : null;
  const url = `/api/fs/glob?pattern=${encodeURIComponent(_normalizePath(pattern))}` +
    (cwd ? `&cwd=${encodeURIComponent(cwd)}` : "") + "&recursive=true";
  const matches = await client.getJSON(url).catch((err) => { throw _rethrow(err, pattern); });
  return _applyFilters(matches, opts);
}

function fetchMatchesSync(pattern, options) {
  const opts = options || {};
  if (opts.caseSensitive === false || opts.includeHidden === true) {
    return _fetchCaseInsensitiveSync(pattern, opts);
  }
  const cwd = opts.cwd != null ? _normalizePath(opts.cwd) : null;
  const url = `/api/fs/glob?pattern=${encodeURIComponent(_normalizePath(pattern))}` +
    (cwd ? `&cwd=${encodeURIComponent(cwd)}` : "") + "&recursive=true";
  let matches;
  try {
    matches = JSON.parse(client.getBufferSync(url).toString("utf8"));
  } catch (err) {
    throw _rethrow(err, pattern);
  }
  return _applyFilters(matches, opts);
}

function _rethrow(err, pattern) {
  if (err.statusCode) {
    const { httpToFsError } = require("./errors");
    const fsErr = httpToFsError(err.statusCode, err.message);
    fsErr.syscall = "glob";
    fsErr.path = pattern;
    return fsErr;
  }
  return err;
}

// Build the final result: string[] or Dirent[] (withFileTypes). Dirent.name is
// the basename, Dirent.parentPath is the match's dirname (relative to cwd, or
// "." for top-level matches) — matching Node v20.12+ parentPath semantics.
function buildResult(matches, withFileTypes) {
  if (!withFileTypes) return matches.map((m) => m.path);
  return matches.map((m) => {
    const sep = m.path.lastIndexOf("/");
    const name = sep >= 0 ? m.path.slice(sep + 1) : m.path;
    const parentPath = sep >= 0 ? m.path.slice(0, sep) : ".";
    return new Dirent(name, m.type, parentPath);
  });
}

// AsyncIterableIterator for fs.promises.glob. Yields from a pre-fetched array
// (the match set is finite). return() ends early (for `break`/AbortSignal).
function createAsyncIterator(matches, withFileTypes) {
  let i = 0;
  let done = false;
  return {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (done || i >= matches.length) {
        done = true;
        return Promise.resolve({ value: undefined, done: true });
      }
      const m = matches[i++];
      const value = withFileTypes
        ? new Dirent(
            m.path.includes("/") ? m.path.slice(m.path.lastIndexOf("/") + 1) : m.path,
            m.type,
            m.path.includes("/") ? m.path.slice(0, m.path.lastIndexOf("/")) : "."
          )
        : m.path;
      return Promise.resolve({ value, done: false });
    },
    return() {
      done = true;
      return Promise.resolve({ value: undefined, done: true });
    },
  };
}

module.exports = {
  fetchMatches,
  fetchMatchesSync,
  buildResult,
  createAsyncIterator,
  globToRegex,
};
