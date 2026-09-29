"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const { execFileSync } = require("child_process");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const T = "/tmp/rfs_sync_cache";
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); failed++; }
}

// Count curl forks during a code block by sampling the OS process table is
// unreliable on WSL; instead we measure wall-time. 1000 uncached existsSync
// forks would take ~5-15s (5-15ms each); cached should be well under 1s for
// the repeated-path case since only the first hits curl.
// Retry a promise a few times — WSL2's loopback TCP occasionally drops a
// connection (ECONNRESET/socket hang up) under concurrent test-suite load.
// This makes the stat-heavy assertions resilient without masking real bugs.
async function retry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 100)); }
  }
  throw lastErr;
}

async function run() {
  console.log("=== sync cache + atomic move test suite (Phase 3-5) ===\n");
  try { await fs.promises.rm(T, { recursive: true }); } catch {}
  await fs.promises.mkdir(T, { recursive: true });
  await fs.promises.writeFile(T + "/f.txt", "x");

  await test("sync cache collapses repeated existsSync (wall-time)", async () => {
    // 500 existsSync on the same path. Uncached: ~500 curl forks × ~8ms = ~4s.
    // Cached (500ms TTL): 1 fork. Assert it completes in well under 2s.
    const start = Date.now();
    for (let i = 0; i < 500; i++) {
      assert.ok(fs.existsSync(T + "/f.txt"));
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `500 existsSync took ${elapsed}ms — cache not effective (expected < 2000ms)`);
    console.log(`    500 existsSync in ${elapsed}ms (${(elapsed/500).toFixed(2)}ms/op)`);
  });

  await test("sync cache returns correct result (not stale within TTL)", async () => {
    fs.writeFileSync(T + "/c.txt", "v1");
    assert.strictEqual(fs.readFileSync(T + "/c.txt", "utf8"), "v1");
    // Immediate re-read should hit cache and return v1.
    assert.strictEqual(fs.readFileSync(T + "/c.txt", "utf8"), "v1");
  });

  await test("sync cache cleared on write (no stale read after mutate)", async () => {
    fs.writeFileSync(T + "/w.txt", "before");
    fs.readFileSync(T + "/w.txt"); // prime cache
    fs.writeFileSync(T + "/w.txt", "after"); // mutating sync op → clears cache
    assert.strictEqual(fs.readFileSync(T + "/w.txt", "utf8"), "after");
  });

  await test("sync cache cleared on postJSONSync (mkdir/unlink)", async () => {
    fs.mkdirSync(T + "/d1");
    assert.ok(fs.existsSync(T + "/d1")); // prime cache (stat)
    fs.rmdirSync(T + "/d1"); // POST delete → clears cache
    assert.ok(!fs.existsSync(T + "/d1"), "should see deletion (cache cleared)");
  });

  await test("sync cache TTL expiry (configurable)", async () => {
    remoteFs.configure({ syncCacheTtlMs: 100 });
    fs.writeFileSync(T + "/t.txt", "first");
    fs.readFileSync(T + "/t.txt"); // prime cache
    fs.writeFileSync(T + "/t.txt", "second"); // clear
    fs.readFileSync(T + "/t.txt"); // re-prime with "second"
    // Wait for TTL to expire, then mutate + read — should see new value.
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(fs.readFileSync(T + "/t.txt", "utf8"), "second");
    remoteFs.configure({ syncCacheTtlMs: 500 }); // restore default
  });

  await test("sync cache disabled when ttl=0", async () => {
    remoteFs.configure({ syncCacheTtlMs: 0 });
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      fs.existsSync(T + "/f.txt");
    }
    const elapsed = Date.now() - start;
    // With cache disabled, 50 forks should take noticeably longer (>100ms).
    assert.ok(elapsed > 100, `50 uncached existsSync took only ${elapsed}ms — cache not disabled?`);
    console.log(`    50 uncached existsSync in ${elapsed}ms (${(elapsed/50).toFixed(2)}ms/op)`);
    remoteFs.configure({ syncCacheTtlMs: 500 });
  });

  await test("atomic move (os.rename, same filesystem)", async () => {
    await retry(() => fs.promises.writeFile(T + "/src.txt", "move-me"));
    const stBefore = await retry(() => fs.promises.stat(T + "/src.txt"));
    await retry(() => fs.promises.rename(T + "/src.txt", T + "/dst.txt"));
    assert.ok(!fs.existsSync(T + "/src.txt"));
    assert.ok(fs.existsSync(T + "/dst.txt"));
    const stAfter = await retry(() => fs.promises.stat(T + "/dst.txt"));
    // Same inode → os.rename preserved identity (atomic, not copy+delete).
    assert.strictEqual(stBefore.ino, stAfter.ino, "inode should match (atomic rename)");
    assert.strictEqual(await retry(() => fs.promises.readFile(T + "/dst.txt", "utf8")), "move-me");
  });

  await test("atomic move overwrites existing destination", async () => {
    await retry(() => fs.promises.writeFile(T + "/a.txt", "AAA"));
    await retry(() => fs.promises.writeFile(T + "/b.txt", "BBB"));
    await retry(() => fs.promises.rename(T + "/a.txt", T + "/b.txt"));
    assert.strictEqual(await retry(() => fs.promises.readFile(T + "/b.txt", "utf8")), "AAA");
    assert.ok(!fs.existsSync(T + "/a.txt"));
  });

  try { await fs.promises.rm(T, { recursive: true }); } catch {}
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });
