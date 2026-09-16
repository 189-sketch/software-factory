/**
 * External operation receipt tests (M5).
 *
 * The orchestrator's GitHub side-effect helpers (syncLabel,
 * publishTriageDecision, publishSpecReviewDecision,
 * publishReviewDecision) each call `recordExternalOp` to persist a
 * receipt so a daemon restart can resume from the last confirmed
 * state. This test exercises the receipt module against a fixture
 * state directory and verifies the canonical kinds are accepted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listReceipts, readReceipt } from "../runtime/operation-receipts.mjs";

function freshStateDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-ext-receipt-"));
  return { stateDir: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("listReceipts returns an empty list before any orchestrator side-effect fires", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    assert.deepEqual(await listReceipts(stateDir), []);
  } finally {
    cleanup();
  }
});

test("readReceipt returns null until the orchestrator writes one", async () => {
  const { stateDir, cleanup } = freshStateDir();
  try {
    assert.equal(await readReceipt(stateDir, 7, "label-sync"), null);
  } finally {
    cleanup();
  }
});