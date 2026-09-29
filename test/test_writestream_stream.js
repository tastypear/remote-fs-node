"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const T = "/tmp/rfs_ws_stream";
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); failed++; }
}

const SIZE = 10 * 1024 * 1024;
const CHUNK = 65536;

async function run() {
  console.log("=== WriteStream streaming test suite (Phase 2) ===\n");
  try { await fs.promises.rm(T, { recursive: true }); } catch {}
  await fs.promises.mkdir(T, { recursive: true });

  await test("stream 10MB in 64KB chunks, content correct", async () => {
    const ws = fs.createWriteStream(T + "/stream.bin");
    const pattern = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i++) pattern[i] = (i * 7 + 3) % 251;
    // Write in 64KB slices — do NOT hold the full buffer in the stream.
    for (let off = 0; off < SIZE; off += CHUNK) {
      const slice = pattern.subarray(off, Math.min(off + CHUNK, SIZE));
      if (!ws.write(slice)) {
        await new Promise((r) => ws.once("drain", r));
      }
    }
    await new Promise((res, rej) => { ws.end(); ws.on("finish", res); ws.on("error", rej); });
    assert.strictEqual(ws.bytesWritten, SIZE);
    // Verify byte-exact
    const read = await fs.promises.readFile(T + "/stream.bin");
    assert.strictEqual(read.length, SIZE);
    for (let i = 0; i < SIZE; i += 4096) {
      assert.strictEqual(read[i], pattern[i], `byte mismatch at ${i}`);
    }
  });

  await test("no full-buffer accumulation (RSS stays flat)", async () => {
    const before = process.memoryUsage().rss;
    const ws = fs.createWriteStream(T + "/rss.bin");
    const chunk = Buffer.alloc(CHUNK); // reusable single chunk
    let peak = before;
    for (let off = 0; off < SIZE; off += CHUNK) {
      for (let i = 0; i < CHUNK; i++) chunk[i] = (off + i) % 251;
      if (!ws.write(chunk)) await new Promise((r) => ws.once("drain", r));
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    await new Promise((res) => { ws.end(); ws.on("finish", res); });
    const growth = peak - before;
    // Old model buffered all 10MB before upload; new model flushes per batch.
    // Growth should be well under 20MB (one 64KB batch + HTTP/agent overhead).
    assert.ok(growth < 20 * 1024 * 1024,
      `RSS grew ${Math.round(growth / 1024 / 1024)}MB — expected < 20MB (no full buffering)`);
    console.log(`    RSS: before=${Math.round(before/1024/1024)}MB peak=${Math.round(peak/1024/1024)}MB growth=${Math.round(growth/1024/1024)}MB`);
  });

  await test("append-mode WriteStream", async () => {
    await fs.promises.writeFile(T + "/app.bin", "initial|");
    const ws = fs.createWriteStream(T + "/app.bin", { flags: "a" });
    await new Promise((res, rej) => { ws.write("appended"); ws.end(); ws.on("finish", res); ws.on("error", rej); });
    assert.strictEqual(await fs.promises.readFile(T + "/app.bin", "utf8"), "initial|appended");
  });

  await test("flush option (fsync before close)", async () => {
    const ws = fs.createWriteStream(T + "/flush.bin", { flush: true });
    await new Promise((res, rej) => { ws.write("flushed"); ws.end(); ws.on("finish", res); ws.on("error", rej); });
    assert.strictEqual(await fs.promises.readFile(T + "/flush.bin", "utf8"), "flushed");
  });

  await test("open event fires with server fd", async () => {
    const ws = fs.createWriteStream(T + "/open_evt.bin");
    const fd = await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
      ws.write("x");
      ws.end();
    });
    assert.strictEqual(typeof fd, "number");
    assert.ok(fd > 0, "server fd should be a positive id");
    await new Promise((r) => ws.on("finish", r));
  });

  await test("AbortSignal aborts WriteStream", async () => {
    const ac = new AbortController();
    const ws = fs.createWriteStream(T + "/abort.bin", { signal: ac.signal });
    const err = await new Promise((res) => {
      ws.on("error", (e) => res(e));
      ws.write("data");
      ac.abort();
    });
    assert.strictEqual(err.code, "ABORT_ERR");
  });

  try { await fs.promises.rm(T, { recursive: true }); } catch {}
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });
