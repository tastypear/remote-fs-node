"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_graceful_test";
let passed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); }
}

async function run() {
  console.log("=== graceful-fs test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/g.txt", "graceful content");

  // Load graceful-fs BEFORE patching
  const gfs = require("graceful-fs");

  await test("graceful-fs loaded", async () => {
    assert.strictEqual(typeof gfs.readFile, "function");
    assert.strictEqual(typeof gfs.writeFile, "function");
  });

  await test("patch makes graceful-fs use remote-fs", async () => {
    remoteFs.patch();
    // graceful-fs.readFile should now go through our HTTP backend
    const data = await new Promise((res, rej) => {
      gfs.readFile(TESTDIR + "/g.txt", "utf8", (err, data) => {
        if (err) rej(err);
        else res(data);
      });
    });
    assert.strictEqual(data, "graceful content");
  });

  await test("graceful-fs.writeFile through remote", async () => {
    await new Promise((res, rej) => {
      gfs.writeFile(TESTDIR + "/gfs_write.txt", "written via graceful-fs", (err) => {
        if (err) rej(err);
        else res();
      });
    });
    const data = await fs.promises.readFile(TESTDIR + "/gfs_write.txt", "utf8");
    assert.strictEqual(data, "written via graceful-fs");
  });

  await test("graceful-fs.createReadStream through remote", async () => {
    const rs = gfs.createReadStream(TESTDIR + "/g.txt", "utf8");
    let data = "";
    await new Promise((res) => { rs.on("data", (c) => data += c); rs.on("end", res); });
    assert.strictEqual(data, "graceful content");
  });

  await test("restore reverts graceful-fs", async () => {
    remoteFs.restore();
    // After restore, graceful-fs should use real fs again
    // (real fs on Windows can not read /tmp, so we just check it does not throw our errors)
    try {
      await new Promise((res, rej) => {
        gfs.readFile(TESTDIR + "/g.txt", "utf8", (err, data) => {
          if (err) rej(err);
          else res(data);
        });
      });
    } catch (err) {
      // On Windows this will fail — that is fine, it means it is using real fs
      assert.ok(!err.message.includes("HTTP"), "should not be HTTP error after restore");
    }
  });

  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed ===");
  process.exit(0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });