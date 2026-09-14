/**
 * Tests for operation receipts (M5).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RECEIPT_STATUSES,
  clearReceipt,
  listReceipts,
  readReceipt,
  receiptPath,
  recordReceipt,
} from "../runtime/operation-receipts.mjs";

function freshStateDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-receipt-"));
  return { stateDir: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("RECEIPT_STATUSES is frozen and exposes the canonical five values", () => {
  assert.equal(Object.isFrozen(RECEIPT_STATUSES), true);
  for (const key of ["succeeded", "failed", "unknown", "retryWait", "blocked"]) {
    assert.ok(typeof RECEIPT_STATUSES[key] === "string", `expected ${key} to be a string`);
  }
});

test("receiptPath composes <stateDir>/receipts/issue-<n>-<kind>.json", () => {
  assert.equal(
    receiptPath("/tmp/state", 7, "lease-release"),
    path.join("/tmp/state", "receipts", "issue-7-lease-release.json"),
  );
});

test("receiptPath rejects an invalid issue number", () => {
  assert.throws(() => receiptPath("/tmp/state", -1, "lease-release"), /Invalid issue number/);
  assert.throws(() => receiptPath("/tmp/state", "abc", "lease-release"), /Invalid issue number/);
});

test("recordReceipt writes a JSON receipt and readReceipt returns it", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    await recordReceipt(stateDir, 1, "lease-release", {
      status: "succeeded",
      owner: "daemon-pid-1234",
      expectedSha: "abc123",
      observedSha: "abc123",
      error: null,
      note: "released cleanly",
    });
    const got = await readReceipt(stateDir, 1, "lease-release");
    assert.ok(got, "receipt must exist after write");
    assert.equal(got.issueNumber, 1);
    assert.equal(got.operationKind, "lease-release");
    assert.equal(got.status, "succeeded");
    assert.equal(got.owner, "daemon-pid-1234");
    assert.equal(got.expectedSha, "abc123");
    assert.equal(got.observedSha, "abc123");
    assert.equal(got.error, null);
    assert.equal(got.note, "released cleanly");
    assert.ok(got.recordedAt, "recordedAt must be populated");
  } finally {
    cleanup();
  }
});

test("recordReceipt fills status=unknown and null fields when input omits them", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    const r = await recordReceipt(stateDir, 2, "pr-merge", {});
    assert.equal(r.status, "unknown");
    assert.equal(r.attempt, null);
    assert.equal(r.owner, null);
    assert.equal(r.expectedSha, null);
    assert.equal(r.observedSha, null);
    assert.equal(r.error, null);
    assert.equal(r.note, null);
  } finally {
    cleanup();
  }
});

test("recordReceipt overwrites previous receipts for the same (issue, kind)", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    await recordReceipt(stateDir, 3, "issue-comment", { status: "failed", error: "first try" });
    await recordReceipt(stateDir, 3, "issue-comment", { status: "succeeded", error: null });
    const got = await readReceipt(stateDir, 3, "issue-comment");
    assert.equal(got.status, "succeeded", "second write must win");
    assert.equal(got.error, null);
  } finally {
    cleanup();
  }
});

test("clearReceipt removes the file and is a no-op when missing", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    await recordReceipt(stateDir, 4, "label-sync", { status: "succeeded" });
    assert.ok((await readReceipt(stateDir, 4, "label-sync")) != null);
    const removed = await clearReceipt(stateDir, 4, "label-sync");
    assert.equal(removed, true);
    assert.equal(await readReceipt(stateDir, 4, "label-sync"), null);
    const removedAgain = await clearReceipt(stateDir, 4, "label-sync");
    assert.equal(removedAgain, false);
  } finally {
    cleanup();
  }
});

test("readReceipt returns null when no receipt exists", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    assert.equal(await readReceipt(stateDir, 99, "lease-release"), null);
  } finally {
    cleanup();
  }
});

test("listReceipts returns every receipt present in <stateDir>/receipts", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    await recordReceipt(stateDir, 1, "lease-release", { status: "succeeded" });
    await recordReceipt(stateDir, 1, "issue-comment", { status: "failed", error: "x" });
    await recordReceipt(stateDir, 2, "lease-release", { status: "succeeded" });
    const list = await listReceipts(stateDir);
    assert.equal(list.length, 3);
    const pairs = list.map((r) => `${r.issueNumber}:${r.operationKind}`).sort();
    assert.deepEqual(pairs, ["1:issue-comment", "1:lease-release", "2:lease-release"]);
  } finally {
    cleanup();
  }
});

test("listReceipts returns an empty list when the directory is missing", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    const list = await listReceipts(stateDir);
    assert.deepEqual(list, []);
  } finally {
    cleanup();
  }
});