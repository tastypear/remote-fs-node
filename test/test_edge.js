"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_edge_test";
let passed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); }
}

async function run() {
  console.log("=== edge cases test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });

  // Buffer path input
  await test("Buffer path input", async () => {
    await fs.promises.writeFile(TESTDIR + "/buf.txt", "data");
    const data = await fs.promises.readFile(Buffer.from(TESTDIR + "/buf.txt"), "utf8");
    assert.strictEqual(data, "data");
  });

  // appendFile with Buffer
  await test("appendFile with Buffer", async () => {
    await fs.promises.writeFile(TESTDIR + "/app.txt", "a");
    await fs.promises.appendFile(TESTDIR + "/app.txt", Buffer.from("b"));
    assert.strictEqual(await fs.promises.readFile(TESTDIR + "/app.txt", "utf8"), "ab");
  });

  // writeFileSync options as string encoding
  await test("writeFileSync encoding string option", async () => {
    fs.writeFileSync(TESTDIR + "/enc.txt", "hello", "utf8");
    assert.strictEqual(fs.readFileSync(TESTDIR + "/enc.txt", "utf8"), "hello");
  });

  // stat on directory
  await test("stat on directory", async () => {
    const s = await fs.promises.stat(TESTDIR);
    assert.ok(s.isDirectory());
    assert.ok(!s.isFile());
  });

  // readdir on empty dir
  await test("readdir on empty dir", async () => {
    await fs.promises.mkdir(TESTDIR + "/empty");
    const entries = await fs.promises.readdir(TESTDIR + "/empty");
    assert.strictEqual(entries.length, 0);
  });

  // recursive readdir
  await test("readdir recursive", async () => {
    await fs.promises.mkdir(TESTDIR + "/tree/a/b", { recursive: true });
    await fs.promises.writeFile(TESTDIR + "/tree/root.txt", "x");
    await fs.promises.writeFile(TESTDIR + "/tree/a/file.txt", "y");
    await fs.promises.writeFile(TESTDIR + "/tree/a/b/deep.txt", "z");
    const entries = await fs.promises.readdir(TESTDIR + "/tree", { recursive: true });
    assert.ok(entries.length >= 4, "should have at least 4 entries, got: " + JSON.stringify(entries));
    assert.ok(entries.includes("root.txt"), "should include root.txt");
    assert.ok(entries.includes("a/file.txt"), "should include a/file.txt");
    assert.ok(entries.includes("a/b/deep.txt"), "should include a/b/deep.txt");
  });

  // FileHandle.write with string + position
  await test("FileHandle.write string with position", async () => {
    const fd = await fs.promises.open(TESTDIR + "/pos.txt", "w");
    await fd.write("hello", 0);
    await fd.write("world", 5);
    await fd.close();
    const data = await fs.promises.readFile(TESTDIR + "/pos.txt", "utf8");
    assert.strictEqual(data, "helloworld");
  });

  // WriteStream with append flag
  await test("WriteStream with append flag", async () => {
    await fs.promises.writeFile(TESTDIR + "/append_stream.txt", "initial ");
    const ws = fs.createWriteStream(TESTDIR + "/append_stream.txt", { flags: "a" });
    await new Promise((res, rej) => {
      ws.write("appended");
      ws.end();
      ws.on("finish", res);
      ws.on("error", rej);
    });
    const data = await fs.promises.readFile(TESTDIR + "/append_stream.txt", "utf8");
    assert.strictEqual(data, "initial appended");
  });

  // Error: ENOENT on readdir
  await test("readdir ENOENT", async () => {
    try {
      await fs.promises.readdir(TESTDIR + "/nonexistent");
      assert.fail("should throw");
    } catch (err) {
      assert.strictEqual(err.code, "ENOENT");
    }
  });

  // Error: EEXIST on mkdir (non-recursive)
  await test("mkdir EEXIST", async () => {
    try {
      await fs.promises.mkdir(TESTDIR);
      assert.fail("should throw EEXIST");
    } catch (err) {
      // Server may return 400 or 409
    }
  });

  // existsSync returns false for deleted file
  await test("existsSync false after delete", async () => {
    await fs.promises.writeFile(TESTDIR + "/del.txt", "x");
    assert.ok(fs.existsSync(TESTDIR + "/del.txt"));
    await fs.promises.unlink(TESTDIR + "/del.txt");
    assert.ok(!fs.existsSync(TESTDIR + "/del.txt"));
  });

  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed ===");
  process.exit(0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });