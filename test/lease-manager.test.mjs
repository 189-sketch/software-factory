import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLeaseManager } from "../runtime/lease-manager.mjs";

test("filesystem lease acquisition is atomic and owner-scoped", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const manager = createLeaseManager({ stateDir });
  const first = await manager.acquire(3, "daemon-a");
  const second = await manager.acquire(3, "daemon-b");
  assert.ok(first);
  assert.equal(second, null);
  await manager.release(first);
  assert.ok(await manager.acquire(3, "daemon-b"));
});

test("GitHub lease uses atomic ref creation and keeps credentials out of arguments", async () => {
  const calls = [];
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes("--jq")) return { stdout: "abc123\n" };
      return { stdout: "" };
    },
  });
  const lease = await manager.acquire(9, "github-run-1");
  assert.equal(lease.backend, "github-ref");
  assert.equal(lease.sha, "abc123");
  assert.equal(calls.length, 4);
  assert.ok(calls.some((call) => call.args.some((arg) => arg.includes("refs/heads/factory/leases/issue-9"))));
  assert.ok(calls.every((call) => !call.args.includes("secret")));
  assert.equal(calls[0].options.env.GH_TOKEN, "secret");
});

test("GitHub release refuses to delete a lease acquired by a newer owner", async () => {
  const calls = [];
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    log: () => {},
    run: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "new-owner-sha\n" };
    },
  });

  await assert.rejects(
    () => manager.release({
      backend: "github-ref",
      issueNumber: 9,
      owner: "old-owner",
      repository: "acme/app",
      sha: "old-owner-sha",
    }),
    /owner mismatch/i,
  );
  assert.equal(calls.some((call) => call.args.includes("DELETE")), false);
});

test("filesystem lease reclaims a stale lock and reports ERROR on release failure", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-stale-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const logCalls = [];
  const manager = createLeaseManager({
    stateDir,
    staleMs: 1, // anything > 0 means "always stale"
    log: (level, msg, extra) => logCalls.push({ level, msg, extra }),
  });

  const file = path.join(stateDir, "leases", "issue-7.lock");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const old = { issueNumber: 7, owner: "dead-daemon", acquiredAt: "2000-01-01T00:00:00.000Z" };
  await fs.writeFile(file, JSON.stringify(old));

  const lease = await manager.acquire(7, "fresh-daemon");
  assert.ok(lease, "expected stale lock to be reclaimed");
  assert.equal(lease.owner, "fresh-daemon");
  assert.ok(logCalls.some((c) => c.msg === "lease-stale-reclaiming"));

  // Make the next release fail with ENOENT.
  await fs.unlink(file);
  await assert.rejects(() => manager.release(lease), /ENOENT/);
  assert.ok(logCalls.some((c) => c.level === "ERROR" && c.msg === "lease-release-failed"));
});

test("filesystem lease refuses to steal a fresh lock", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-fresh-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const manager = createLeaseManager({ stateDir, staleMs: 10 * 60 * 1000 });

  const first = await manager.acquire(11, "active-daemon");
  assert.ok(first);
  const second = await manager.acquire(11, "another-daemon");
  assert.equal(second, null);
  await manager.release(first);
});

test("GitHub lease creates a dedicated lease commit and points the ref at it", async () => {
  const calls = [];
  // Mock sequence: default-branch GET, tree GET, commit POST, ref POST.
  const responses = ["mainSha\n", "treeSha\n", "leaseCommitSha\n", ""];
  let i = 0;
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    staleMs: 60_000,
    log: () => {},
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: responses[i++] || "" };
    },
  });

  const lease = await manager.acquire(42, "host-1234");
  assert.equal(lease.backend, "github-ref");
  // 4 API calls expected.
  assert.equal(calls.length, 4);
  // The final ref POST must point at the lease commit, not the default-branch SHA.
  const refPost = calls[3];
  assert.ok(refPost.args.includes("--method"));
  assert.ok(refPost.args.some((a) => a.startsWith("ref=refs/heads/factory/leases/issue-42")));
  assert.ok(refPost.args.includes("sha=leaseCommitSha"));
  assert.equal(refPost.args.includes("sha=mainSha"), false);
  // The commit POST must carry the lease metadata in the message.
  const commitPost = calls[2];
  assert.ok(commitPost.args.some((a) => a.startsWith("message=factory-lease issue=42")));
  assert.ok(commitPost.args.includes("tree=treeSha"));
  assert.ok(commitPost.args.some((a) => a.startsWith("parents[]=mainSha")));
  // Token stays out of arguments.
  assert.ok(calls.every((call) => !call.args.includes("secret")));
});

test("GitHub lease reclaims a stale ref and retries once", async () => {
  const calls = [];
  // Sequence for the stale-reclaim path:
  //  0: default-branch GET     → "mainSha"
  //  1: tree GET               → "treeSha"
  //  2: commit POST            → "firstLeaseSha"
  //  3: ref POST               → throws 422 ("already exists")
  //  4: existing-ref GET       → "existingCommitSha"
  //  5: existing-commit GET    → message with old ts
  //  6: existing-ref DELETE    → ok
  //  7: default-branch GET(retry) → "mainSha"
  //  8: tree GET(retry)        → "treeSha"
  //  9: commit POST(retry)     → "secondLeaseSha"
  // 10: ref POST(retry)        → ok
  const outputs = [
    "mainSha\n",
    "treeSha\n",
    "firstLeaseSha\n",
    null, // throws 422
    "existingCommitSha\n",
    "factory-lease issue=5 owner=dead-host ts=2000-01-01T00:00:00.000Z\n",
    "",
    "mainSha\n",
    "treeSha\n",
    "secondLeaseSha\n",
    "",
  ];
  let i = 0;
  function nextStdout() {
    const v = outputs[i++];
    if (v === null) {
      const e = new Error("reference already exists");
      e.stderr = "HTTP 422: Reference already exists";
      throw e;
    }
    return { stdout: v };
  }

  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    staleMs: 60_000,
    log: (level, msg) => calls.push({ kind: "log", level, msg }),
    run: async (command, args, options) => {
      const result = nextStdout();
      calls.push({ kind: "run", args, stdout: result.stdout ?? null });
      return result;
    },
  });

  const lease = await manager.acquire(5, "fresh-host");
  assert.ok(lease, "expected stale ref to be reclaimed");
  assert.equal(lease.backend, "github-ref");
  // A lease-stale-reclaiming WARN must have been logged.
  assert.ok(calls.some((c) => c.kind === "log" && c.msg === "lease-stale-reclaiming"));
  // The DELETE step must have been issued.
  const deleteCall = calls.find(
    (c) => c.kind === "run" && c.args.includes("--method") && c.args.some((a) => a.startsWith("ref=refs/heads/factory/leases/issue-5")),
  );
  assert.ok(deleteCall, "expected DELETE call for stale ref");
  // The retry ref POST must succeed and point at the new lease commit.
  const finalRefPost = calls[calls.length - 1];
  assert.ok(finalRefPost.args.includes("sha=secondLeaseSha"));
});

test("GitHub lease refuses to steal a fresh busy ref", async () => {
  const outputs = [
    "mainSha\n",
    "treeSha\n",
    "firstLeaseSha\n",
    null, // 422
    "existingCommitSha\n",
    // Fresh timestamp — must NOT trigger reclaim.
    `factory-lease issue=5 owner=other-host ts=${new Date().toISOString()}\n`,
  ];
  let i = 0;
  const calls = [];
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    staleMs: 10 * 60 * 1000,
    log: (level, msg) => calls.push({ kind: "log", level, msg }),
    run: async () => {
      const v = outputs[i++];
      if (v === null) {
        const e = new Error("reference already exists");
        e.stderr = "HTTP 422";
        throw e;
      }
      return { stdout: v };
    },
  });
  const result = await manager.acquire(5, "fresh-host");
  assert.equal(result, null);
  // No reclaim warning should have been emitted.
  assert.equal(calls.some((c) => c.msg === "lease-stale-reclaiming"), false);
});

test("GitHub lease release failure logs ERROR and re-throws", async () => {
  const logCalls = [];
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    log: (level, msg, extra) => logCalls.push({ level, msg, extra }),
    run: async () => {
      throw new Error("gh api 403 Forbidden");
    },
  });

  await assert.rejects(
    () => manager.release({ backend: "github-ref", issueNumber: 1, owner: "x", repository: "acme/app" }),
    /403 Forbidden/,
  );
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0].level, "ERROR");
  assert.equal(logCalls[0].msg, "lease-release-failed");
  assert.equal(logCalls[0].extra.backend, "github-ref");
});

test("lease release without log option writes to stderr but still re-throws", async () => {
  const stderrWrites = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  };
  try {
    const manager = createLeaseManager({
      stateDir: path.resolve(".factory"),
      repository: "acme/app",
      token: "secret",
      run: async () => {
        throw new Error("boom");
      },
    });
    await assert.rejects(
      () => manager.release({ backend: "github-ref", issueNumber: 1, owner: "x", repository: "acme/app" }),
      /boom/,
    );
    assert.ok(
      stderrWrites.some((w) => w.includes("lease-release-failed")),
      "CLI fallback should write ERROR to stderr",
    );
  } finally {
    process.stderr.write = original;
  }
});

test("filesystem lease clear removes an existing lock and is a no-op when missing", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-clear-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const logCalls = [];
  const manager = createLeaseManager({
    stateDir,
    log: (level, msg) => logCalls.push({ level, msg }),
  });

  // No-op when no lease exists.
  await manager.clear(7);
  assert.ok(logCalls.some((c) => c.msg === "lease-clear-noop"));

  // Remove when a lease exists.
  const lease = await manager.acquire(7, "tester");
  assert.ok(lease);
  await manager.clear(7);
  const leftover = await fs.stat(path.join(stateDir, "leases", "issue-7.lock")).catch(() => null);
  assert.equal(leftover, null);
  assert.ok(logCalls.some((c) => c.msg === "lease-cleared"));
});

test("GitHub lease clear DELETEs the ref and treats 404 as no-op", async () => {
  const logCalls = [];
  const calls = [];

  // First call (no ref) → mock 404. Second call (existing ref) → success.
  let deleteAttempt = 0;
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    log: (level, msg) => logCalls.push({ level, msg }),
    run: async (command, args) => {
      calls.push({ command, args });
      if (args.includes("--method") && args.some((a) => a === "DELETE")) {
        deleteAttempt++;
        if (deleteAttempt === 1) {
          const e = new Error("Not Found");
          e.stderr = "HTTP 404: Not Found";
          throw e;
        }
        return { stdout: "" };
      }
      return { stdout: "abc123\n" };
    },
  });

  // No-op path: 404 swallowed.
  await manager.clear(3);
  assert.ok(logCalls.some((c) => c.msg === "lease-clear-noop"));

  // Successful delete path.
  await manager.clear(3);
  assert.ok(logCalls.some((c) => c.msg === "lease-cleared"));

  // Two DELETE attempts were issued.
  const deleteCalls = calls.filter((c) => c.args.includes("--method") && c.args.some((a) => a === "DELETE"));
  assert.equal(deleteCalls.length, 2);
});

test("GitHub lease clear re-throws non-404 errors", async () => {
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    log: () => {},
    run: async () => {
      const e = new Error("Forbidden");
      e.stderr = "HTTP 403: Forbidden";
      throw e;
    },
  });
  await assert.rejects(() => manager.clear(9), /Forbidden/);
});

test("GitHub lease clear treats HTTP 422 Reference does not exist as a no-op", async () => {
  // GitHub returns different status codes for "ref doesn't exist": 404 vs
  // 422 (older API surfaces "Reference does not exist"). Force-clear on a
  // cold-started daemon must not error out on either, otherwise the daemon
  // pollutes its log with noise and (more importantly) the operator cannot
  // tell whether a lease was actually missing vs. genuinely failed.
  const logCalls = [];
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    log: (level, msg, extra) => logCalls.push({ level, msg, extra }),
    run: async () => {
      const e = new Error("Reference does not exist");
      e.stderr = "gh: Reference does not exist (HTTP 422)";
      throw e;
    },
  });
  // Must NOT throw — force-clear should treat 422 the same as 404.
  await manager.clear(9);
  const noop = logCalls.find((c) => c.msg === "lease-clear-noop" && c.extra?.issueNumber === 9);
  assert.ok(noop, "expected a lease-clear-noop log entry for issue 9");
  assert.equal(noop.extra.backend, "github-ref");
});

// --------------------------------------------------------------------
// Dead-process reclaim (Layer 1): when a previous daemon crashed or was
// killed without releasing its lease, the new daemon should detect the
// orphaned lease via pid-alive check and reclaim it — without requiring
// the operator to set FACTORY_LEASE_STALE_MS. Issue #24 sat busy-looping
// for hours in production because this path did not exist.
// --------------------------------------------------------------------

test("filesystem lease reclaims an orphaned lock when the holder's pid is dead, even with staleMs=0", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-dead-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const logCalls = [];
  // staleMs=0 means the staleness heuristic is OFF — the only way to
  // reclaim is via the dead-process check.
  const manager = createLeaseManager({
    stateDir,
    staleMs: 0,
    log: (level, msg, extra) => logCalls.push({ level, msg, extra }),
  });

  // Plant a lease whose owner pid no longer exists. We pick a pid
  // that's almost certainly not in use: pid=0 (kernel scheduler on
  // unix) or a very high number; here we use a process we just spawned
  // and discarded.
  const { execFile } = await import("node:child_process");
  const child = execFile(process.execPath, ["-e", "process.exit(0)"], () => {});
  await new Promise((resolve) => child.on("exit", resolve));
  const deadPid = child.pid;
  // Sanity: confirm the pid is gone.
  let stillAlive = false;
  try { process.kill(deadPid, 0); stillAlive = true; } catch {}
  assert.equal(stillAlive, false, "test fixture: pid should be dead");

  const file = path.join(stateDir, "leases", "issue-7.lock");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    issueNumber: 7,
    owner: `${os.hostname()}:${deadPid}`,
    acquiredAt: new Date().toISOString(),
  }));

  const lease = await manager.acquire(7, "fresh-daemon");
  assert.ok(lease, "expected dead-process lock to be reclaimed");
  assert.equal(lease.owner, "fresh-daemon");
  assert.ok(
    logCalls.some((c) => c.msg === "lease-dead-process-reclaiming"),
    "expected lease-dead-process-reclaiming log",
  );
  assert.equal(
    logCalls.some((c) => c.msg === "lease-stale-reclaiming"),
    false,
    "must not fall back to stale heuristic when dead-process wins",
  );
});

test("filesystem lease refuses to reclaim a lock whose holder is on another host", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-cross-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const manager = createLeaseManager({
    stateDir,
    staleMs: 0, // disable staleness — only dead-process applies
  });

  const file = path.join(stateDir, "leases", "issue-12.lock");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    issueNumber: 12,
    owner: "other-host:99999",
    acquiredAt: new Date().toISOString(),
  }));

  const lease = await manager.acquire(12, "fresh-daemon");
  assert.equal(lease, null, "cross-host holder must not be reclaimed without staleMs");
});

test("GitHub lease reclaims an orphaned ref when the holder's pid is dead", async () => {
  const calls = [];
  // Pick a pid that's already dead — spawn-and-exit a noop.
  const { execFile } = await import("node:child_process");
  const child = execFile(process.execPath, ["-e", "process.exit(0)"], () => {});
  await new Promise((resolve) => child.on("exit", resolve));
  const deadPid = child.pid;

  // The acquire path issues 4 calls (default GET, tree GET, commit POST,
  // ref POST). On EEXIST it inspects + reclaims + retries 4 more.
  const outputs = [
    "mainSha\n",
    "treeSha\n",
    "firstLeaseSha\n",
    null, // throws 422
    "existingCommitSha\n",
    `factory-lease issue=33 owner=${os.hostname()}:${deadPid} ts=2026-01-01T00:00:00.000Z\n`,
    "", // DELETE ok
    "mainSha\n",
    "treeSha\n",
    "secondLeaseSha\n",
    "", // retry ref POST ok
  ];
  let i = 0;
  function nextStdout() {
    const v = outputs[i++];
    if (v === null) {
      const e = new Error("reference already exists");
      e.stderr = "HTTP 422: Reference already exists";
      throw e;
    }
    return { stdout: v };
  }

  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    staleMs: 0,
    log: (level, msg) => calls.push({ kind: "log", level, msg }),
    run: async () => nextStdout(),
  });

  const lease = await manager.acquire(33, "fresh-host");
  assert.ok(lease, "expected dead-process ref to be reclaimed");
  assert.ok(calls.some((c) => c.kind === "log" && c.msg === "lease-dead-process-reclaiming"));
});

test("parseLeaseOwner round-trips the canonical hostname:pid shape", async () => {
  const { parseLeaseOwner, isLeaseHolderDeadOnThisHost } = await import("../runtime/lease-manager.mjs");
  assert.deepEqual(parseLeaseOwner("host-123:9999"), { hostname: "host-123", pid: 9999 });
  assert.equal(parseLeaseOwner("no-colon"), null);
  assert.equal(parseLeaseOwner(":123"), null);
  assert.equal(parseLeaseOwner("host:"), null);
  assert.equal(parseLeaseOwner("host:abc"), null);
  assert.equal(parseLeaseOwner(""), null);
  assert.equal(parseLeaseOwner(null), null);
  assert.equal(parseLeaseOwner(undefined), null);

  // Dead pid: spawn-and-exit a noop.
  const { execFile } = await import("node:child_process");
  const child = execFile(process.execPath, ["-e", "process.exit(0)"], () => {});
  await new Promise((resolve) => child.on("exit", resolve));
  const deadPid = child.pid;
  assert.equal(isLeaseHolderDeadOnThisHost(`${os.hostname()}:${deadPid}`), true);
  // Cross-host: even with a dead pid, cross-host returns false.
  assert.equal(isLeaseHolderDeadOnThisHost(`other-host:${deadPid}`), false);
  // Live pid: process.pid is alive.
  assert.equal(isLeaseHolderDeadOnThisHost(`${os.hostname()}:${process.pid}`), false);
  // Malformed owner: returns false.
  assert.equal(isLeaseHolderDeadOnThisHost("not-a-shape"), false);
});
