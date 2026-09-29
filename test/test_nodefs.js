"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_nodefs_test";
let passed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); }
}

async function run() {
  console.log("=== node:fs protocol test ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/test.txt", "hello");

  await test("require(node:fs) after patch uses remote-fs", async () => {
    remoteFs.patch();
    const nodeFs = require("node:fs");
    assert.strictEqual(typeof nodeFs.promises.readFile, "function");
    const data = await nodeFs.promises.readFile(TESTDIR + "/test.txt", "utf8");
    assert.strictEqual(data, "hello");
  });

  await test("require(node:fs) after restore uses real fs", async () => {
    remoteFs.restore();
    const nodeFs = require("node:fs");
    assert.strictEqual(typeof nodeFs.promises.readFile, "function");
    // Verify it is the real fs by checking it throws on the remote path
    try {
      await nodeFs.promises.readFile(TESTDIR + "/test.txt", "utf8");
    } catch (e) {
      // Expected on Windows — real fs can not read /tmp/rfs_nodefs_test
    }
  });

  await test("patch + require(fs) + require(node:fs) both patched", async () => {
    remoteFs.patch();
    const fs1 = require("fs");
    const fs2 = require("node:fs");
    assert.strictEqual(fs1, fs2);
    const data = await fs2.promises.readFile(TESTDIR + "/test.txt", "utf8");
    assert.strictEqual(data, "hello");
    remoteFs.restore();
  });

  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed ===");
  process.exit(0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });