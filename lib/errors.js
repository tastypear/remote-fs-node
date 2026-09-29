"use strict";

function httpToFsError(statusCode, message) {
  const msg = message || "";
  let code, errno;

  switch (statusCode) {
    case 404:
      code = "ENOENT";
      errno = -2;
      break;
    case 403:
      code = "EACCES";
      errno = -13;
      break;
    case 400:
      code = "EINVAL";
      errno = -22;
      break;
    case 408:
      code = "ETIMEDOUT";
      errno = -110;
      break;
    case 409:
      code = "EEXIST";
      errno = -17;
      break;
    case 413:
      code = "EFBIG";
      errno = -27;
      break;
    default:
      code = "EIO";
      errno = -5;
  }

  const err = new Error(`${code}: ${msg}`);
  err.code = code;
  err.errno = errno;
  // syscall/path are set by the caller (_errFromHttp) since the same HTTP error
  // can surface from different syscalls (stat vs read vs open).
  return err;
}

function notImplemented(method) {
  const err = new Error(`remote-fs: ${method}() is not implemented over HTTP`);
  err.code = "ENOSYS";
  err.errno = -38;
  return err;
}

module.exports = { httpToFsError, notImplemented };
