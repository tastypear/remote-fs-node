"use strict";
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
  process.exit(1);
});
const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_test";
let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log("PASS  " + name);
    passed++;
  } catch (err) {
    console.log("FAIL  " + name + ": " + err.message);
    console.error(err.stack);
    failed++;
  }
}

async function run() {
  console.log("=== remote-fs test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });

  await test("writeFile + readFile (string)", async () => {
    await fs.promises.writeFile(TESTDIR + "/hello.txt", "Hello World!");
    assert.strictEqual(await fs.promises.readFile(TESTDIR + "/hello.txt", "utf8"), "Hello World!");
  });

  await test("readFile (buffer)", async () => {
    const buf = await fs.promises.readFile(TESTDIR + "/hello.txt");
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(buf.length, 12);
  });

  await test("existsSync", async () => {
    assert.ok(fs.existsSync(TESTDIR + "/hello.txt"));
    assert.ok(!fs.existsSync(TESTDIR + "/nonexistent"));
  });

  await test("stat", async () => {
    const s = await fs.promises.stat(TESTDIR + "/hello.txt");
    assert.ok(s.isFile());
    assert.strictEqual(s.size, 12);
  });

  await test("readdir", async () => {
    await fs.promises.writeFile(TESTDIR + "/f2.txt", "x");
    const e = await fs.promises.readdir(TESTDIR);
    assert.ok(e.includes("hello.txt"));
    assert.ok(e.includes("f2.txt"));
  });

  await test("readdir withFileTypes", async () => {
    const d = await fs.promises.readdir(TESTDIR, { withFileTypes: true });
    assert.ok(d.find((x) => x.name === "hello.txt").isFile());
  });

  await test("rename", async () => {
    await fs.promises.rename(TESTDIR + "/f2.txt", TESTDIR + "/renamed.txt");
    assert.ok(fs.existsSync(TESTDIR + "/renamed.txt"));
  });

  await test("copyFile", async () => {
    await fs.promises.copyFile(TESTDIR + "/hello.txt", TESTDIR + "/copy.txt");
    assert.strictEqual(await fs.promises.readFile(TESTDIR + "/copy.txt", "utf8"), "Hello World!");
  });

  await test("unlink", async () => {
    await fs.promises.unlink(TESTDIR + "/copy.txt");
    assert.ok(!fs.existsSync(TESTDIR + "/copy.txt"));
  });

  await test("mkdir + rmdir", async () => {
    await fs.promises.mkdir(TESTDIR + "/sub");
    await fs.promises.rmdir(TESTDIR + "/sub");
  });

  await test("appendFile", async () => {
    await fs.promises.writeFile(TESTDIR + "/app.txt", "a");
    await fs.promises.appendFile(TESTDIR + "/app.txt", "b");
    assert.strictEqual(await fs.promises.readFile(TESTDIR + "/app.txt", "utf8"), "ab");
  });

  await test("chmod", async () => {
    await fs.promises.chmod(TESTDIR + "/hello.txt", 0o600);
  });

  await test("symlink + readlink", async () => {
    await fs.promises.symlink(TESTDIR + "/hello.txt", TESTDIR + "/link.txt");
    assert.strictEqual(await fs.promises.readlink(TESTDIR + "/link.txt"), TESTDIR + "/hello.txt");
  });

  await test("lstat (symlink)", async () => {
    assert.ok((await fs.promises.lstat(TESTDIR + "/link.txt")).isSymbolicLink());
  });

  await test("realpath", async () => {
    const rp = await fs.promises.realpath(TESTDIR + "/link.txt");
    assert.ok(rp.includes("hello.txt"));
  });

  await test("access", async () => {
    await fs.promises.access(TESTDIR + "/hello.txt");
  });

  await test("ENOENT error", async () => {
    try {
      await fs.promises.readFile(TESTDIR + "/nope");
      assert.fail("should throw");
    } catch (e) { assert.strictEqual(e.code, "ENOENT"); }
  });

  await test("callback style", async () => {
    await new Promise((res, rej) => {
      fs.readFile(TESTDIR + "/hello.txt", "utf8", (err, data) => {
        if (err) rej(err);
        else { assert.strictEqual(data, "Hello World!"); res(); }
      });
    });
  });

  await test("createReadStream", async () => {
    const rs = fs.createReadStream(TESTDIR + "/hello.txt", "utf8");
    let c = "";
    await new Promise((res) => { rs.on("data", (d) => c += d); rs.on("end", res); });
    assert.strictEqual(c, "Hello World!");
  });

  await test("createWriteStream", async () => {
    const ws = fs.createWriteStream(TESTDIR + "/ws.txt");
    await new Promise((res, rej) => { ws.write("streamed"); ws.end(); ws.on("finish", res); ws.on("error", rej); });
    assert.strictEqual(await fs.promises.readFile(TESTDIR + "/ws.txt", "utf8"), "streamed");
  });

  await test("fd: open + read + close", async () => {
    const fd = await fs.promises.open(TESTDIR + "/hello.txt", "r");
    const buf = Buffer.alloc(5);
    const { bytesRead } = await fd.read(buf, 0, 5, 0);
    assert.strictEqual(bytesRead, 5);
    assert.strictEqual(buf.toString(), "Hello");
    await fd.close();
  });

  await test("fd: open + write + close", async () => {
    const fd = await fs.promises.open(TESTDIR + "/fdw.txt", "w");
    await fd.write("fd content");
    await fd.close();
    assert.strictEqual(await fs.promises.readFile(TESTDIR + "/fdw.txt", "utf8"), "fd content");
  });

  await test("createReadStream range", async () => {
    await fs.promises.writeFile(TESTDIR + "/rng.txt", "0123456789ABCDEF");
    const rs = fs.createReadStream(TESTDIR + "/rng.txt", { start: 4, end: 7 });
    let c = "";
    await new Promise((res) => { rs.on("data", (d) => c += d.toString()); rs.on("end", res); });
    assert.strictEqual(c, "4567");
  });

  await test("rm recursive", async () => {
    await fs.promises.mkdir(TESTDIR + "/tree/sub", { recursive: true });
    await fs.promises.writeFile(TESTDIR + "/tree/sub/f.txt", "x");
    await fs.promises.rm(TESTDIR + "/tree");
    assert.ok(!fs.existsSync(TESTDIR + "/tree"));
  });

  console.log("\n--- Sync tests ---");

  await test("writeFileSync + readFileSync", async () => {
    fs.writeFileSync(TESTDIR + "/sync.txt", "sync data");
    assert.strictEqual(fs.readFileSync(TESTDIR + "/sync.txt", "utf8"), "sync data");
  });

  await test("existsSync (sync)", async () => {
    assert.ok(fs.existsSync(TESTDIR + "/sync.txt"));
    assert.ok(!fs.existsSync(TESTDIR + "/nope_sync"));
  });

  await test("statSync", async () => {
    const s = fs.statSync(TESTDIR + "/sync.txt");
    assert.ok(s.isFile());
    assert.strictEqual(s.size, 9);
  });

  await test("readdirSync", async () => {
    const e = fs.readdirSync(TESTDIR);
    assert.ok(e.includes("sync.txt"));
  });

  await test("unlinkSync", async () => {
    fs.unlinkSync(TESTDIR + "/sync.txt");
    assert.ok(!fs.existsSync(TESTDIR + "/sync.txt"));
  });

  await test("openSync + readSync + closeSync", async () => {
    fs.writeFileSync(TESTDIR + "/sfd.txt", "sync fd test!");
    const fd = fs.openSync(TESTDIR + "/sfd.txt", "r");
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);
    assert.strictEqual(n, 8);
    assert.strictEqual(buf.toString(), "sync fd ");
    fs.closeSync(fd);
  });

  await test("openSync (write) + writeSync + closeSync", async () => {
    const fd = fs.openSync(TESTDIR + "/sfw.txt", "w");
    fs.writeSync(fd, "written sync");
    fs.closeSync(fd);
    assert.strictEqual(fs.readFileSync(TESTDIR + "/sfw.txt", "utf8"), "written sync");
  });

  console.log("\n--- Monkey-patch test ---");

  await test("patch require(fs)", async () => {
    remoteFs.patch();
    const patchedFs = require("fs");
    assert.strictEqual(typeof patchedFs.promises.readFile, "function");
    const data = await patchedFs.promises.readFile(TESTDIR + "/hello.txt", "utf8");
    assert.strictEqual(data, "Hello World!");
    remoteFs.restore();
  });

  // Cleanup
  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });