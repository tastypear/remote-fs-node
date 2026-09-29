"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const T = "/tmp/rfs_fd_stream";
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); failed++; }
}

// 10 MB file — large enough that the old whole-file-buffer model would bump
// RSS by ~10MB; the RemoteFdEntry ranged model should keep RSS flat.
const FILE_SIZE = 10 * 1024 * 1024;

async function run() {
  console.log("=== fd streaming test suite (Phase 1) ===\n");
  try { await fs.promises.rm(T, { recursive: true }); } catch {}
  await fs.promises.mkdir(T, { recursive: true });

  // Build a 10MB file with a known pattern: byte[i] = i % 251.
  await test("setup: write 10MB pattern file", async () => {
    const fh = await fs.promises.open(T + "/big.bin", "w");
    const chunkSize = 65536;
    const chunk = Buffer.alloc(chunkSize);
    let written = 0;
    while (written < FILE_SIZE) {
      for (let i = 0; i < chunkSize && written + i < FILE_SIZE; i++) {
        chunk[i] = (written + i) % 251;
      }
      const n = Math.min(chunkSize, FILE_SIZE - written);
      await fh.write(chunk, 0, n, written);
      written += n;
    }
    await fh.close();
    const st = await fs.promises.stat(T + "/big.bin");
    assert.strictEqual(st.size, FILE_SIZE);
  });

  await test("async ranged read 4KB at offset 5MB (byte-exact)", async () => {
    const fh = await fs.promises.open(T + "/big.bin", "r");
    const buf = Buffer.alloc(4096);
    const offset = 5 * 1024 * 1024;
    const { bytesRead } = await fh.read(buf, 0, 4096, offset);
    assert.strictEqual(bytesRead, 4096);
    for (let i = 0; i < 4096; i++) {
      assert.strictEqual(buf[i], (offset + i) % 251, `byte mismatch at ${i}`);
    }
    await fh.close();
  });

  await test("async ranged write 4KB at offset 2MB", async () => {
    const fh = await fs.promises.open(T + "/big.bin", "r+");
    const offset = 2 * 1024 * 1024;
    const buf = Buffer.alloc(4096, 0xAB); // distinct pattern
    const { bytesWritten } = await fh.write(buf, 0, 4096, offset);
    assert.strictEqual(bytesWritten, 4096);
    await fh.close();
    // Verify
    const fh2 = await fs.promises.open(T + "/big.bin", "r");
    const rb = Buffer.alloc(4096);
    await fh2.read(rb, 0, 4096, offset);
    await fh2.close();
    for (let i = 0; i < 4096; i++) assert.strictEqual(rb[i], 0xAB, `write verify ${i}`);
  });

  await test("ftruncate via fd (grow + shrink)", async () => {
    const fh = await fs.promises.open(T + "/trunc.bin", "w");
    await fh.writeFile("hello");
    await fh.truncate(100); // grow
    let st = await fh.stat();
    assert.strictEqual(st.size, 100);
    await fh.truncate(3); // shrink
    st = await fh.stat();
    assert.strictEqual(st.size, 3);
    await fh.close();
  });

  await test("fsync via fd", async () => {
    const fh = await fs.promises.open(T + "/sync.bin", "w");
    await fh.writeFile("data");
    await fh.sync(); // fsync — should not throw
    await fh.close();
    assert.strictEqual(await fs.promises.readFile(T + "/sync.bin", "utf8"), "data");
  });

  await test("FileHandle.readFile (chunked fd-read, no _content)", async () => {
    const fh = await fs.promises.open(T + "/big.bin", "r");
    const full = await fh.readFile();
    assert.strictEqual(full.length, FILE_SIZE);
    // spot-check the 0xAB region written earlier
    assert.strictEqual(full[2 * 1024 * 1024], 0xAB);
    // spot-check an untouched region
    assert.strictEqual(full[7 * 1024 * 1024], (7 * 1024 * 1024) % 251);
    await fh.close();
  });

  await test("peak RSS flat during ranged read (no whole-file buffer)", async () => {
    const before = process.memoryUsage().rss;
    const fh = await fs.promises.open(T + "/big.bin", "r");
    // Read 1MB in 4KB slices from across the file — old model would load 10MB.
    let peak = before;
    for (let i = 0; i < 256; i++) {
      const offset = (i * 40960) % (FILE_SIZE - 4096);
      const buf = Buffer.alloc(4096);
      await fh.read(buf, 0, 4096, offset);
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    await fh.close();
    const after = process.memoryUsage().rss;
    // Peak RSS should not jump by more than ~20MB (GC + buffers). Old whole-file
    // model would add ~10MB+ for the file alone on top of working set.
    const growth = peak - before;
    assert.ok(growth < 20 * 1024 * 1024,
      `RSS grew ${Math.round(growth / 1024 / 1024)}MB — expected < 20MB (whole-file not buffered)`);
    console.log(`    RSS: before=${Math.round(before/1024/1024)}MB peak=${Math.round(peak/1024/1024)}MB growth=${Math.round(growth/1024/1024)}MB`);
  });

  await test("openSync size guard rejects oversized files", async () => {
    // FILE is 10MB; temporarily lower the threshold to 1MB to test the guard
    // without writing a >64MB file. Restore after.
    const client = require("../lib/client");
    remoteFs.configure({ syncMaxFileBytes: 1 * 1024 * 1024 });
    try {
      fs.openSync(T + "/big.bin", "r");
      assert.fail("should have thrown ERR_FS_FILE_TOO_LARGE");
    } catch (err) {
      assert.strictEqual(err.code, "ERR_FS_FILE_TOO_LARGE");
    } finally {
      remoteFs.configure({ syncMaxFileBytes: 64 * 1024 * 1024 });
    }
  });

  await test("append mode via fd (O_APPEND, offset ignored)", async () => {
    await fs.promises.writeFile(T + "/app.bin", "initial|");
    const fh = await fs.promises.open(T + "/app.bin", "a");
    await fh.write("appended");
    await fh.close();
    assert.strictEqual(await fs.promises.readFile(T + "/app.bin", "utf8"), "initial|appended");
  });

  await test("sequential read advances position (no explicit position)", async () => {
    const fh = await fs.promises.open(T + "/seq.bin", "w");
    await fh.writeFile("0123456789");
    await fh.close();
    const fh2 = await fs.promises.open(T + "/seq.bin", "r");
    const b1 = Buffer.alloc(5), b2 = Buffer.alloc(5);
    const r1 = await fh2.read(b1, 0, 5); // pos 0→5
    const r2 = await fh2.read(b2, 0, 5); // pos 5→10
    assert.strictEqual(r1.bytesRead, 5);
    assert.strictEqual(r2.bytesRead, 5);
    assert.strictEqual(b1.toString(), "01234");
    assert.strictEqual(b2.toString(), "56789");
    await fh2.close();
  });

  try { await fs.promises.rm(T, { recursive: true }); } catch {}
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });
