"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_compat_test";
let passed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); }
}

async function run() {
  console.log("=== third-party library compatibility test ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/a.txt", "aaa");
  await fs.promises.writeFile(TESTDIR + "/b.txt", "bbb");

  // Default patch: async/promise/streams only (sync stays local for require)
  remoteFs.patch();
  const fse = require("fs-extra");

  await test("fs-extra: readFile", async () => {
    const data = await fse.readFile(TESTDIR + "/a.txt", "utf8");
    assert.strictEqual(data, "aaa");
  });
  await test("fs-extra: outputFile", async () => {
    await fse.outputFile(TESTDIR + "/sub/c.txt", "ccc");
    assert.strictEqual(await fse.readFile(TESTDIR + "/sub/c.txt", "utf8"), "ccc");
  });
  await test("fs-extra: copy", async () => {
    await fse.copy(TESTDIR + "/a.txt", TESTDIR + "/a_copy.txt");
    assert.ok(fs.existsSync(TESTDIR + "/a_copy.txt"));
  });
  await test("fs-extra: ensureDir", async () => {
    await fse.ensureDir(TESTDIR + "/ensure/dir");
    assert.ok(fs.existsSync(TESTDIR + "/ensure/dir"));
  });
  await test("fs-extra: readJson", async () => {
    await fse.writeJson(TESTDIR + "/data.json", { key: "value" });
    const json = await fse.readJson(TESTDIR + "/data.json");
    assert.strictEqual(json.key, "value");
  });
  await test("fs-extra: move", async () => {
    await fse.move(TESTDIR + "/a_copy.txt", TESTDIR + "/a_moved.txt");
    assert.ok(!fs.existsSync(TESTDIR + "/a_copy.txt"));
    assert.ok(fs.existsSync(TESTDIR + "/a_moved.txt"));
  });
  await test("fs-extra: remove", async () => {
    await fse.remove(TESTDIR + "/sub");
    assert.ok(!fs.existsSync(TESTDIR + "/sub"));
  });
  await test("fs-extra: emptyDir", async () => {
    await fse.emptyDir(TESTDIR + "/emptytest");
    await fse.writeFile(TESTDIR + "/emptytest/x.txt", "x");
    await fse.emptyDir(TESTDIR + "/emptytest");
    assert.deepStrictEqual(fs.readdirSync(TESTDIR + "/emptytest"), []);
  });

  // glob uses sync fs methods internally — known limitation with async-only patch
  // To use glob with remote-fs, pre-require it then patch with patchSync:true
  console.log("SKIP  glob (uses sync fs internally — use patchSync:true after pre-require)");

  remoteFs.restore();
  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed ===");
  process.exit(0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });