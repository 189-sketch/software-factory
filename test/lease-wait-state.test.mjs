/**
 * Tests for the lease-wait state helpers (M1, F07).
 *
 * Issue #20's daemon silently retried leased issues without recording
 * why. The plan calls this F07: persistent wait reason, next-attempt
 * time, and recovery action. These tests lock the new
 * `runtime/lease-wait-state.mjs` helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LEASE_WAIT_REASONS,
  clearLeaseWait,
  computeExpectedRecoveryAt,
  leaseWaitPath,
  listLeaseWaits,
  readLeaseWait,
  recordLeaseWait,
} from "../runtime/lease-wait-state.mjs";

function freshStateDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-lease-wait-"));
  return {
    stateDir: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("recordLeaseWait writes a JSON record under stateDir/lease-waits", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    const record = await recordLeaseWait(stateDir, 42, {
      reason: LEASE_WAIT_REASONS.busy,
      holder: "other-daemon",
      staleReclaimEnabled: true,
      staleMs: 300_000,
      blockedAt: "2026-09-14T00:00:00.000Z",
      expectedRecoveryAt: "2026-09-14T00:05:00.000Z",
    });
    assert.equal(record.issueNumber, 42);
    assert.equal(record.reason, "lease-busy");
    assert.equal(record.holder, "other-daemon");
    assert.equal(record.staleReclaimEnabled, true);
    assert.equal(record.staleMs, 300_000);
    assert.equal(record.expectedRecoveryAt, "2026-09-14T00:05:00.000Z");

    const onDisk = await readLeaseWait(stateDir, 42);
    assert.deepEqual(onDisk, record);
  } finally {
    cleanup();
  }
});

test("recordLeaseWait fills in default reason + blockedAt when omitted", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    const before = Date.now();
    const record = await recordLeaseWait(stateDir, 7, {});
    assert.equal(record.reason, "lease-busy");
    const after = Date.now();
    const blockedAtMs = Date.parse(record.blockedAt);
    assert.ok(blockedAtMs >= before && blockedAtMs <= after, "blockedAt must be a fresh ISO timestamp");
    assert.equal(record.issueNumber, 7);
  } finally {
    cleanup();
  }
});

test("recordLeaseWait rejects an invalid issue number", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    await assert.rejects(() => recordLeaseWait(stateDir, -1, {}), /Invalid lease issue number/);
    await assert.rejects(() => recordLeaseWait(stateDir, "abc", {}), /Invalid lease issue number/);
  } finally {
    cleanup();
  }
});

test("clearLeaseWait removes an existing record and is a no-op when missing", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    await recordLeaseWait(stateDir, 1, { reason: LEASE_WAIT_REASONS.busy });
    assert.ok((await readLeaseWait(stateDir, 1)) != null, "record must exist after write");
    const removed = await clearLeaseWait(stateDir, 1);
    assert.equal(removed, true, "must report a record was deleted");
    assert.equal(await readLeaseWait(stateDir, 1), null, "read must report null after clear");

    // Second clear is a no-op, not an error.
    const removedAgain = await clearLeaseWait(stateDir, 1);
    assert.equal(removedAgain, false, "second clear must report nothing to delete");
  } finally {
    cleanup();
  }
});

test("readLeaseWait returns null when no record exists", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    assert.equal(await readLeaseWait(stateDir, 999), null);
  } finally {
    cleanup();
  }
});

test("listLeaseWaits enumerates every recorded issue", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    await recordLeaseWait(stateDir, 1, { reason: LEASE_WAIT_REASONS.busy, holder: "a" });
    await recordLeaseWait(stateDir, 2, { reason: LEASE_WAIT_REASONS.network, holder: null });
    await recordLeaseWait(stateDir, 99, { reason: LEASE_WAIT_REASONS.refused, holder: "b" });
    const listed = await listLeaseWaits(stateDir);
    assert.equal(listed.length, 3);
    const numbers = listed.map((entry) => entry.issueNumber).sort();
    assert.deepEqual(numbers, [1, 2, 99]);
  } finally {
    cleanup();
  }
});

test("listLeaseWaits returns an empty list when the directory is missing", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    const listed = await listLeaseWaits(stateDir);
    assert.deepEqual(listed, []);
  } finally {
    cleanup();
  }
});

test("computeExpectedRecoveryAt adds staleMs to the recorded timestamp", () => {
  const eta = computeExpectedRecoveryAt("2026-09-14T00:00:00.000Z", 300_000);
  assert.equal(eta, "2026-09-14T00:05:00.000Z");
});

test("computeExpectedRecoveryAt returns null when stale reclaim is disabled", () => {
  assert.equal(computeExpectedRecoveryAt("2026-09-14T00:00:00.000Z", 0), null);
  assert.equal(computeExpectedRecoveryAt("2026-09-14T00:00:00.000Z", null), null);
  assert.equal(computeExpectedRecoveryAt("2026-09-14T00:00:00.000Z", undefined), null);
});

test("computeExpectedRecoveryAt returns null for an unparseable timestamp", () => {
  assert.equal(computeExpectedRecoveryAt("not a date", 60_000), null);
});

test("leaseWaitPath composes the canonical <stateDir>/lease-waits/issue-<n>.json path", () => {
  assert.equal(
    leaseWaitPath("/tmp/state", 42),
    path.join("/tmp/state", "lease-waits", "issue-42.json"),
  );
});