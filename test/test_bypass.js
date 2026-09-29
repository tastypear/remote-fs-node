"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const path = require("path");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_bypass_test";
let passed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); }
}

async function run() {
  console.log("=== bypass test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/remote.txt", "remote content");

  // Create a local file for bypass test
  const localFile = path.join(__dirname, "local_bypass_test.txt");
  require("fs").writeFileSync(localFile, "local content");

  remoteFs.patch();

  await test("bypass reads local file", async () => {
    const data = remoteFs.bypass(() => {
      // This should use real fs, not HTTP
      const realFs = require("fs");
      return realFs.readFileSync(localFile, "utf8");
    });
    assert.strictEqual(data, "local content");
  });

  await test("bypass async returns promise", async () => {
    const data = await remoteFs.bypass(async () => {
      const realFs = require("fs");
      return await realFs.promises.readFile(localFile, "utf8");
    });
    assert.strictEqual(data, "local content");
  });

  await test("non-bypass reads remote file", async () => {
    const patchedFs = require("fs");
    const data = await patchedFs.promises.readFile(TESTDIR + "/remote.txt", "utf8");
    assert.strictEqual(data, "remote content");
  });

  await test("bypass then back to remote", async () => {
    // Read local
    const local = remoteFs.bypass(() => require("fs").readFileSync(localFile, "utf8"));
    assert.strictEqual(local, "local content");

    // Read remote (should work after bypass ends)
    const patchedFs = require("fs");
    const remote = await patchedFs.promises.readFile(TESTDIR + "/remote.txt", "utf8");
    assert.strictEqual(remote, "remote content");
  });

  await test("isInBypass flag", async () => {
    assert.strictEqual(remoteFs.isInBypass(), false);
    remoteFs.bypass(() => {
      assert.strictEqual(remoteFs.isInBypass(), true);
    });
    assert.strictEqual(remoteFs.isInBypass(), false);
  });

  await test("bypass with error restores patch", async () => {
    try {
      remoteFs.bypass(() => { throw new Error("test error"); });
    } catch (e) {
      // Expected
    }
    assert.strictEqual(remoteFs.isInBypass(), false);
    // Remote should still work
    const patchedFs = require("fs");
    const data = await patchedFs.promises.readFile(TESTDIR + "/remote.txt", "utf8");
    assert.strictEqual(data, "remote content");
  });

  remoteFs.restore();
  require("fs").unlinkSync(localFile);
  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed ===");
  process.exit(0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });