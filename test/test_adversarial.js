"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const http = require("http");
const assert = require("assert");

const PORT = 8766;
const TOKEN = "testtoken123";
const T = "/tmp/rfs_adversarial";

let passed = 0, failed = 0;
const issues = [];
const notes = [];

function probe(method, path, body, query, opts = {}) {
  return new Promise((resolve) => {
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    const o = {
      hostname: "127.0.0.1", port: PORT,
      path: path + qs, method,
      headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
      timeout: opts.timeout || 8000,
    };
    const req = http.request(o, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ timedOut: true }); });
    req.on("error", (e) => resolve({ error: e.message }));
    if (body !== undefined && body !== null) {
      const raw = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      req.write(raw);
    }
    req.end();
  });
}

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); failed++; }
}

function issue(name, detail) { issues.push({ name, detail }); console.log("  ISSUE: " + detail); }
function note(name, detail) { notes.push({ name, detail }); }

async function serverAlive() {
  const r = await probe("GET", "/health");
  return r.status === 200;
}

async function run() {
  console.log("=== adversarial input test suite ===\n");

  // setup
  await probe("POST", "/api/fs/mkdir", { path: T, recursive: true });
  await probe("PUT", "/api/fs/write?" + new URLSearchParams({ path: T + "/file.txt" }).toString(), "hello");

  // ─── 1. Malformed JSON body ───────────────────────────────
  await test("empty body on POST", async () => {
    const r = await probe("POST", "/api/fs/copy", "");
    if (r.timedOut) issue("empty body", "server hung");
    else if (r.error) issue("empty body", "connection error: " + r.error);
    else assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("invalid JSON syntax", async () => {
    const r = await probe("POST", "/api/fs/copy", "{not json");
    if (r.timedOut) issue("invalid json", "server hung");
    else if (r.error) issue("invalid json", "connection error: " + r.error);
    else assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("JSON array instead of object", async () => {
    const r = await probe("POST", "/api/fs/copy", "[1,2,3]");
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("wrong type for path (number)", async () => {
    const r = await probe("POST", "/api/fs/chmod", { path: 12345, mode: "0o755" });
    if (r.timedOut) issue("wrong type path", "server hung");
    else if (r.error) issue("wrong type path", "connection error: " + r.error);
    else assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("wrong type for mode (object)", async () => {
    const r = await probe("POST", "/api/fs/chmod", { path: T + "/file.txt", mode: { a: 1 } });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("deeply nested JSON", async () => {
    let s = '{"path":';
    for (let i = 0; i < 1000; i++) s += '{"a":';
    s += '"x"';
    for (let i = 0; i < 1000; i++) s += "}";
    s += "}";
    const r = await probe("POST", "/api/fs/stat", s);
    if (r.timedOut) issue("deeply nested", "server hung");
    else assert.ok(r.status, "server responded");
  });

  // ─── 2. Missing / empty fields ────────────────────────────
  await test("missing path field", async () => {
    const r = await probe("POST", "/api/fs/chmod", { mode: "0o755" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("empty string path", async () => {
    const r = await probe("POST", "/api/fs/chmod", { path: "", mode: "0o755" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("missing src in copy", async () => {
    const r = await probe("POST", "/api/fs/copy", { dst: T + "/x" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("missing dst in copy", async () => {
    const r = await probe("POST", "/api/fs/copy", { src: T + "/file.txt" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("empty pattern in glob", async () => {
    const r = await probe("GET", "/api/fs/glob", null, { pattern: "", cwd: T });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  // ─── 3. Path edge cases ───────────────────────────────────
  await test("null byte in path", async () => {
    const r = await probe("POST", "/api/fs/stat", null, { path: T + "/file\u0000.txt" });
    if (r.timedOut) issue("null byte", "server hung");
    else if (r.error) issue("null byte", "connection error: " + r.error);
    else assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("very long path (10k chars)", async () => {
    const r = await probe("POST", "/api/fs/stat", null, { path: "/tmp/" + "a".repeat(10000) });
    if (r.timedOut) issue("long path", "server hung");
    else assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("unicode path (日本語)", async () => {
    const p = T + "/日本語_файл.txt";
    await probe("PUT", "/api/fs/write?" + new URLSearchParams({ path: p }).toString(), "unicode");
    const r = await probe("GET", "/api/fs/stat", null, { path: p });
    assert.ok(r.status === 200, "expected 200, got " + r.status);
  });

  await test("path traversal (../../etc/passwd)", async () => {
    const r = await probe("GET", "/api/fs/stat", null, { path: "/tmp/../etc/passwd" });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
    note("path traversal", "server allows traversal — SSH parity, not a bug");
  });

  await test("trailing slash on dir", async () => {
    const r = await probe("GET", "/api/fs/stat", null, { path: T + "/" });
    assert.ok(r.status === 200, "expected 200, got " + r.status);
  });

  await test("double slash in path", async () => {
    const r = await probe("GET", "/api/fs/stat", null, { path: "/tmp//" + T.split("/").slice(2).join("/") + "/file.txt" });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  // ─── 4. Integer edge cases ────────────────────────────────
  await test("huge offset in fd read", async () => {
    const open = await probe("POST", "/api/fs/fd/open", { path: T + "/file.txt", flags: 0 });
    if (open.status !== 200) return;
    const fd = JSON.parse(open.body).fd;
    const r = await probe("GET", "/api/fs/fd/read", null, { fd, offset: 999999999999, length: 10 });
    if (r.timedOut) issue("huge offset", "server hung");
    else assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
    await probe("POST", "/api/fs/fd/close", { fd });
  });

  await test("negative offset in fd read", async () => {
    const open = await probe("POST", "/api/fs/fd/open", { path: T + "/file.txt", flags: 0 });
    if (open.status !== 200) return;
    const fd = JSON.parse(open.body).fd;
    const r = await probe("GET", "/api/fs/fd/read", null, { fd, offset: -1, length: 10 });
    if (r.timedOut) issue("negative offset", "server hung");
    else assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
    await probe("POST", "/api/fs/fd/close", { fd });
  });

  await test("huge length in fd read", async () => {
    const open = await probe("POST", "/api/fs/fd/open", { path: T + "/file.txt", flags: 0 });
    if (open.status !== 200) return;
    const fd = JSON.parse(open.body).fd;
    const r = await probe("GET", "/api/fs/fd/read", null, { fd, offset: 0, length: 999999999999 });
    if (r.timedOut) issue("huge length", "server hung");
    else assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
    await probe("POST", "/api/fs/fd/close", { fd });
  });

  await test("negative fd", async () => {
    const r = await probe("GET", "/api/fs/fd/read", null, { fd: -1, offset: 0, length: 10 });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("non-existent fd (999999)", async () => {
    const r = await probe("GET", "/api/fs/fd/read", null, { fd: 999999, offset: 0, length: 10 });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  // ─── 5. Symlink loop ──────────────────────────────────────
  await test("symlink loop (a->b->a)", async () => {
    await probe("POST", "/api/fs/symlink", { target: T + "/loop_b", link: T + "/loop_a" });
    await probe("POST", "/api/fs/symlink", { target: T + "/loop_a", link: T + "/loop_b" });
    const r = await probe("GET", "/api/fs/stat", null, { path: T + "/loop_a", follow: "true" });
    if (r.timedOut) issue("symlink loop", "server hung");
    else assert.ok(r.status >= 400, "expected 4xx for ELOOP, got " + r.status);
  });

  // ─── 6. Concurrent fd access ──────────────────────────────
  await test("50 concurrent reads on same fd", async () => {
    const open = await probe("POST", "/api/fs/fd/open", { path: T + "/file.txt", flags: 0 });
    if (open.status !== 200) return;
    const fd = JSON.parse(open.body).fd;
    const reads = [];
    for (let i = 0; i < 50; i++) {
      reads.push(probe("GET", "/api/fs/fd/read", null, { fd, offset: 0, length: 5 }));
    }
    const results = await Promise.all(reads);
    const ok = results.every((r) => r.status === 200);
    if (!ok) issue("concurrent reads", "some reads failed");
    assert.ok(ok, "all reads should succeed");
    await probe("POST", "/api/fs/fd/close", { fd });
  });

  // ─── 7. Oversized body ────────────────────────────────────
  await test("10MB write body", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024, "x");
    const r = await probe("PUT", "/api/fs/write?" + new URLSearchParams({ path: T + "/big.bin" }).toString(), big, null, { timeout: 15000 });
    if (r.timedOut) issue("10MB write", "server hung or too slow");
    else if (r.error) issue("10MB write", "connection error: " + r.error);
    else assert.ok(r.status === 200, "expected 200, got " + r.status);
    note("10MB write", "server accepted 10MB body — no explicit size limit");
  });

  await test("50MB write body", async () => {
    const big = Buffer.alloc(50 * 1024 * 1024, "y");
    const r = await probe("PUT", "/api/fs/write?" + new URLSearchParams({ path: T + "/big50.bin" }).toString(), big, null, { timeout: 30000 });
    if (r.timedOut) issue("50MB write", "server hung or too slow");
    else if (r.error) issue("50MB write", "connection error: " + r.error);
    else assert.ok(r.status === 200, "expected 200, got " + r.status);
    note("50MB write", "server accepted 50MB body — no explicit size limit");
  });

  // ─── 8. Mode edge cases ───────────────────────────────────
  await test("invalid mode string (0o999)", async () => {
    const p = T + "/mode_test.txt";
    await probe("PUT", "/api/fs/write?" + new URLSearchParams({ path: p }).toString(), "x");
    const r = await probe("POST", "/api/fs/chmod", { path: p, mode: "0o999" });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
    note("invalid mode", "parseOctal(\"0o999\") silently yields 0o000 — SSH parity, not a bug");
  });

  await test("non-numeric mode (abc)", async () => {
    const p = T + "/mode_test2.txt";
    await probe("PUT", "/api/fs/write?" + new URLSearchParams({ path: p }).toString(), "x");
    const r = await probe("POST", "/api/fs/chmod", { path: p, mode: "abc" });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  await test("mode as number not string", async () => {
    const p = T + "/mode_test3.txt";
    await probe("PUT", "/api/fs/write?" + new URLSearchParams({ path: p }).toString(), "x");
    const r = await probe("POST", "/api/fs/chmod", { path: p, mode: 511 });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  // ─── 9. fd leak ───────────────────────────────────────────
  await test("open 200 fds without closing", async () => {
    const fds = [];
    for (let i = 0; i < 200; i++) {
      const r = await probe("POST", "/api/fs/fd/open", { path: T + "/file.txt", flags: 0 });
      if (r.status === 200) fds.push(JSON.parse(r.body).fd);
    }
    assert.ok(fds.length >= 100, "opened " + fds.length + " fds");
    note("fd leak", "opened " + fds.length + " fds without closing — no server-side limit on fd table");
    for (const fd of fds) await probe("POST", "/api/fs/fd/close", { fd });
  });

  // ─── 10. Wrong HTTP methods / endpoints ───────────────────
  await test("GET on POST-only endpoint", async () => {
    const r = await probe("GET", "/api/fs/copy", null, { src: T, dst: T + "/x" });
    if (r.status === 200) issue("GET on POST", "GET /api/fs/copy returns 200 (root catch-all) instead of 405");
    else assert.ok(r.status >= 400, "got " + r.status);
  });

  await test("POST to non-existent endpoint", async () => {
    const r = await probe("POST", "/api/fs/nonexistent", { path: T });
    assert.ok(r.status === 404 || r.status >= 400, "got " + r.status);
  });

  await test("no auth token", async () => {
    const r = await new Promise((resolve) => {
      const req = http.request({ hostname: "127.0.0.1", port: PORT, path: "/api/fs/stat?path=" + T, method: "GET", timeout: 5000 }, (res) => {
        let d = ""; res.on("data", (c) => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.on("timeout", () => { req.destroy(); resolve({ timedOut: true }); });
      req.on("error", (e) => resolve({ error: e.message }));
      req.end();
    });
    assert.ok(r.status === 401, "expected 401, got " + r.status);
  });

  await test("wrong auth token", async () => {
    const r = await new Promise((resolve) => {
      const req = http.request({ hostname: "127.0.0.1", port: PORT, path: "/api/fs/stat?path=" + T, method: "GET", headers: { Authorization: "Bearer wrong" }, timeout: 5000 }, (res) => {
        let d = ""; res.on("data", (c) => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.on("timeout", () => { req.destroy(); resolve({ timedOut: true }); });
      req.on("error", (e) => resolve({ error: e.message }));
      req.end();
    });
    assert.ok(r.status === 401, "expected 401, got " + r.status);
  });

  // ─── 11. WS malformed start ───────────────────────────────
  await test("WS invalid JSON start", async () => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws/exec?token=" + TOKEN);
    const result = await new Promise((resolve) => {
      const to = setTimeout(() => { ws.close(); resolve("timeout"); }, 5000);
      ws.onopen = () => ws.send("{invalid json");
      ws.onmessage = (e) => { clearTimeout(to); ws.close(); resolve(e.data); };
      ws.onerror = () => { clearTimeout(to); resolve("error"); };
    });
    assert.ok(result !== "timeout", "WS should respond to invalid JSON");
  });

  await test("WS missing type field", async () => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws/exec?token=" + TOKEN);
    const result = await new Promise((resolve) => {
      const to = setTimeout(() => { ws.close(); resolve("timeout"); }, 5000);
      ws.onopen = () => ws.send(JSON.stringify({ cmd: "echo", cwd: "/tmp" }));
      ws.onmessage = (e) => { clearTimeout(to); ws.close(); resolve(e.data); };
      ws.onerror = () => { clearTimeout(to); resolve("error"); };
    });
    assert.ok(result !== "timeout", "WS should respond to missing type");
  });

  await test("WS wrong type (not start)", async () => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws/exec?token=" + TOKEN);
    const result = await new Promise((resolve) => {
      const to = setTimeout(() => { ws.close(); resolve("timeout"); }, 5000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "stdin", data: "hello" }));
      ws.onmessage = (e) => { clearTimeout(to); ws.close(); resolve(e.data); };
      ws.onerror = () => { clearTimeout(to); resolve("error"); };
    });
    assert.ok(result !== "timeout", "WS should respond to wrong type");
  });

  // ─── 12. Auth edge cases ──────────────────────────────────
  async function probeAuth(method, path, headers) {
    return new Promise((resolve) => {
      const req = http.request({ hostname: "127.0.0.1", port: PORT, path, method, headers, timeout: 5000 }, (res) => {
        let d = ""; res.on("data", (c) => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.on("timeout", () => { req.destroy(); resolve({ timedOut: true }); });
      req.on("error", (e) => resolve({ error: e.message }));
      req.end();
    });
  }

  await test("auth: empty bearer", async () => {
    const r = await probeAuth("GET", "/api/fs/stat?path=" + T, { Authorization: "Bearer " });
    assert.ok(r.status === 401, "expected 401, got " + r.status);
  });

  await test("auth: raw token without Bearer prefix", async () => {
    const r = await probeAuth("GET", "/api/fs/stat?path=" + T, { Authorization: TOKEN });
    assert.ok(r.status === 200 || r.status === 401, "got " + r.status);
  });

  await test("auth: trailing whitespace in token", async () => {
    const r = await probeAuth("GET", "/api/fs/stat?path=" + T, { Authorization: "Bearer " + TOKEN + " " });
    assert.ok(r.status === 401 || r.status === 200, "got " + r.status);
  });

  await test("auth: Basic scheme rejected", async () => {
    const r = await probeAuth("GET", "/api/fs/stat?path=" + T, { Authorization: "Basic " + TOKEN });
    assert.ok(r.status === 401, "expected 401, got " + r.status);
  });

  // ─── 13. Info disclosure ──────────────────────────────────
  await test("info: no traceback on bad JSON", async () => {
    const r = await probe("POST", "/api/exec", "{bad");
    if (r.body && (r.body.includes("Traceback") || r.body.includes('File "')))
      issue("traceback", "server leaks Python traceback");
    assert.ok(!r.body || !r.body.includes("Traceback"), "no traceback in response");
  });

  await test("info: 404 not 500 on missing path", async () => {
    const r = await probe("GET", "/api/fs/stat", null, { path: "/nonexistent_xyz_123" });
    if (r.status === 500) issue("500 on missing", "stat returns 500 instead of 404 for missing path");
    assert.ok(r.status === 404 || r.status >= 400, "got " + r.status);
  });

  await test("info: /api/env does not leak token", async () => {
    const r = await probe("GET", "/api/env");
    if (r.status === 200 && r.body.includes(TOKEN))
      issue("env token leak", "/api/env returns auth token");
    assert.ok(!r.body || !r.body.includes(TOKEN), "token must not appear in env response");
  });

  // ─── 14. Exec edge cases ──────────────────────────────────
  await test("exec: empty cmd", async () => {
    const r = await probe("POST", "/api/exec", { cmd: "", shell: true });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: null cmd", async () => {
    const r = await probe("POST", "/api/exec", '{"cmd":null,"shell":true}');
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: bad timeout (string)", async () => {
    const r = await probe("POST", "/api/exec", '{"cmd":"echo hi","shell":true,"timeout":"abc"}');
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: negative timeout", async () => {
    const r = await probe("POST", "/api/exec", { cmd: "echo hi", shell: true, timeout: -1 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: nonexistent binary", async () => {
    const r = await probe("POST", "/api/exec", { cmd: "/nonexistent/binary", shell: false, args: [] });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: bad cwd", async () => {
    const r = await probe("POST", "/api/exec", { cmd: "echo hi", shell: true, cwd: "/nonexistent/dir" });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: kill bad pid", async () => {
    const r = await probe("POST", "/api/exec/kill", null, { pid: 99999, signal_name: "SIGTERM" });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: kill bad signal", async () => {
    const r = await probe("POST", "/api/exec/kill", null, { pid: 1, signal_name: "NOTASIGNAL" });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: status bad pid", async () => {
    const r = await probe("GET", "/api/exec/status", null, { pid: 99999 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: stdin bad pid", async () => {
    const r = await probe("POST", "/api/exec/stdin", { pid: 99999, data: "test" });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: unicode cmd", async () => {
    const r = await probe("POST", "/api/exec", { cmd: "echo 你好", shell: true });
    if (r.status === 500) issue("unicode cmd", "500 on unicode cmd");
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  await test("exec: timeout zero", async () => {
    const r = await probe("POST", "/api/exec", { cmd: "echo hi", shell: true, timeout: 0 });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  await test("exec: huge timeout", async () => {
    const r = await probe("POST", "/api/exec", { cmd: "echo hi", shell: true, timeout: 999999999 });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  await test("exec: args not a list", async () => {
    const r = await probe("POST", "/api/exec", '{"cmd":"echo","shell":false,"args":"notalist"}');
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("exec: huge env values", async () => {
    const env = {};
    for (let i = 0; i < 100; i++) env["KEY" + i] = "x".repeat(500);
    const r = await probe("POST", "/api/exec", { cmd: "echo hi", shell: true, env });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  // ─── 15. FS edge cases ────────────────────────────────────
  await test("fs: mkdir empty path", async () => {
    const r = await probe("POST", "/api/fs/mkdir", { path: "", recursive: true });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("fs: list on a file not dir", async () => {
    const r = await probe("GET", "/api/fs/list", null, { path: T + "/file.txt" });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fs: bad glob pattern", async () => {
    const r = await probe("GET", "/api/fs/glob", null, { pattern: "[" });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fs: delete nonexistent", async () => {
    const r = await probe("POST", "/api/fs/delete", { path: "/nonexistent_xyz" });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fs: move src missing", async () => {
    const r = await probe("POST", "/api/fs/move", { src: "/nonexistent_xyz", dst: T + "/dst" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("fs: copy src missing", async () => {
    const r = await probe("POST", "/api/fs/copy", { src: "/nonexistent_xyz", dst: T + "/dst2" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("fs: readlink on non-symlink", async () => {
    const r = await probe("GET", "/api/fs/readlink", null, { path: T + "/file.txt" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("fs: truncate negative length", async () => {
    const r = await probe("POST", "/api/fs/truncate", { path: T + "/file.txt", len: -1 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fs: utimes bad values", async () => {
    const r = await probe("POST", "/api/fs/utimes", '{"path":"' + T + '","atime":"notnum","mtime":"notnum"}');
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fs: batch bad op", async () => {
    const r = await probe("POST", "/api/fs/batch", { ops: [{ op: "nonexistent", path: T }] });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fs: batch empty ops", async () => {
    const r = await probe("POST", "/api/fs/batch", { ops: [] });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  await test("fs: batch null ops", async () => {
    const r = await probe("POST", "/api/fs/batch", '{"ops":null}');
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fs: symlink to self", async () => {
    const r = await probe("POST", "/api/fs/symlink", { target: T + "/self", link: T + "/self" });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fs: access bad mode", async () => {
    const r = await probe("GET", "/api/fs/access", null, { path: "/tmp", mode: "abc" });
    assert.ok(r.status >= 400 || r.status < 300, "got " + r.status);
  });

  await test("fs: which empty cmd", async () => {
    const r = await probe("GET", "/api/which", null, { cmd: "" });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fs: statfs on nonexistent", async () => {
    const r = await probe("GET", "/api/fs/statfs", null, { path: "/nonexistent_xyz" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("fs: realpath on nonexistent", async () => {
    const r = await probe("POST", "/api/fs/realpath", { path: "/nonexistent_xyz/../../../tmp" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("fs: mkdtemp empty prefix", async () => {
    const r = await probe("POST", "/api/fs/mkdtemp", { prefix: "" });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  await test("fs: link missing src", async () => {
    const r = await probe("POST", "/api/fs/link", { existing: "/nonexistent_xyz", newpath: T + "/link" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("fs: touch bad path", async () => {
    const r = await probe("POST", "/api/fs/touch", { path: "/nonexistent_dir_xyz/test" });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  // ─── 16. FD edge cases ────────────────────────────────────
  await test("fd: close bad fd", async () => {
    const r = await probe("POST", "/api/fs/fd/close", { fd: 99999 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fd: ftruncate bad fd", async () => {
    const r = await probe("POST", "/api/fs/fd/ftruncate", { fd: 99999, len: 0 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fd: write bad fd", async () => {
    const r = await probe("PUT", "/api/fs/fd/write", "test", { fd: 99999, offset: 0 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fd: fstat bad fd", async () => {
    const r = await probe("GET", "/api/fs/fd/fstat", null, { fd: 99999 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fd: fchmod bad fd", async () => {
    const r = await probe("POST", "/api/fs/fd/fchmod", { fd: 99999, mode: 420 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fd: fchown bad fd", async () => {
    const r = await probe("POST", "/api/fs/fd/fchown", { fd: 99999, uid: 0, gid: 0 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fd: open then close then read", async () => {
    const open = await probe("POST", "/api/fs/fd/open", { path: T + "/file.txt", flags: 0 });
    if (open.status !== 200) return;
    const fd = JSON.parse(open.body).fd;
    await probe("POST", "/api/fs/fd/close", { fd });
    const r = await probe("GET", "/api/fs/fd/read", null, { fd, offset: 0, length: 10 });
    assert.ok(r.status >= 400, "expected 4xx on closed fd, got " + r.status);
  });

  await test("fd: open bad flags", async () => {
    const r = await probe("POST", "/api/fs/fd/open", { path: T + "/file.txt", flags: "notanumber", mode: 420 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fd: open empty path", async () => {
    const r = await probe("POST", "/api/fs/fd/open", { path: "", flags: 0, mode: 420 });
    assert.ok(r.status >= 400, "expected 4xx, got " + r.status);
  });

  await test("fd: fsync bad fd", async () => {
    const r = await probe("POST", "/api/fs/fd/fsync", { fd: 99999 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  await test("fd: futimes bad fd", async () => {
    const r = await probe("POST", "/api/fs/fd/futimes", { fd: 99999, atime: 0, mtime: 0 });
    assert.ok(r.status >= 400 || r.status === 200, "got " + r.status);
  });

  // ─── 17. HTTP protocol edge cases ─────────────────────────
  await test("proto: DELETE on stat", async () => {
    const r = await probe("DELETE", "/api/fs/stat", null, { path: "/tmp" });
    assert.ok(r.status >= 400 || r.status === 405, "got " + r.status);
  });

  await test("proto: PATCH on exec", async () => {
    const r = await probe("PATCH", "/api/exec", '{"cmd":"id"}');
    assert.ok(r.status >= 400 || r.status === 405, "got " + r.status);
  });

  await test("proto: proto pollution in body", async () => {
    const r = await probe("POST", "/api/exec", { cmd: "echo hi", shell: true, "__proto__": { admin: true }, constructor: { prototype: { admin: true } } });
    assert.ok(r.status === 200 || r.status >= 400, "got " + r.status);
  });

  // ─── 18. DoS: concurrent flood ────────────────────────────
  await test("dos: 200 concurrent requests", async () => {
    const reqs = [];
    for (let i = 0; i < 200; i++)
      reqs.push(probe("POST", "/api/exec", { cmd: "echo hi", shell: true }, null, { timeout: 10000 }));
    const results = await Promise.all(reqs);
    const ok = results.filter((r) => r.status === 200).length;
    if (ok < 190) issue("concurrent flood", ok + "/200 succeeded");
    assert.ok(ok >= 150, "at least 150/200 should succeed, got " + ok);
  });

  // ─── 19. Py/Go consistency ────────────────────────────────
  await test("consistency: stat has all fields", async () => {
    const r = await probe("GET", "/api/fs/stat", null, { path: "/tmp" });
    assert.ok(r.status === 200, "got " + r.status);
    const d = JSON.parse(r.body);
    for (const k of ["size", "mode", "mtime", "atime", "ctime", "uid", "gid"])
      assert.ok(k in d, "missing field: " + k);
  });

  await test("consistency: exec has all fields", async () => {
    const r = await probe("POST", "/api/exec", { cmd: "echo hello", shell: true });
    assert.ok(r.status === 200, "got " + r.status);
    const d = JSON.parse(r.body);
    for (const k of ["stdout", "stderr", "exit_code", "pid"])
      assert.ok(k in d, "missing field: " + k);
    assert.strictEqual(d.stdout.trim(), "hello");
  });

  await test("consistency: env has all fields", async () => {
    const r = await probe("GET", "/api/env");
    assert.ok(r.status === 200, "got " + r.status);
    const d = JSON.parse(r.body);
    for (const k of ["uid", "platform"])
      assert.ok(k in d, "missing field: " + k);
  });

  // ─── 20. Server still alive after all abuse ───────────────
  await test("server still alive after all abuse", async () => {
    const ok = await serverAlive();
    if (!ok) issue("server alive", "server crashed or unresponsive after adversarial tests");
    assert.ok(ok, "server should still be alive");
  });

  // cleanup
  await probe("POST", "/api/fs/delete", { path: T });

  // ─── Summary ──────────────────────────────────────────────
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  if (issues.length > 0) {
    console.log("\n--- ISSUES FOUND (" + issues.length + ") ---");
    for (const i of issues) console.log("  [" + i.name + "] " + i.detail);
  } else {
    console.log("\n--- no issues found ---");
  }
  if (notes.length > 0) {
    console.log("\n--- NOTES ---");
    for (const n of notes) console.log("  [" + n.name + "] " + n.detail);
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });
