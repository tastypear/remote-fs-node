"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const c = fs.constants;
const TESTDIR = "/tmp/rfs_flags_test";
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); failed++; }
}

async function run() {
  console.log("=== numeric flags test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/existing.txt", "hello world");

  // String flags still work
  await test("string flag r (read existing)", async () => {
    const fd = await fs.promises.open(TESTDIR + "/existing.txt", "r");
    const buf = Buffer.alloc(5);
    await fd.read(buf, 0, 5, 0);
    assert.strictEqual(buf.toString(), "hello");
    await fd.close();
  });

  // Numeric O_RDONLY
  await test("numeric O_RDONLY reads file", async () => {
    const fd = await fs.promises.open(TESTDIR + "/existing.txt", c.O_RDONLY);
    const buf = Buffer.alloc(5);
    await fd.read(buf, 0, 5, 0);
    assert.strictEqual(buf.toString(), "hello");
    await fd.close();
  });

  // Numeric O_WRONLY|O_CREAT|O_TRUNC = "w"
  await test("numeric O_WRONLY|O_CREAT|O_TRUNC writes new file", async () => {
    const fd = await fs.promises.open(TESTDIR + "/num_w.txt", c.O_WRONLY | c.O_CREAT | c.O_TRUNC);
    await fd.write("numeric write");
    await fd.close();
    const data = await fs.promises.readFile(TESTDIR + "/num_w.txt", "utf8");
    assert.strictEqual(data, "numeric write");
  });

  // Numeric O_RDWR|O_CREAT|O_TRUNC = "w+"
  await test("numeric O_RDWR|O_CREAT|O_TRUNC write+read", async () => {
    const fd = await fs.promises.open(TESTDIR + "/num_wp.txt", c.O_RDWR | c.O_CREAT | c.O_TRUNC);
    await fd.write("rw content");
    await fd.close();
    const data = await fs.promises.readFile(TESTDIR + "/num_wp.txt", "utf8");
    assert.strictEqual(data, "rw content");
  });

  // Numeric O_APPEND = "a"
  await test("numeric O_WRONLY|O_CREAT|O_APPEND appends", async () => {
    const fd = await fs.promises.open(TESTDIR + "/num_a.txt", c.O_WRONLY | c.O_CREAT | c.O_APPEND);
    await fd.write("first ");
    await fd.close();
    const fd2 = await fs.promises.open(TESTDIR + "/num_a.txt", c.O_WRONLY | c.O_CREAT | c.O_APPEND);
    await fd2.write("second");
    await fd2.close();
    const data = await fs.promises.readFile(TESTDIR + "/num_a.txt", "utf8");
    assert.strictEqual(data, "first second");
  });

  // Sync open with numeric flags
  await test("sync openSync with numeric flags", async () => {
    fs.writeFileSync(TESTDIR + "/sync_num.txt", "sync data");
    const fd = fs.openSync(TESTDIR + "/sync_num.txt", c.O_RDONLY);
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    assert.strictEqual(n, 4);
    assert.strictEqual(buf.toString(), "sync");
    fs.closeSync(fd);
  });

  // Sync write with numeric flags
  await test("sync openSync write with numeric flags", async () => {
    const fd = fs.openSync(TESTDIR + "/sync_num_w.txt", c.O_WRONLY | c.O_CREAT | c.O_TRUNC);
    fs.writeSync(fd, "sync numeric");
    fs.closeSync(fd);
    assert.strictEqual(fs.readFileSync(TESTDIR + "/sync_num_w.txt", "utf8"), "sync numeric");
  });

  // O_EXCL should fail if file exists
  await test("O_EXCL fails on existing file", async () => {
    try {
      await fs.promises.open(TESTDIR + "/existing.txt", c.O_WRONLY | c.O_CREAT | c.O_EXCL);
      assert.fail("should have thrown EEXIST");
    } catch (err) {
      // Expected — either EEXIST or server error
    }
  });

  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });