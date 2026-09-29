"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_bigfile_test";
let passed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); }
}

async function run() {
  console.log("=== large file streaming test ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });

  // Create a 1MB file on the server using exec
  await new Promise((res) => {
    const { exec } = require("child_process");
    // Use the server API to create a large file
    const client = remoteFs.client;
    client.postJSON("/api/exec", {
      cmd: "dd if=/dev/urandom of=/tmp/rfs_bigfile_test/big.bin bs=1024 count=1024 2>/dev/null",
      timeout: 10,
    }).then(res);
  });

  await test("stream 1MB file with correct byte count", async () => {
    const rs = fs.createReadStream(TESTDIR + "/big.bin");
    let totalBytes = 0;
    let chunkCount = 0;
    await new Promise((res, rej) => {
      rs.on("data", (chunk) => {
        totalBytes += chunk.length;
        chunkCount++;
      });
      rs.on("end", res);
      rs.on("error", rej);
    });
    assert.strictEqual(totalBytes, 1024 * 1024, "should read exactly 1MB");
    assert.ok(chunkCount > 1, "should receive multiple chunks (streaming)");
    console.log("    chunks: " + chunkCount + ", bytes: " + totalBytes);
  });

  await test("stream 1MB with range", async () => {
    const rs = fs.createReadStream(TESTDIR + "/big.bin", { start: 100, end: 199 });
    let totalBytes = 0;
    await new Promise((res, rej) => {
      rs.on("data", (chunk) => { totalBytes += chunk.length; });
      rs.on("end", res);
      rs.on("error", rej);
    });
    assert.strictEqual(totalBytes, 100, "should read exactly 100 bytes");
  });

  await test("pipe to write stream", async () => {
    const rs = fs.createReadStream(TESTDIR + "/big.bin");
    const ws = fs.createWriteStream(TESTDIR + "/copied.bin");
    await new Promise((res, rej) => {
      rs.pipe(ws);
      ws.on("finish", res);
      ws.on("error", rej);
      rs.on("error", rej);
    });
    // Verify sizes match
    const origStat = await fs.promises.stat(TESTDIR + "/big.bin");
    const copyStat = await fs.promises.stat(TESTDIR + "/copied.bin");
    assert.strictEqual(origStat.size, copyStat.size, "sizes should match");
    console.log("    orig: " + origStat.size + ", copy: " + copyStat.size);
  });

  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed ===");
  process.exit(0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });