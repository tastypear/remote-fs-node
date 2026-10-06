# remote-fs-node

Node.js `fs`-compatible module backed by HTTP. A drop-in replacement for `require("fs")` that routes all file system operations to a remote server — including `process.binding('fs')` interception for native code paths.

Inspired by [mock-fs](https://github.com/tschaub/mock-fs), which intercepts `require("fs")` to return an in-memory mock. We do the same, but route operations to an HTTP backend instead.

## What makes this different

Unlike SSH/SFTP-based remote file access, remote-fs-node patches Node at **three levels**:

1. **JS export layer** — replaces all methods on `require("fs")`
2. **`process.binding('fs')` layer** — intercepts the C++ binding that Node's internal code uses (same strategy as mock-fs)
3. **`node:fs` protocol** — patches `Module._resolveFilename` so `require("node:fs")` is also intercepted

This means even Node's internal `readFile` fast paths, `graceful-fs`, and `fs-extra` work transparently. The binding layer checks whether a path looks remote (starts with `/`) before routing to HTTP — local paths fall through to the original binding, so `require()` and local file ops keep working alongside remote operations.

## Quick start

```bash
npm install remote-fs-node
```

### As drop-in replacement

```js
const remoteFs = require("remote-fs-node");
remoteFs.configure({
  baseURL: "http://your-server:8765",
  token: "my-secret",
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
remoteFs.configure({ baseURL: "http://your-server:8765", token: "my-secret" });

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
| `configure(opts)` | Set `baseURL`, `token`, `curlPath`, `syncMaxFileBytes`, `shouldRemote`, `pathTransform` |
| `patch(options?)` | Monkey-patch `require("fs")` + `process.binding('fs')` |
| `restore()` | Restore original fs |
| `bypass(fn)` | Temporarily use real fs (sync or async) |
| `isPatched()` / `isBindingPatched()` | Check patch state |
| `setCacheProvider(provider)` | Inject `{ get, set, invalidate }` for transport-level GET caching |

### Patch options

```js
remoteFs.patch({
  patchSync: true,  // also patch sync methods (requires pre-requiring modules)
});
```

By default, sync methods (`readFileSync`, etc.) are **not** patched — this allows `require()` to work normally for loading local modules. Use `patchSync: true` when you need full sync interception (pre-require all modules first).

### Routing and path options

```js
remoteFs.configure({
  baseURL: "http://your-server:8765",
  token: "my-secret",
  shouldRemote: (path) => !path.startsWith("/home/local/"),  // return false to keep local
  pathTransform: (path) => path.replace(/^\/mnt\/remote/, ""), // rewrite path before sending
  syncMaxFileBytes: 64 * 1024 * 1024,  // sync open guard: throw ERR_FS_FILE_TOO_LARGE above this (default 64MB)
});
```

- `shouldRemote(path)` — callback returning `false` to keep a path local. Default: built-in detection (paths starting with `/` go remote).
- `pathTransform(path)` — rewrite a path before sending it to the server (e.g. strip a mount prefix).

### Performance tuning

Async fd operations use stateful server-side fd sessions (`pread`/`pwrite`) for O(1) ranged I/O — no whole-file buffering. Sync operations preload the whole file into memory (capped by `syncMaxFileBytes`) and serve slices locally, with a short-TTL cache collapsing repeated `existsSync`/`statSync` storms. A pluggable cache provider (`setCacheProvider`) enables transport-level caching of GET responses downstream.

### fs methods

All standard `fs` methods are supported:

- **Async callback**: `readFile`, `writeFile`, `stat`, `readdir`, `mkdir`, `rmdir`, `rm`, `unlink`, `rename`, `copyFile`, `cp`, `chmod`, `chown`, `symlink`, `readlink`, `realpath`, `access`, `appendFile`, `truncate`, `link`, `mkdtemp`, `utimes`, `opendir`
- **Promise**: `fs.promises.*` + `FileHandle` class
- **Sync**: `readFileSync`, `writeFileSync`, `statSync`, `readdirSync`, `existsSync`, `accessSync`, etc.
- **Streams**: `createReadStream`, `createWriteStream` (true streaming with backpressure)
- **Watch**: `watch` (SSE-based), `watchFile` (stat polling), `unwatchFile`
- **File descriptors**: `open`, `read`, `write`, `close`, `fstat`, `fsync`, `ftruncate`, `fchmod`, `fchown`, `futimes`
- **Batch**: `batch(ops)` / `batchSync(ops)` — multiple read/write ops in one request (`POST /api/fs/batch`)
- **glob**: `fs.glob` / `fs.globSync` (with `exclude` callback receiving `Dirent` when `withFileTypes:true`)
- **Classes**: `Stats` (instanceof ✓), `Dirent` (instanceof ✓), `ReadStream` (instanceof ✓), `WriteStream` (instanceof ✓)

### Numeric flags

```js
const c = fs.constants;
const fd = await fs.promises.open("/tmp/file", c.O_RDWR | c.O_CREAT | c.O_TRUNC);
```

## Sync implementation

Sync methods use a **worker-thread bridge** (`SharedArrayBuffer` + `Atomics.wait`) — the main thread writes the request to a shared buffer, posts to a worker, and blocks until the response arrives. No subprocess fork per call. Falls back to `curl` if `SharedArrayBuffer` is unavailable (older Node or disabled cross-origin isolation).

## Server backend

Requires [remote-ops-server](https://github.com/tastypear/remote-ops-server) (Go or Python) implementing the fs endpoints (`/api/fs/*`, `/api/fs/fd/*`, `/api/fs/batch`, `/api/fs/watch`, etc.). See its README for the full API reference.

## Test

```bash
# Start a remote-ops server (shared), then:
node test/test.js              # core tests
node test/test_binding.js      # binding layer
node test/test_compat.js       # fs-extra / graceful-fs compatibility
node test/test_edge.js         # edge cases
node test/test_adversarial.js  # adversarial / regression
node test/test_sync_cache.js   # sync cache
# ...and more (see test/ directory)
```

## Module structure

```
remote-fs-node/
├── index.js              # Entry: configure/patch/restore/bypass
├── lib/
│   ├── async-api.js      # All async callback methods + batch
│   ├── binding.js        # process.binding('fs') interception
│   ├── client.js         # HTTP client (async + sync bridge) + keepAlive + cache hook
│   ├── constants.js      # fs.constants
│   ├── errors.js         # HTTP → fs error code mapping
│   ├── fd-table.js       # File descriptors: RemoteFdEntry (async) + BufferedFdEntry (sync)
│   ├── flags.js          # Numeric flags ↔ string conversion
│   ├── glob.js           # glob/globSync with exclude + subtree pruning
│   ├── graceful.js       # graceful-fs compatibility
│   ├── patch.js          # Monkey-patch + bypass mechanism
│   ├── promises-api.js   # fs.promises + FileHandle
│   ├── stats.js          # Stats/Dirent/Dir classes
│   ├── streams.js        # ReadStream/WriteStream (fd-based streaming)
│   ├── sync-api.js       # All sync methods + batchSync
│   ├── sync-bridge.js    # Worker-thread sync HTTP (SharedArrayBuffer + Atomics)
│   ├── sync-worker.js    # Worker entry point for sync-bridge
│   └── watcher.js        # watch/watchFile (SSE)
└── test/                 # test suites
```

## Limitations

- Sync `open` preloads the whole file into memory — capped at `syncMaxFileBytes` (default 64MB) to avoid heap exhaustion; use the async API for large files
- `fs.watch` requires SSE connection to server
- C++ native addons calling `internalBinding('fs')` directly (not via `process.binding`) may bypass interception

## License

MIT
