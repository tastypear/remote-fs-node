"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_stream_class_test";
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); failed++; }
}

async function run() {
  console.log("=== stream class test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/data.txt", "Hello Stream World!");

  await test("createReadStream returns instanceof ReadStream", async () => {
    const rs = fs.createReadStream(TESTDIR + "/data.txt", "utf8");
    assert.ok(rs instanceof fs.ReadStream, "should be instanceof ReadStream");
    assert.ok(rs instanceof require("stream").Readable, "should be instanceof Readable");
    await new Promise((res) => { rs.on("data", () => {}); rs.on("end", res); });
  });

  await test("createReadStream reads correct data", async () => {
    const rs = fs.createReadStream(TESTDIR + "/data.txt", "utf8");
    let data = "";
    await new Promise((res) => { rs.on("data", (c) => data += c); rs.on("end", res); });
    assert.strictEqual(data, "Hello Stream World!");
  });

  await test("createReadStream range", async () => {
    const rs = fs.createReadStream(TESTDIR + "/data.txt", { start: 6, end: 11 });
    let data = "";
    await new Promise((res) => { rs.on("data", (c) => data += c.toString()); rs.on("end", res); });
    assert.strictEqual(data, "Stream");
  });

  await test("createReadStream emits open event", async () => {
    const rs = fs.createReadStream(TESTDIR + "/data.txt");
    let opened = false;
    rs.on("open", (fd) => { opened = true; });
    await new Promise((res) => { rs.on("data", () => {}); rs.on("end", res); });
    assert.ok(opened, "should emit open event");
  });

  await test("createWriteStream returns instanceof WriteStream", async () => {
    const ws = fs.createWriteStream(TESTDIR + "/ws_class.txt");
    assert.ok(ws instanceof fs.WriteStream, "should be instanceof WriteStream");
    assert.ok(ws instanceof require("stream").Writable, "should be instanceof Writable");
    ws.end("test data");
    await new Promise((res) => ws.on("finish", res));
  });

  await test("createWriteStream writes correct data", async () => {
    const ws = fs.createWriteStream(TESTDIR + "/ws_data.txt");
    ws.write("line1\n");
    ws.write("line2\n");
    ws.end();
    await new Promise((res) => ws.on("finish", res));
    const data = await fs.promises.readFile(TESTDIR + "/ws_data.txt", "utf8");
    assert.strictEqual(data, "line1\nline2\n");
  });

  await test("createWriteStream tracks bytesWritten", async () => {
    const ws = fs.createWriteStream(TESTDIR + "/ws_bytes.txt");
    ws.write("12345");
    ws.end();
    await new Promise((res) => ws.on("finish", res));
    assert.strictEqual(ws.bytesWritten, 5);
  });

  await test("createWriteStream emits open event", async () => {
    const ws = fs.createWriteStream(TESTDIR + "/ws_open.txt");
    let opened = false;
    ws.on("open", () => { opened = true; });
    ws.end("x");
    await new Promise((res) => ws.on("finish", res));
    assert.ok(opened, "should emit open event");
  });

  await test("createReadStream error on nonexistent file", async () => {
    const rs = fs.createReadStream(TESTDIR + "/nonexistent.txt");
    try {
      await new Promise((res, rej) => {
        rs.on("error", rej);
        rs.on("data", () => {});
        rs.on("end", res);
      });
      assert.fail("should emit error");
    } catch (err) {
      assert.strictEqual(err.code, "ENOENT");
    }
  });

  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });