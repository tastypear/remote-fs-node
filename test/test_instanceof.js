"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_instanceof_test";
let passed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); }
}

async function run() {
  console.log("=== instanceof test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/file.txt", "content");

  await test("stat returns instanceof Stats", async () => {
    const s = await fs.promises.stat(TESTDIR + "/file.txt");
    assert.ok(s instanceof fs.Stats, "stat should return instanceof Stats");
  });

  await test("statSync returns instanceof Stats", async () => {
    const s = fs.statSync(TESTDIR + "/file.txt");
    assert.ok(s instanceof fs.Stats, "statSync should return instanceof Stats");
  });

  await test("lstat returns instanceof Stats", async () => {
    await fs.promises.symlink(TESTDIR + "/file.txt", TESTDIR + "/link.txt");
    const s = await fs.promises.lstat(TESTDIR + "/link.txt");
    assert.ok(s instanceof fs.Stats, "lstat should return instanceof Stats");
    assert.ok(s.isSymbolicLink(), "should detect symlink");
  });

  await test("readdir withFileTypes returns instanceof Dirent", async () => {
    const entries = await fs.promises.readdir(TESTDIR, { withFileTypes: true });
    for (const e of entries) {
      assert.ok(e instanceof fs.Dirent, "each entry should be instanceof Dirent: " + e.name);
    }
  });

  await test("readdirSync withFileTypes returns instanceof Dirent", async () => {
    const entries = fs.readdirSync(TESTDIR, { withFileTypes: true });
    for (const e of entries) {
      assert.ok(e instanceof fs.Dirent, "each entry should be instanceof Dirent: " + e.name);
    }
  });

  await test("fstat returns instanceof Stats", async () => {
    const fd = await fs.promises.open(TESTDIR + "/file.txt", "r");
    const s = await fd.stat();
    assert.ok(s instanceof fs.Stats, "fstat should return instanceof Stats");
    await fd.close();
  });

  await test("Stats methods work correctly", async () => {
    const s = await fs.promises.stat(TESTDIR + "/file.txt");
    assert.ok(s.isFile());
    assert.ok(!s.isDirectory());
    assert.ok(!s.isSocket());
    assert.ok(!s.isFIFO());
    assert.ok(!s.isBlockDevice());
    assert.ok(!s.isCharacterDevice());
    assert.strictEqual(s.size, 7);
  });

  await test("Stats has bigint conversion", async () => {
    const s = await fs.promises.stat(TESTDIR + "/file.txt");
    const b = s.toBigInt();
    assert.strictEqual(typeof b.size, "bigint");
    assert.strictEqual(b.size, 7n);
  });

  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed ===");
  process.exit(0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });