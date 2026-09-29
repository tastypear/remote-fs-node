"use strict";

const constants = require("./constants");

/**
 * Convert numeric flags (fs.constants.O_* bitmask) to a normalized
 * string flag ("r", "w", "wx", "r+", "w+", "a", "a+").
 * Falls through if already a string.
 *
 * O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2
 * O_CREAT = 64, O_EXCL = 128, O_TRUNC = 512, O_APPEND = 1024
 */
function flagsToString(flags) {
  if (typeof flags === "string") return flags;
  if (typeof flags !== "number") return "r";

  const O = constants;
  const has = (bit) => bit && (flags & bit) === bit;

  const acc = flags & 3; // low 2 bits = access mode (O_RDONLY=0, O_WRONLY=1, O_RDWR=2)
  const isRead = acc === 0 || acc === 2; // O_RDONLY or O_RDWR
  const isWrite = acc === 1 || acc === 2; // O_WRONLY or O_RDWR
  const isReadWrite = acc === 2;
  const create = has(O.O_CREAT);
  const excl = has(O.O_EXCL);
  const trunc = has(O.O_TRUNC);
  const append = has(O.O_APPEND);

  // Map to Node's string flag set: r, r+, w, wx, w+, a, ax, a+, ax+.
  // Key rules (mirroring libuv's string-to-flags table, reversed):
  //   - O_EXCL requires O_CREAT and forbids the target existing ("x").
  //   - "w"/"w+" imply O_CREAT|O_TRUNC (create-or-truncate).
  //   - "a"/"a+" imply O_CREAT|O_APPEND (create-or-append).
  //   - "r"/"r+" open existing only (no create); ENOENT if missing.

  if (append) {
    if (isReadWrite) return excl ? "ax+" : "a+";   // O_RDWR|O_APPEND[|O_CREAT]
    return excl ? "ax" : "a";                        // O_WRONLY|O_APPEND[|O_CREAT]
  }

  if (trunc) {
    // O_TRUNC implies create-and-truncate semantics.
    if (isReadWrite) return excl ? "wx+" : "w+";    // O_RDWR|O_TRUNC
    return excl ? "wx" : "w";                        // O_WRONLY|O_TRUNC
  }

  if (isReadWrite) {
    // O_RDWR without trunc/append → r+ (open existing read+write, no create).
    // O_CREAT|O_EXCL with O_RDWR but no O_TRUNC is unusual; treat as r+ (excl
    // enforced at open-time, no trunc). Node has no "rx+" string, so we map
    // to r+ and let the fd entry enforce EXCL.
    return "r+";
  }

  if (isWrite) {
    // O_WRONLY without O_TRUNC/O_APPEND.
    if (create) {
      // O_WRONLY|O_CREAT (no trunc, no append): real fs opens existing or
      // creates; does NOT truncate. Node's "w" truncates, so we can't use it.
      // Closest non-trunc create flag is "a" (append), but that forces append.
      // Use "r+" (read+write, no trunc, no create) and create at the fd layer.
      return "r+";
    }
    return "r+"; // O_WRONLY on existing, no create — write in place.
  }

  // O_RDONLY
  return "r";
}

/**
 * Convert flags (string or numeric) to the numeric O_* bitmask the server's
 * os.open() consumes. Numeric input passes through; string input is mapped
 * back to the libuv flag set. The server honors O_CREAT/O_EXCL/O_TRUNC/O_APPEND
 * directly so the client doesn't lose semantics through a string round-trip.
 */
function flagsToNumeric(flags) {
  if (typeof flags === "number") return flags;
  const O = constants;
  const f = String(flags);
  const acc = f.includes("+") ? O.O_RDWR : f.startsWith("r") ? O.O_RDONLY : O.O_WRONLY;
  let n = acc;
  if (f.startsWith("w") || f.startsWith("a") || f.includes("x")) n |= O.O_CREAT;
  if (f.includes("x")) n |= O.O_EXCL;
  if (f.startsWith("w")) n |= O.O_TRUNC;
  if (f.startsWith("a")) n |= O.O_APPEND;
  return n;
}

module.exports = { flagsToString, flagsToNumeric };