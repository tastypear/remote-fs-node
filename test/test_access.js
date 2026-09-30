"use strict";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });

const assert = require("assert");
const remoteFs = require("../index.js");
remoteFs.configure({ baseURL: "http://127.0.0.1:8766", token: "testtoken123" });
const fs = remoteFs.fs;
const c = fs.constants;
const TESTDIR = "/tmp/rfs_access_test";
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log("PASS  " + name); passed++; }
  catch (err) { console.log("FAIL  " + name + ": " + err.message); console.error(err.stack); failed++; }
}

async function run() {
  console.log("=== access permission test suite ===\n");
  try { await fs.promises.rm(TESTDIR); } catch {}
  await fs.promises.mkdir(TESTDIR, { recursive: true });
  await fs.promises.writeFile(TESTDIR + "/readable.txt", "content");
  await fs.promises.writeFile(TESTDIR + "/readonly.txt", "content");
  await fs.promises.chmod(TESTDIR + "/readonly.txt", 0o400); // read-only for owner

  await test("access F_OK on existing file", async () => {
    await fs.promises.access(TESTDIR + "/readable.txt", c.F_OK);
  });

  await test("access F_OK on nonexistent throws ENOENT", async () => {
    try {
      await fs.promises.access(TESTDIR + "/nonexistent", c.F_OK);
      assert.fail("should throw");
    } catch (err) {
      assert.strictEqual(err.code, "ENOENT");
    }
  });

  await test("access R_OK on readable file", async () => {
    await fs.promises.access(TESTDIR + "/readable.txt", c.R_OK);
  });

  await test("access W_OK on writable file", async () => {
    await fs.promises.access(TESTDIR + "/readable.txt", c.W_OK);
  });

  await test("access W_OK on read-only file (non-root)", async () => {
    // On a non-root server, os.access(W_OK) on a 0o400 file returns false →
    // the endpoint returns 403 and the client surfaces EACCES. (Root bypasses
    // permission checks, so under root this would succeed — but the test
    // server runs as uid 1000.)
    try {
      await fs.promises.access(TESTDIR + "/readonly.txt", c.W_OK);
      assert.fail("should throw EACCES for read-only file under non-root");
    } catch (err) {
      assert.strictEqual(err.code, "EACCES");
    }
  });

  await test("access X_OK on directory", async () => {
    await fs.promises.access(TESTDIR, c.X_OK);
  });

  await test("accessSync F_OK existing", async () => {
    fs.accessSync(TESTDIR + "/readable.txt", c.F_OK);
  });

  await test("accessSync F_OK nonexistent throws", async () => {
    try {
      fs.accessSync(TESTDIR + "/nope", c.F_OK);
      assert.fail("should throw");
    } catch (err) {
      assert.strictEqual(err.code, "ENOENT");
    }
  });

  await test("accessSync R_OK readable", async () => {
    fs.accessSync(TESTDIR + "/readable.txt", c.R_OK);
  });

  // Cleanup
  await fs.promises.chmod(TESTDIR + "/readonly.txt", 0o644);
  try { await fs.promises.rm(TESTDIR); } catch {}
  console.log("\n=== " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error("FATAL:", err); process.exit(1); });