# remote-fs-node

Node.js `fs`-compatible module backed by HTTP. A drop-in replacement for `require("fs")` that routes all file system operations to a remote server — including `process.binding('fs')` interception for native code paths.

Inspired by [mock-fs](https://github.com/tschaub/mock-fs), which intercepts `require("fs")` to return an in-memory mock. We do the same, but route operations to an HTTP backend instead.

## What makes this different

Unlike SSH/SFTP-based remote file access, remote-fs-node patches Node at **three levels**:

1. **JS export layer** — replaces all methods on `require("fs")`
2. **`process.binding('fs')` layer** — intercepts the C++ binding that Node's internal code uses (same strategy as mock-fs)
3. **`node:fs` protocol** — patches `Module._resolveFilename` so `require("node:fs")` is also intercepted

This means even Node's internal `readFile` fast paths, `graceful-fs`, and `fs-extra` work transparently.

## Quick start

```bash
npm install remote-fs-node
```

### As drop-in replacement

```js
const remoteFs = require("remote-fs-node");
remoteFs.configure({
  baseURL: "http://your-server:8765",
  token: "your-token",
});

const fs = remoteFs.fs;

// Use exactly like Node's fs
const content = await fs.promises.readFile("/etc/hostname", "utf8");
await fs.promises.writeFile("/tmp/test.txt", "hello");
const exists = fs.existsSync("/etc/passwd");
```

### As monkey-patch (like mock-fs)

```js
const remoteFs = require("remote-fs-node");
remoteFs.configure({ baseURL: "http://your-server:8765", token: "xxx" });

// Patch require("fs") globally — intercepts JS layer + binding layer
remoteFs.patch();

// Now ALL code that uses fs works remotely
const fs = require("fs");
const data = await fs.promises.readFile("/remote/path");

// Third-party libraries too (fs-extra, graceful-fs, etc.)
const fse = require("fs-extra");
await fse.copy("/remote/src", "/remote/dst");

// Access local fs temporarily
const localData = remoteFs.bypass(() => require("fs").readFileSync("/local/file"));

// Restore
remoteFs.restore();
```

## API

### Core

| Method | Description |
|--------|-------------|
| `configure(opts)` | Set `baseURL`, `token`, `curlPath`, `syncMaxFileBytes`, `syncCacheTtlMs` |
| `patch(options?)` | Monkey-patch `require("fs")` + `process.binding('fs')` |
| `restore()` | Restore original fs |
| `bypass(fn)` | Temporarily use real fs (sync or async) |
| `isPatched()` | Check if patched |
| `isBindingPatched()` | Check if binding layer is patched |

### Patch options

```js
remoteFs.patch({
  patchSync: true,  // also patch sync methods (requires pre-requiring modules)
});
```

By default, sync methods (`readFileSync`, etc.) are **not** patched — this allows `require()` to work normally for loading local modules. Use `patchSync: true` when you need full sync interception (pre-require all modules first).

### Performance tuning

```js
remoteFs.configure({
  baseURL: "http://your-server:8765",
  token: "xxx",
  syncMaxFileBytes: 64 * 1024 * 1024,  // sync open guard: throw ERR_FS_FILE_TOO_LARGE above this (default 64MB)
  syncCacheTtlMs: 500,                  // sync GET cache TTL; 0 disables (default 500ms)
});
```

Async fd operations use stateful server-side fd sessions (`os.pread`/`os.pwrite`) for O(1) ranged I/O — no whole-file buffering. Sync operations preload the whole file into memory (capped by `syncMaxFileBytes`) and serve slices locally, with a short-TTL cache collapsing repeated `existsSync`/`statSync` storms.

### fs methods

All standard `fs` methods are supported:

- **Async callback**: `readFile`, `writeFile`, `stat`, `readdir`, `mkdir`, `rmdir`, `rm`, `unlink`, `rename`, `copyFile`, `cp`, `chmod`, `chown`, `symlink`, `readlink`, `realpath`, `access`, `appendFile`, `truncate`, `link`, `mkdtemp`, `utimes`, `opendir`
- **Promise**: `fs.promises.*` + `FileHandle` class
- **Sync**: `readFileSync`, `writeFileSync`, `statSync`, `readdirSync`, `existsSync`, `accessSync`, etc.
- **Streams**: `createReadStream`, `createWriteStream` (true streaming with backpressure)
- **Watch**: `watch` (SSE-based), `watchFile` (stat polling), `unwatchFile`
- **File descriptors**: `open`, `read`, `write`, `close`, `fstat`, `fsync`, `ftruncate`, `fchmod`, `fchown`, `futimes`
- **glob**: `fs.glob` / `fs.globSync` (with `exclude` callback receiving `Dirent` when `withFileTypes:true`)
- **Classes**: `Stats` (instanceof ✓), `Dirent` (instanceof ✓), `ReadStream` (instanceof ✓), `WriteStream` (instanceof ✓)

### Numeric flags

```js
const c = fs.constants;
const fd = await fs.promises.open("/tmp/file", c.O_RDWR | c.O_CREAT | c.O_TRUNC);
```

### Binding layer

When `patch()` is called, `process.binding('fs')` methods are wrapped. Each method checks:
- If `_mockImpl` is set AND the path looks like a remote path (starts with `/`) → route to HTTP
- Otherwise → fall back to original binding (local fs)

This allows `require()` and local file operations to work alongside remote operations.

## Server backend

remote-fs-node requires an HTTP server implementing these endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/exec` | POST | Execute command, return stdout/stderr/exit_code |
| `/api/exec/stream` | POST | Execute command with SSE streaming |
| `/api/fs/read` | GET | Read file (raw body) |
| `/api/fs/write` | PUT | Write file (raw body) |
| `/api/fs/stat` | GET | File metadata |
| `/api/fs/list` | GET | List directory |
| `/api/fs/glob` | GET | Glob pattern matching |
| `/api/fs/statfs` | GET | Filesystem statistics |
| `/api/fs/delete` | POST | Delete file/dir |
| `/api/fs/mkdir` | POST | Create directory |
| `/api/fs/move` | POST | Move/rename (atomic on same filesystem) |
| `/api/fs/copy` | POST | Copy file/dir |
| `/api/fs/chmod` | POST | Change mode |
| `/api/fs/chown` | POST | Change owner |
| `/api/fs/utimes` | POST | Set access/modify times |
| `/api/fs/truncate` | POST | Truncate file |
| `/api/fs/symlink` | POST | Create symlink |
| `/api/fs/readlink` | GET | Read symlink target |
| `/api/fs/link` | POST | Create hard link |
| `/api/fs/realpath` | POST | Resolve canonical path |
| `/api/fs/mkdtemp` | POST | Create temp directory |
| `/api/fs/access` | GET | Check accessibility |
| `/api/fs/touch` | POST | Create empty file |
| `/api/fs/batch` | POST | Batch operations |
| `/api/fs/patch` | POST | Apply unified diff |
| `/api/fs/watch` | GET | SSE file watcher |
| `/api/fs/fd/*` | mixed | Stateful fd session: `open`/`read`/`write`/`close`/`fstat`/`ftruncate`/`fsync`/`fchmod`/`fchown`/`futimes` |

A reference Python/FastAPI server implementation is published as [remote-ops-server](https://github.com/tastypear/remote-ops-server).

## Test

```bash
# Start a remote-fs server, then:
node test/test.js           # core tests
node test/test_binding.js   # binding layer tests
node test/test_compat.js    # fs-extra compatibility tests
node test/test_edge.js      # edge case tests
# ... 147 tests across 17 suites
```

## Module structure

```
remote-fs-node/
├── index.js              # Entry: configure/patch/restore/bypass
├── lib/
│   ├── binding.js        # process.binding('fs') interception
│   ├── client.js         # HTTP client (async + sync via curl) + keepAlive + sync cache
│   ├── constants.js      # fs.constants
│   ├── errors.js         # HTTP → fs error code mapping
│   ├── fd-table.js       # File descriptors: RemoteFdEntry (async) + BufferedFdEntry (sync)
│   ├── flags.js          # Numeric flags ↔ string conversion
│   ├── glob.js           # glob/globSync with exclude + subtree pruning
│   ├── graceful.js       # graceful-fs compatibility
│   ├── patch.js          # Monkey-patch + bypass mechanism
│   ├── promises-api.js   # fs.promises + FileHandle
│   ├── stats.js          # Stats/Dirent classes
│   ├── streams.js        # ReadStream/WriteStream (fd-based streaming)
│   ├── sync-api.js       # All sync methods
│   ├── async-api.js      # All async callback methods
│   └── watcher.js        # watch/watchFile (SSE)
└── test/                 # 17 test suites, 147 tests
```

## Limitations

- Sync methods use `curl` subprocess (~50-100ms overhead per call); a short-TTL cache mitigates repeated reads
- Sync `open` preloads the whole file into memory — capped at `syncMaxFileBytes` (default 64MB) to avoid heap exhaustion; use the async API for large files
- `fs.watch` requires SSE connection to server
- C++ native addons calling `internalBinding('fs')` directly (not via `process.binding`) may bypass interception

## License

MIT
