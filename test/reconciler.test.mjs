/**
 * Reconciler (M5): verify the three sweeps that keep the factory
 * state consistent with the real world after a daemon crash.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findStaleInFlight,
  findStaleLeases,
  findOrphanWorktrees,
  runReconciler,
} from "../scripts/reconciler.mjs";

function freshRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-reconciler-"));
  return root;
}

function makeIssue(root, issueNumber, externalOps) {
  mkdirSync(path.join(root, "issues"), { recursive: true });
  writeFileSync(
    path.join(root, "issues", `${issueNumber}.json`),
    JSON.stringify({ issue: { number: issueNumber }, externalOps }),
  );
}

test("findStaleInFlight surfaces in-flight rows older than threshold", async () => {
  const root = freshRoot();
  const now = Date.now();
  makeIssue(root, 29, [
    { id: "a", kind: "pr-create", status: "in-flight", updatedAt: new Date(now - 10 * 60_000).toISOString(), idempotencyKey: "29@feature/29" },
    { id: "b", kind: "pr-create", status: "in-flight", updatedAt: new Date(now - 30_000).toISOString(), idempotencyKey: "29@feature/29-second" },
    { id: "c", kind: "label-sync", status: "succeeded", updatedAt: new Date(now - 10 * 60_000).toISOString() },
  ]);
  // Default threshold is 5 min, so only `a` should be reported.
  const stale = await findStaleInFlight(root);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].opId, "a");
  assert.ok(stale[0].ageMs >= 5 * 60_000);
});

test("findStaleInFlight with short threshold surfaces more rows", async () => {
  const root = freshRoot();
  const now = Date.now();
  makeIssue(root, 30, [
    { id: "x", kind: "issue-comment", status: "in-flight", updatedAt: new Date(now - 60_000).toISOString() },
  ]);
  const stale = await findStaleInFlight(root, 30_000);
  assert.equal(stale.length, 1);
});

test("findStaleInFlight returns [] when state dir is missing", async () => {
  const root = freshRoot();
  const stale = await findStaleInFlight(root);
  assert.deepEqual(stale, []);
});

test("findStaleLeases flags a .lock whose mtime is older than threshold", async () => {
  const root = freshRoot();
  mkdirSync(path.join(root, "leases"), { recursive: true });
  const lockFile = path.join(root, "leases", "issue-29.lock");
  writeFileSync(lockFile, JSON.stringify({ issueNumber: 29, owner: "host:pid" }));
  // Force mtime 1 hour in the past.
  const t = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(lockFile, t, t);
  // POSIX-only check: the lockfile's pid is bogus so the
  // process.kill(0) call would throw and we'd report it as stale.
  // On Windows the test will still pass because the reconciler
  // skips the liveness check and relies on mtime alone.
  if (process.platform !== "win32") {
    const stale = await findStaleLeases(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].issueNumber, 29);
  } else {
    const stale = await findStaleLeases(root);
    assert.equal(stale.length, 1);
  }
});

test("findStaleLeases keeps a fresh lock untouched", async () => {
  const root = freshRoot();
  mkdirSync(path.join(root, "leases"), { recursive: true });
  const lockFile = path.join(root, "leases", "issue-30.lock");
  writeFileSync(lockFile, JSON.stringify({ issueNumber: 30, owner: "host:pid" }));
  // mtime is "now" so the threshold (30 min) is not exceeded.
  const stale = await findStaleLeases(root);
  assert.equal(stale.length, 0);
});

test("findOrphanWorktrees surfaces worktrees for non-in-flight issues", async () => {
  const root = freshRoot();
  const workdir = path.join(root, "workdir");
  mkdirSync(path.join(workdir, "issue-31"), { recursive: true });
  // Make directory mtime 2 days old.
  const t = (Date.now() - 48 * 60 * 60_000) / 1000;
  utimesSync(path.join(workdir, "issue-31"), t, t);
  // No in-flight state file for 31 → orphan.
  const orphans = await findOrphanWorktrees(workdir, root);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].issueNumber, 31);
});

test("findOrphanWorktrees skips worktrees backed by an in-flight state file", async () => {
  const root = freshRoot();
  const workdir = path.join(root, "workdir");
  mkdirSync(path.join(workdir, "issue-32"), { recursive: true });
  const t = (Date.now() - 48 * 60 * 60_000) / 1000;
  utimesSync(path.join(workdir, "issue-32"), t, t);
  makeIssue(root, 32, []);
  const orphans = await findOrphanWorktrees(workdir, root);
  assert.equal(orphans.length, 0);
});

test("findOrphanWorktrees skips the shared repository clone", async () => {
  const root = freshRoot();
  const workdir = path.join(root, "workdir");
  mkdirSync(path.join(workdir, "repository"), { recursive: true });
  const t = (Date.now() - 48 * 60 * 60_000) / 1000;
  utimesSync(path.join(workdir, "repository"), t, t);
  const orphans = await findOrphanWorktrees(workdir, root);
  assert.equal(orphans.length, 0);
});

test("runReconciler aggregates all three sweeps", async () => {
  const root = freshRoot();
  const workdir = path.join(root, "workdir");
  mkdirSync(workdir, { recursive: true });
  // 1. Stale in-flight
  makeIssue(root, 33, [
    { id: "x", kind: "pr-create", status: "in-flight", updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
  ]);
  // 2. Stale lease
  mkdirSync(path.join(root, "leases"), { recursive: true });
  const lockFile = path.join(root, "leases", "issue-34.lock");
  writeFileSync(lockFile, "{}");
  const t = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(lockFile, t, t);
  // 3. Orphan worktree
  mkdirSync(path.join(workdir, "issue-35"), { recursive: true });
  const t2 = (Date.now() - 48 * 60 * 60_000) / 1000;
  utimesSync(path.join(workdir, "issue-35"), t2, t2);

  const report = await runReconciler({ stateDir: root, workdir });
  assert.equal(report.inFlight.length, 1);
  assert.equal(report.inFlight[0].issueNumber, 33);
  assert.equal(report.staleLeases.length, 1);
  assert.equal(report.orphanWorktrees.length, 1);
  assert.equal(report.orphanWorktrees[0].issueNumber, 35);
  assert.ok(report.ranAt);
});
