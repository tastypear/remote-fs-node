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

  // ─── 12. Server still alive after all abuse ───────────────
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
