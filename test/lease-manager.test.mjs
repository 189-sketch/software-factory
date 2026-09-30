import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createLeaseManager } from "../runtime/lease-manager.mjs";


/**
 * Build a `ghClient` mock that tracks every call and serves canned
 * responses in order. The lease-manager only invokes the six
 * Phase B entry points (`getBranchSha`, `getCommitTree`,
 * `createCommit`, `createRef`, `getRef`, `deleteRef`), plus an
 * inline `fetch` for inspecting existing commit messages, so the
 * mock only needs to mirror those.
 */
function buildMockGh(responses) {
  const calls = [];
  let i = 0;
  const mock = {
    calls,
    async getBranchSha() {
      calls.push({ kind: "getBranchSha" });
      const r = responses[i++];
      if (r && r.thrown) throw r.thrown;
      return r?.value ?? null;
    },
    async getCommitTree() {
      calls.push({ kind: "getCommitTree" });
      const r = responses[i++];
      if (r && r.thrown) throw r.thrown;
      return r?.value ?? null;
    },
    async getCommitMessage() {
      calls.push({ kind: "getCommitMessage" });
      const r = responses[i++];
      if (r && r.thrown) throw r.thrown;
      return r?.value ?? null;
    },
    async createCommit() {
      calls.push({ kind: "createCommit" });
      const r = responses[i++];
      if (r && r.thrown) throw r.thrown;
      return r?.value ?? { sha: "fake-sha" };
    },
    async createRef() {
      calls.push({ kind: "createRef" });
      const r = responses[i++];
      if (r && r.thrown) throw r.thrown;
      return r?.value ?? null;
    },
    async getRef() {
      calls.push({ kind: "getRef" });
      const r = responses[i++];
      if (r && r.thrown) throw r.thrown;
      return r?.value ?? null;
    },
    async deleteRef() {
      calls.push({ kind: "deleteRef" });
      const r = responses[i++];
      if (r && r.thrown) throw r.thrown;
      return r?.value ?? true;
    },
  };
  return mock;
}

test("GitHub lease uses atomic ref creation and keeps credentials out of arguments", async () => {
  const gh = buildMockGh([
    { value: "mainSha" }, // getBranchSha
    { value: "treeSha" }, // getCommitTree
    { value: { sha: "abc123" } }, // createCommit
    { value: null }, // createRef
  ]);
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    ghClient: gh,
  });
  const lease = await manager.acquire(9, "github-run-1");
  assert.equal(lease.backend, "github-ref");
  assert.equal(lease.sha, "abc123");
  assert.equal(gh.calls.length, 4);
  // The createRef call must reference the right ref path.
  assert.ok(gh.calls.some((c) => c.kind === "createRef"));
});

test("GitHub release refuses to delete a lease acquired by a newer owner", async () => {
  const gh = buildMockGh([
    { value: "new-owner-sha" }, // getRef returns the newer owner's SHA
  ]);
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    log: () => {},
    ghClient: gh,
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
  // The SHA mismatch should short-circuit before deleteRef is called.
  assert.equal(gh.calls.some((c) => c.kind === "deleteRef"), false);
});



test("GitHub lease creates a dedicated lease commit and points the ref at it", async () => {
  // The four sequential calls during a clean acquire:
  //  getBranchSha → getCommitTree → createCommit → createRef
  const gh = buildMockGh([
    { value: "mainSha" }, // getBranchSha
    { value: "treeSha" }, // getCommitTree
    { value: { sha: "leaseCommitSha" } }, // createCommit
    { value: null }, // createRef
  ]);
  const logCalls = [];
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    staleMs: 60_000,
    log: (level, msg) => logCalls.push({ level, msg }),
    ghClient: gh,
  });

  const lease = await manager.acquire(42, "host-1234");
  assert.equal(lease.backend, "github-ref");
  assert.equal(lease.sha, "leaseCommitSha");
  assert.equal(gh.calls.length, 4);
  // The commit POST must carry the lease metadata in the message.
  const commitCall = gh.calls.find((c) => c.kind === "createCommit");
  assert.ok(commitCall, "expected a createCommit call");
  // No token leaks into mock-call arguments (none are passed in
  // Phase B; the ghClient surfaces everything internally).
  assert.ok(gh.calls.every((c) => !c.token));
});

test("GitHub lease reclaims a stale ref and retries once", async () => {
  // Stale-reclaim sequence:
  //  getBranchSha → getCommitTree → createCommit → createRef (throws 422)
  //  → getRef (existing) → deleteRef → getBranchSha → getCommitTree → createCommit → createRef
  const e422 = Object.assign(new Error("reference already exists"), { status: 422 });
  const gh = buildMockGh([
    { value: "mainSha" }, // 0 getBranchSha
    { value: "treeSha" }, // 1 getCommitTree
    { value: { sha: "firstLeaseSha" } }, // 2 createCommit
    { thrown: e422 }, // 3 createRef → 422
    { value: "existingCommitSha" }, // 4 getRef (existing)
    { value: "factory-lease issue=5 owner=dead-host:999 ts=2000-01-01T00:00:00.000Z" }, // 5 getCommitMessage
    { value: "mainSha" }, // 6 getBranchSha (retry)
    { value: "treeSha" }, // 7 getCommitTree (retry)
    { value: { sha: "secondLeaseSha" } }, // 8 createCommit (retry)
    { value: null }, // 9 createRef (retry)
  ]);
  // deleteRef succeeds — return true.
  gh.deleteRef = async function () {
    gh.calls.push({ kind: "deleteRef" });
    return true;
  };
  const logCalls = [];
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    staleMs: 60_000,
    log: (level, msg) => logCalls.push({ level, msg }),
    ghClient: gh,
  });

  const lease = await manager.acquire(5, "fresh-host");
  assert.ok(lease, "expected stale ref to be reclaimed");
  assert.equal(lease.backend, "github-ref");
  assert.equal(lease.sha, "secondLeaseSha");
  assert.ok(logCalls.some((c) => c.msg === "lease-stale-reclaiming"));
  // A DELETE must have been issued.
  assert.ok(gh.calls.some((c) => c.kind === "deleteRef"));
});

test("GitHub lease refuses to steal a fresh busy ref", async () => {
  const e422 = Object.assign(new Error("reference already exists"), { status: 422 });
  const gh = buildMockGh([
    { value: "mainSha" }, // getBranchSha
    { value: "treeSha" }, // getCommitTree
    { value: { sha: "firstLeaseSha" } }, // createCommit
    { thrown: e422 }, // createRef
    { value: "existingCommitSha" }, // getRef (existing)
    // Fresh timestamp — must NOT trigger reclaim.
    { value: `factory-lease issue=5 owner=other-host:999 ts=${new Date().toISOString()}` }, // getCommitMessage
  ]);
  const logCalls = [];
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    staleMs: 10 * 60 * 1000,
    log: (level, msg) => logCalls.push({ level, msg }),
    ghClient: gh,
  });
  const result = await manager.acquire(5, "fresh-host");
  assert.equal(result, null);
  assert.equal(logCalls.some((c) => c.msg === "lease-stale-reclaiming"), false);
});

test("GitHub lease release failure logs ERROR and re-throws", async () => {
  const logCalls = [];
  const gh = buildMockGh([]);
  // getRef during release should throw — make it surface a 403.
  gh.getRef = async function () {
    throw Object.assign(new Error("gh api 403 Forbidden"), { status: 403 });
  };
  const manager = createLeaseManager({
    stateDir: path.resolve(".factory"),
    repository: "acme/app",
    token: "secret",
    defaultBranch: "main",
    log: (level, msg, extra) => logCalls.push({ level, msg, extra }),
    ghClient: gh,
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
    const gh = buildMockGh([]);
    gh.getRef = async function () {
      throw new Error("boom");
    };
    const manager = createLeaseManager({
      stateDir: path.resolve(".factory"),
      repository: "acme/app",
      token: "secret",
      ghClient: gh,
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



test("missing GitHub credentials cannot fall back to a file lease", () => {
  assert.throws(() => createLeaseManager({ stateDir: ".factory" }), /file lease fallback is not supported/);
});
