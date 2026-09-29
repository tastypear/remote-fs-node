"use strict";

// Mirror of fs.constants from Node.js
// These are the standard values on Linux/macOS
const constants = {
  // File open flags
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,        // 0o100
  O_EXCL: 128,        // 0o200
  O_TRUNC: 512,       // 0o1000
  O_APPEND: 1024,     // 0o2000
  O_NONBLOCK: 2048,   // 0o4000
  O_DIRECTORY: 65536, // 0o200000
  O_NOATIME: 0o1000000,  // 262144
  O_NOFOLLOW: 0o400000,  // 131072 — Linux O_NOFOLLOW (was 4194304, wrong)
  O_SYNC: 1052672,    // 0o401000
  O_DSYNC: 4096,      // 0o10000
  O_SYMLINK: 0,
  O_DIRECT: 16384,    // 0o040000
  O_NOCTTY: 256,      // 0o0400

  // Access modes
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,

  // Copy flags
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,

  // Watcher
  UV_FS_SYMLINK_DIR: 1,
  UV_FS_SYMLINK_JUNCTION: 2,

  // Dirent types
  DT_UNKNOWN: 0,
  DT_FIFO: 1,
  DT_CHR: 2,
  DT_DIR: 4,
  DT_BLK: 6,
  DT_REG: 8,
  DT_LNK: 10,
  DT_SOCK: 12,
  DT_WHT: 14,

  // S_IF* file-type bits (for fs.constants.S_IFREG etc.) — Linux values.
  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFDIR: 0o040000,
  S_IFCHR: 0o020000,
  S_IFBLK: 0o060000,
  S_IFIFO: 0o010000,
  S_IFLNK: 0o120000,
  S_IFSOCK: 0o140000,

  // S_I* permission bits (rwxrwxrwx) — Linux values.
  S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100,
  S_IRWXG: 0o070, S_IRGRP: 0o040, S_IWGRP: 0o020, S_IXGRP: 0o010,
  S_IRWXO: 0o007, S_IROTH: 0o004, S_IWOTH: 0o002, S_IXOTH: 0o001,

  // UV_DIRENT_* — mirror libuv's dirent type enum (matches DT_* above).
  UV_DIRENT_UNKNOWN: 0,
  UV_DIRENT_FILE: 1,
  UV_DIRENT_DIR: 2,
  UV_DIRENT_LINK: 3,
  UV_DIRENT_FIFO: 4,
  UV_DIRENT_SOCKET: 5,
  UV_DIRENT_CHAR: 6,
  UV_DIRENT_BLOCK: 7,

  // UV_FS_* — libuv fs copy/mmap flags (mirror COPYFILE_* on platforms that
  // expose them; values match Node's libuv constants).
  UV_FS_O_FILEMAP: 0,
  UV_FS_COPYFILE_EXCL: 0x0001,
  UV_FS_COPYFILE_FICLONE: 0x0002,
  UV_FS_COPYFILE_FICLONE_FORCE: 0x0004,
};

module.exports = constants;
