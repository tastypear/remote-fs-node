"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_v26_test";
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); failed++; }
}

async function run() {
  console.log("=== v22->v26 fs feature test suite ===\n");
  try { await fs.promises.rm(TESTDIR, { recursive: true }); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/a.txt", "aaa");
  await fs.promises.writeFile(TESTDIR + "/b.json", "{}");
  await fs.promises.mkdir(TESTDIR + "/sub");
  await fs.promises.writeFile(TESTDIR + "/sub/c.txt", "ccc");
  await fs.promises.writeFile(TESTDIR + "/sub/d.json", "[]");
  await fs.promises.writeFile(TESTDIR + "/.hidden", "h");

  // ─── glob ──────────────────────────────────────────
  await test("globSync basic", async () => {
    const r = fs.globSync("*.txt", { cwd: TESTDIR });
    assert.deepStrictEqual(r.sort(), ["a.txt"]);
  });

  await test("globSync ** recursive", async () => {
    const r = fs.globSync("**/*.json", { cwd: TESTDIR });
    assert.deepStrictEqual(r.sort(), ["b.json", "sub/d.json"]);
  });

  await test("globSync withFileTypes + parentPath", async () => {
    const r = fs.globSync("sub/*.txt", { cwd: TESTDIR, withFileTypes: true });
    assert.strictEqual(r.length, 1);
    assert.ok(r[0] instanceof fs.Dirent, "should be Dirent");
    assert.strictEqual(r[0].name, "c.txt");
    assert.strictEqual(r[0].parentPath, "sub");
    assert.strictEqual(r[0].isFile(), true);
  });

  await test("globSync exclude array", async () => {
    const r = fs.globSync("*.json", { cwd: TESTDIR, exclude: ["b.json"] });
    assert.deepStrictEqual(r, []);
  });

  await test("globSync exclude function", async () => {
    const r = fs.globSync("*", { cwd: TESTDIR, exclude: (p) => p.endsWith(".json") });
    assert.ok(r.includes("a.txt"));
    assert.ok(!r.includes("b.json"));
  });

  await test("globSync includeHidden default false", async () => {
    const r = fs.globSync("*", { cwd: TESTDIR });
    assert.ok(!r.includes(".hidden"), "hidden file should be excluded by default");
  });

  await test("globSync includeHidden true", async () => {
    const r = fs.globSync("*", { cwd: TESTDIR, includeHidden: true });
    assert.ok(r.includes(".hidden"));
  });

  await test("promises.glob async iterator", async () => {
    const it = fs.promises.glob("*.txt", { cwd: TESTDIR });
    assert.strictEqual(typeof it.next, "function");
    const collected = [];
    for await (const p of it) collected.push(p);
    assert.deepStrictEqual(collected.sort(), ["a.txt"]);
  });

  await test("promises.glob withFileTypes async", async () => {
    const it = fs.promises.glob("a.txt", { cwd: TESTDIR, withFileTypes: true });
    const first = await it.next();
    assert.ok(first.value instanceof fs.Dirent);
    assert.strictEqual(first.value.parentPath, ".");
    await it.return();
  });

  await test("fs.glob callback style", async () => {
    const matches = await new Promise((res, rej) => {
      fs.glob("*.json", { cwd: TESTDIR }, (err, m) => err ? rej(err) : res(m));
    });
    assert.deepStrictEqual(matches.sort(), ["b.json"]);
  });

  // ─── Dirent.parentPath (readdir/opendir) ───────────
  await test("readdir withFileTypes parentPath", async () => {
    const d = await fs.promises.readdir(TESTDIR, { withFileTypes: true });
    const a = d.find((x) => x.name === "a.txt");
    assert.strictEqual(a.parentPath, TESTDIR);
  });

  await test("opendir Dirent parentPath + Dir dispose", async () => {
    const dir = await fs.promises.opendir(TESTDIR);
    const first = await dir.read();
    assert.strictEqual(first.parentPath, TESTDIR);
    // [Symbol.asyncDispose] closes the dir
    await dir[Symbol.asyncDispose]();
    const after = await dir.read();
    assert.strictEqual(after, null); // closed → read returns null
  });

  await test("Dir Symbol.dispose (sync)", async () => {
    const dir = fs.opendirSync(TESTDIR);
    dir[Symbol.dispose]();
    assert.strictEqual(dir.readSync(), null); // closed
  });

  // ─── mkdtempDisposable ─────────────────────────────
  await test("mkdtempDisposableSync + dispose", async () => {
    const d = fs.mkdtempDisposableSync("/tmp/rfs_v26_disposable_");
    assert.strictEqual(typeof d.path, "string");
    assert.ok(fs.existsSync(d.path));
    assert.strictEqual(typeof d.remove, "function");
    assert.strictEqual(typeof d[Symbol.dispose], "function");
    d[Symbol.dispose]();
    assert.ok(!fs.existsSync(d.path), "dispose should remove the dir");
    // idempotent
    d[Symbol.dispose]();
  });

  await test("promises.mkdtempDisposable + asyncDispose", async () => {
    const d = await fs.promises.mkdtempDisposable("/tmp/rfs_v26_pdisposable_");
    assert.strictEqual(typeof d.path, "string");
    assert.ok(fs.existsSync(d.path));
    assert.strictEqual(typeof d[Symbol.asyncDispose], "function");
    await d[Symbol.asyncDispose]();
    assert.ok(!fs.existsSync(d.path));
  });

  // ─── FileHandle parity ─────────────────────────────
  await test("FileHandle [Symbol.asyncDispose]", async () => {
    const fd = await fs.promises.open(TESTDIR + "/a.txt", "r");
    assert.strictEqual(typeof fd[Symbol.asyncDispose], "function");
    await fd[Symbol.asyncDispose](); // should close without error
  });

  await test("FileHandle.writeFile + readFile", async () => {
    const fd = await fs.promises.open(TESTDIR + "/fh_rw.txt", "w");
    await fd.writeFile("hello");
    await fd.close();
    const fd2 = await fs.promises.open(TESTDIR + "/fh_rw.txt", "r");
    const data = await fd2.readFile("utf8");
    assert.strictEqual(data, "hello");
    await fd2.close();
  });

  await test("FileHandle.appendFile", async () => {
    const fd = await fs.promises.open(TESTDIR + "/fh_app.txt", "w");
    await fd.writeFile("hello");
    await fd.appendFile("world");
    await fd.close();
    assert.strictEqual(await fs.promises.readFile(TESTDIR + "/fh_app.txt", "utf8"), "helloworld");
  });

  await test("FileHandle.readv", async () => {
    await fs.promises.writeFile(TESTDIR + "/fh_rv.txt", "0123456789");
    const fd = await fs.promises.open(TESTDIR + "/fh_rv.txt", "r");
    const b1 = Buffer.alloc(5), b2 = Buffer.alloc(5);
    const { bytesRead, buffers } = await fd.readv([b1, b2], 0);
    assert.strictEqual(bytesRead, 10);
    assert.strictEqual(buffers[0].toString(), "01234");
    assert.strictEqual(buffers[1].toString(), "56789");
    await fd.close();
  });

  await test("FileHandle.writev", async () => {
    const fd = await fs.promises.open(TESTDIR + "/fh_wv.txt", "w");
    await fd.writev([Buffer.from("AAA"), Buffer.from("BBB")], 0);
    await fd.close();
    assert.strictEqual(await fs.promises.readFile(TESTDIR + "/fh_wv.txt", "utf8"), "AAABBB");
  });

  await test("FileHandle.datasync + getAsyncId", async () => {
    const fd = await fs.promises.open(TESTDIR + "/fh_ds.txt", "w");
    await fd.writeFile("x");
    await fd.datasync();
    assert.strictEqual(typeof fd.getAsyncId(), "number");
    await fd.close();
  });

  await test("FileHandle.createReadStream + createWriteStream", async () => {
    const fd = await fs.promises.open(TESTDIR + "/fh_stream.txt", "w");
    const ws = fd.createWriteStream();
    await new Promise((res, rej) => { ws.write("fhstream"); ws.end(); ws.on("finish", res); ws.on("error", rej); });
    await fd.close();
    const fd2 = await fs.promises.open(TESTDIR + "/fh_stream.txt", "r");
    const rs = fd2.createReadStream("utf8");
    let c = "";
    await new Promise((res) => { rs.on("data", (d) => c += d); rs.on("end", res); });
    assert.strictEqual(c, "fhstream");
    await fd2.close();
  });

  // ─── stream signal + flush ─────────────────────────
  await test("createReadStream AbortSignal", async () => {
    const ac = new AbortController();
    const rs = fs.createReadStream(TESTDIR + "/a.txt", { signal: ac.signal });
    const err = await new Promise((res) => {
      rs.on("error", (e) => res(e));
      ac.abort();
    });
    assert.strictEqual(err.code, "ABORT_ERR");
    assert.ok(rs.destroyed);
  });

  await test("createWriteStream AbortSignal", async () => {
    const ac = new AbortController();
    const ws = fs.createWriteStream(TESTDIR + "/abort_ws.txt", { signal: ac.signal });
    const err = await new Promise((res) => {
      ws.on("error", (e) => res(e));
      ws.write("data");
      ac.abort();
    });
    assert.strictEqual(err.code, "ABORT_ERR");
  });

  await test("createWriteStream flush option", async () => {
    const ws = fs.createWriteStream(TESTDIR + "/flush.txt", { flush: true });
    await new Promise((res, rej) => { ws.write("flushed"); ws.end(); ws.on("finish", res); ws.on("error", rej); });
    assert.strictEqual(await fs.promises.readFile(TESTDIR + "/flush.txt", "utf8"), "flushed");
  });

  // ─── cp async filter ───────────────────────────────
  await test("cp Promise-returning filter", async () => {
    await fs.promises.mkdir(TESTDIR + "/cpsrc/sub", { recursive: true });
    await fs.promises.writeFile(TESTDIR + "/cpsrc/keep.txt", "k");
    await fs.promises.writeFile(TESTDIR + "/cpsrc/skip.txt", "s");
    let filterCalled = false;
    await fs.promises.cp(TESTDIR + "/cpsrc", TESTDIR + "/cpdst", {
      recursive: true,
      filter: async (src, dest) => { filterCalled = true; return src.endsWith("keep.txt") || src.endsWith("cpsrc") || src.endsWith("sub"); },
    });
    assert.ok(filterCalled, "async filter should be called");
    assert.ok(fs.existsSync(TESTDIR + "/cpdst/keep.txt"));
    assert.ok(!fs.existsSync(TESTDIR + "/cpdst/skip.txt"));
  });

  // ─── statfs frsize ─────────────────────────────────
  await test("statfs has frsize field", async () => {
    const s = fs.statfsSync(TESTDIR);
    assert.ok("frsize" in s, "statfs should have frsize");
    assert.ok(typeof s.frsize === "number");
    const ps = await fs.promises.statfs(TESTDIR);
    assert.ok("frsize" in ps);
  });

  // ─── parity: promises.openAsBlob removed ───────────
  await test("promises.openAsBlob undefined (parity)", async () => {
    assert.strictEqual(fs.promises.openAsBlob, undefined);
    // top-level openAsBlob still present
    assert.strictEqual(typeof fs.openAsBlob, "function");
  });

  try { await fs.promises.rm(TESTDIR, { recursive: true }); } catch {}
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });
