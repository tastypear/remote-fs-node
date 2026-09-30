"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_binding_test";
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); failed++; }
}

async function run() {
  console.log("=== binding layer test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/bind.txt", "binding content");

  // Patch with binding support
  remoteFs.patch();
  const patchedFs = require("fs");

  await test("binding: promise stat", async () => {
    const s = await patchedFs.promises.stat(TESTDIR + "/bind.txt");
    assert.ok(s.isFile());
    assert.strictEqual(s.size, 15);
  });

  await test("binding: promise readFile", async () => {
    const data = await patchedFs.promises.readFile(TESTDIR + "/bind.txt", "utf8");
    assert.strictEqual(data, "binding content");
  });

  await test("binding: promise writeFile", async () => {
    await patchedFs.promises.writeFile(TESTDIR + "/bind_write.txt", "written via binding");
    const data = await patchedFs.promises.readFile(TESTDIR + "/bind_write.txt", "utf8");
    assert.strictEqual(data, "written via binding");
  });

  await test("binding: callback stat", async () => {
    const s = await new Promise((res, rej) => {
      patchedFs.stat(TESTDIR + "/bind.txt", (err, stats) => {
        if (err) rej(err);
        else res(stats);
      });
    });
    assert.ok(s.isFile());
  });

  await test("binding: callback readFile", async () => {
    const data = await new Promise((res, rej) => {
      patchedFs.readFile(TESTDIR + "/bind.txt", "utf8", (err, data) => {
        if (err) rej(err);
        else res(data);
      });
    });
    assert.strictEqual(data, "binding content");
  });

  await test("binding: promise readdir", async () => {
    const entries = await patchedFs.promises.readdir(TESTDIR);
    assert.ok(entries.includes("bind.txt"));
  });

  await test("binding: promise access", async () => {
    await patchedFs.promises.access(TESTDIR + "/bind.txt");
  });

  await test("binding: promise mkdir", async () => {
    await patchedFs.promises.mkdir(TESTDIR + "/bind_sub");
    assert.ok(patchedFs.existsSync(TESTDIR + "/bind_sub"));
  });

  await test("binding: promise rename", async () => {
    await patchedFs.promises.rename(TESTDIR + "/bind_write.txt", TESTDIR + "/bind_renamed.txt");
    assert.ok(!patchedFs.existsSync(TESTDIR + "/bind_write.txt"));
    assert.ok(patchedFs.existsSync(TESTDIR + "/bind_renamed.txt"));
  });

  await test("binding: callback writeFile + readFile", async () => {
    await new Promise((res, rej) => {
      patchedFs.writeFile(TESTDIR + "/cb.txt", "callback data", (err) => {
        if (err) rej(err);
        else res();
      });
    });
    const data = await new Promise((res, rej) => {
      patchedFs.readFile(TESTDIR + "/cb.txt", "utf8", (err, data) => {
        if (err) rej(err);
        else res(data);
      });
    });
    assert.strictEqual(data, "callback data");
  });

  await test("binding: createReadStream still works", async () => {
    const rs = patchedFs.createReadStream(TESTDIR + "/bind.txt", "utf8");
    let data = "";
    await new Promise((res) => { rs.on("data", c => data += c); rs.on("end", res); });
    assert.strictEqual(data, "binding content");
  });

  await test("binding: isBindingPatched", async () => {
    assert.ok(remoteFs.isBindingPatched());
  });

  remoteFs.restore();
  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });