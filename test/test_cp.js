"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_cp_test";
let passed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); }
}

async function run() {
  console.log("=== cp recursive test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR + "/src/sub", { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/src/f1.txt", "file1");
  await fs.promises.writeFile(TESTDIR + "/src/sub/f2.txt", "file2");
  await fs.promises.writeFile(TESTDIR + "/src/sub/f3.txt", "file3");

  await test("cp recursive directory", async () => {
    await fs.promises.cp(TESTDIR + "/src", TESTDIR + "/dst", { recursive: true });
    assert.ok(fs.existsSync(TESTDIR + "/dst/f1.txt"));
    assert.ok(fs.existsSync(TESTDIR + "/dst/sub/f2.txt"));
    assert.ok(fs.existsSync(TESTDIR + "/dst/sub/f3.txt"));
    const data = await fs.promises.readFile(TESTDIR + "/dst/f1.txt", "utf8");
    assert.strictEqual(data, "file1");
  });

  await test("cp single file", async () => {
    await fs.promises.cp(TESTDIR + "/src/f1.txt", TESTDIR + "/single_copy.txt");
    assert.ok(fs.existsSync(TESTDIR + "/single_copy.txt"));
  });

  await test("cp with filter (exclude f2.txt)", async () => {
    await fs.promises.cp(TESTDIR + "/src", TESTDIR + "/filtered", {
      recursive: true,
      filter: (src, dest) => !src.endsWith("f2.txt"),
    });
    assert.ok(fs.existsSync(TESTDIR + "/filtered/f1.txt"));
    assert.ok(!fs.existsSync(TESTDIR + "/filtered/sub/f2.txt"));
    assert.ok(fs.existsSync(TESTDIR + "/filtered/sub/f3.txt"));
  });

  await test("cpSync recursive", async () => {
    fs.cpSync(TESTDIR + "/src", TESTDIR + "/sync_dst", { recursive: true });
    assert.ok(fs.existsSync(TESTDIR + "/sync_dst/f1.txt"));
    assert.ok(fs.existsSync(TESTDIR + "/sync_dst/sub/f2.txt"));
  });

  await test("cp non-recursive on dir throws EISDIR", async () => {
    try {
      await fs.promises.cp(TESTDIR + "/src", TESTDIR + "/err", { recursive: false });
      assert.fail("should throw EISDIR");
    } catch (err) {
      assert.strictEqual(err.code, "EISDIR");
    }
  });

  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed ===");
  process.exit(0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });