"use strict";
process.on("uncaughtException", (err) => { console.error("UNCAUGHT:", err); process.exit(1); });
process.on("unhandledRejection", (err) => { console.error("UNHANDLED:", err); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const TESTDIR = "/tmp/rfs_watch_test";
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  console.log("=== remote-fs watch test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });

  // ─── 1. fs.watch on a file (change event) ───
  await test("fs.watch file change", async () => {
    await fs.promises.writeFile(TESTDIR + "/watched.txt", "initial");
    const events = [];
    const watcher = fs.watch(TESTDIR + "/watched.txt", (event, filename) => {
      events.push({ event, filename });
    });
    await sleep(800); // wait for SSE connection
    await fs.promises.writeFile(TESTDIR + "/watched.txt", "modified");
    await sleep(1200); // wait for event
    watcher.close();
    assert.ok(events.length > 0, "should receive at least one event");
    assert.ok(events.some((e) => e.event === "change"), "should have change event");
  });

  // ─── 2. fs.watch on a directory (rename event) ───
  await test("fs.watch dir rename (new file)", async () => {
    const events = [];
    const watcher = fs.watch(TESTDIR, (event, filename) => {
      events.push({ event, filename });
    });
    await sleep(800);
    await fs.promises.writeFile(TESTDIR + "/new_file.txt", "content");
    await sleep(1200);
    watcher.close();
    assert.ok(events.length > 0, "should receive events");
    assert.ok(events.some((e) => e.event === "rename"), "should have rename event");
  });

  // ─── 3. fs.watch on directory (file delete) ───
  await test("fs.watch dir rename (delete file)", async () => {
    await fs.promises.writeFile(TESTDIR + "/to_delete.txt", "temp");
    const events = [];
    const watcher = fs.watch(TESTDIR, (event, filename) => {
      events.push({ event, filename });
    });
    await sleep(800);
    await fs.promises.unlink(TESTDIR + "/to_delete.txt");
    await sleep(1200);
    watcher.close();
    assert.ok(events.some((e) => e.event === "rename"), "should detect deletion as rename");
  });

  // ─── 4. fs.watch recursive ───
  await test("fs.watch recursive subdir", async () => {
    await fs.promises.mkdir(TESTDIR + "/watchtree/sub", { recursive: true });
    const events = [];
    const watcher = fs.watch(TESTDIR + "/watchtree", { recursive: true }, (event, filename) => {
      events.push({ event, filename });
    });
    await sleep(800);
    await fs.promises.writeFile(TESTDIR + "/watchtree/sub/deep.txt", "deep content");
    await sleep(1200);
    watcher.close();
    assert.ok(events.length > 0, "should receive recursive events");
  });

  // ─── 5. fs.watch close event ───
  await test("fs.watch close event", async () => {
    const watcher = fs.watch(TESTDIR, () => {});
    let closed = false;
    watcher.on("close", () => { closed = true; });
    watcher.close();
    await sleep(100);
    assert.ok(closed, "should emit close event");
  });

  // ─── 6. fs.watchFile (change detection) ───
  await test("fs.watchFile change", async () => {
    await fs.promises.writeFile(TESTDIR + "/wf.txt", "v1");
    let changed = false;
    let currStat = null;
    let prevStat = null;
    const watcher = fs.watchFile(TESTDIR + "/wf.txt", { interval: 300 }, (curr, prev) => {
      currStat = curr;
      prevStat = prev;
      changed = true;
    });
    await sleep(500); // wait for initial stat
    changed = false; // reset after initial
    await fs.promises.writeFile(TESTDIR + "/wf.txt", "v2 modified");
    await sleep(1000); // wait for poll
    watcher.stop();
    assert.ok(changed, "should detect change");
    assert.ok(currStat, "curr stat should be provided");
  });

  // ─── 7. fs.watchFile (file deletion → null curr) ───
  await test("fs.watchFile deletion", async () => {
    await fs.promises.writeFile(TESTDIR + "/wf_del.txt", "temp");
    let changed = false;
    let currWasNull = false;
    const watcher = fs.watchFile(TESTDIR + "/wf_del.txt", { interval: 300 }, (curr, prev) => {
      changed = true;
      if (curr === null) currWasNull = true;
    });
    await sleep(500);
    changed = false;
    await fs.promises.unlink(TESTDIR + "/wf_del.txt");
    await sleep(1000);
    watcher.stop();
    assert.ok(changed, "should detect deletion");
    assert.ok(currWasNull, "curr should be null on deletion");
  });

  // ─── 8. unwatchFile ───
  await test("unwatchFile stops watching", async () => {
    await fs.promises.writeFile(TESTDIR + "/uwf.txt", "v1");
    let count = 0;
    fs.watchFile(TESTDIR + "/uwf.txt", { interval: 300 }, function listener(curr, prev) {
      count++;
    });
    await sleep(500);
    fs.unwatchFile(TESTDIR + "/uwf.txt", function listener(curr, prev) {});
    // Hmm, the listener reference is different. Let's just unwatchFile all.
    fs.unwatchFile(TESTDIR + "/uwf.txt");
    const countBefore = count;
    await fs.promises.writeFile(TESTDIR + "/uwf.txt", "v2");
    await sleep(800);
    assert.strictEqual(count, countBefore, "should not receive events after unwatchFile");
  });

  // ─── 9. fs.watch + AbortSignal ───
  await test("fs.watch with AbortSignal", async () => {
    await fs.promises.writeFile(TESTDIR + "/abort.txt", "x");
    const controller = new AbortController();
    const events = [];
    const watcher = fs.watch(TESTDIR + "/abort.txt", { signal: controller.signal }, (event, filename) => {
      events.push({ event, filename });
    });
    await sleep(600);
    controller.abort();
    await sleep(200);
    // After abort, watcher should be closed
    assert.ok(watcher._closed, "watcher should be closed after abort");
  });

  // ─── Cleanup ───
  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });