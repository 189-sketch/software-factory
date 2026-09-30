/**
 * External operation ledger (M5): verify the begin → in-flight →
 * finish state machine and idempotency-key dedup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  beginExternalOp,
  finishExternalOp,
  markExternalOpInFlight,
  findExternalOp,
  isTerminal,
  runExternalOp,
} from "../core/external-op-ledger.js";
import type { FactoryIssueState, Issue } from "../core/types.js";

function baseState(): FactoryIssueState {
  const issue: Issue = {
    number: 29, title: "看板", body: "", labels: [], author: "tester",
    url: "https://example.com/29", createdAt: "2026-09-17T00:00:00Z", comments: [],
  };
  return { issue, schemaVersion: 2, revision: 0, merged: false, agentMode: "llm" };
}

test("beginExternalOp appends pending row", () => {
  const state = baseState();
  const { id, duplicate } = beginExternalOp(state, { kind: "pr-create", idempotencyKey: "29@feature/29" });
  assert.equal(duplicate, false);
  assert.ok(id);
  assert.equal(state.externalOps!.length, 1);
  assert.equal(state.externalOps![0].status, "pending");
  assert.equal(state.externalOps![0].kind, "pr-create");
  assert.equal(state.externalOps![0].externalId, "29@feature/29");
});

test("beginExternalOp deduplicates against an in-flight row", () => {
  const state = baseState();
  const a = beginExternalOp(state, { kind: "pr-create", idempotencyKey: "29@feature/29" });
  markExternalOpInFlight(state, a.id);
  const b = beginExternalOp(state, { kind: "pr-create", idempotencyKey: "29@feature/29" });
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
  assert.equal(state.externalOps!.length, 1, "no duplicate row");
});

test("beginExternalOp allows new row after the prior succeeded", () => {
  const state = baseState();
  const a = beginExternalOp(state, { kind: "label-sync", idempotencyKey: "29@ready-to-spec" });
  markExternalOpInFlight(state, a.id);
  finishExternalOp(state, { id: a.id, status: "succeeded" });
  const b = beginExternalOp(state, { kind: "label-sync", idempotencyKey: "29@ready-to-implement" });
  assert.equal(b.duplicate, false);
  assert.notEqual(b.id, a.id);
  assert.equal(state.externalOps!.length, 2);
});

test("finishExternalOp records error + attempts", () => {
  const state = baseState();
  const a = beginExternalOp(state, { kind: "issue-comment", idempotencyKey: "29@x" });
  markExternalOpInFlight(state, a.id);
  finishExternalOp(state, { id: a.id, status: "failed", error: "boom" });
  const row = state.externalOps![0];
  assert.equal(row.status, "failed");
  assert.equal(row.error, "boom");
  assert.equal(row.attempts, 1);
});

test("findExternalOp returns the most recent matching row", () => {
  const state = baseState();
  beginExternalOp(state, { kind: "label-sync", idempotencyKey: "29@A" });
  beginExternalOp(state, { kind: "label-sync", idempotencyKey: "29@B" });
  const found = findExternalOp(state, "label-sync", "29@B");
  assert.ok(found);
  assert.equal(found.idempotencyKey, "29@B");
});

test("isTerminal covers the 4 settled statuses", () => {
  assert.equal(isTerminal("succeeded"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("unknown"), true);
  assert.equal(isTerminal("blocked"), true);
  assert.equal(isTerminal("pending"), false);
  assert.equal(isTerminal("in-flight"), false);
  assert.equal(isTerminal("retry-wait"), false);
});

test("runExternalOp durably records in-flight intent before remote execution", async () => {
  const state = baseState();
  const saved: FactoryIssueState[] = [];
  const save = async (current: FactoryIssueState) => { saved.push(structuredClone(current)); };
  await runExternalOp(state, save, { kind: "label-sync", idempotencyKey: "29@ready" }, async () => {
    assert.equal(saved.length, 1);
    assert.equal(saved[0].externalOps?.[0].status, "in-flight");
  });
  assert.equal(saved[1].externalOps?.[0].status, "succeeded");
});

test("runExternalOp never calls the remote write if intent persistence fails", async () => {
  const state = baseState();
  let called = false;
  await assert.rejects(() => runExternalOp(state, async () => { throw new Error("disk full"); },
    { kind: "issue-comment", idempotencyKey: "29@comment" }, async () => { called = true; }), /disk full/);
  assert.equal(called, false);
});

test("runExternalOp leaves ambiguous remote failures visible to reconciliation", async () => {
  const state = baseState();
  const saved: FactoryIssueState[] = [];
  await assert.rejects(() => runExternalOp(state,
    async (current) => { saved.push(structuredClone(current)); },
    { kind: "issue-comment", idempotencyKey: "29@comment" },
    async () => { throw new Error("connection dropped"); }), /connection dropped/);
  assert.equal(saved[0].externalOps?.[0].status, "in-flight");
  assert.equal(saved[1].externalOps?.[0].status, "unknown");
});

test("unknown and interrupted operations cannot be blindly replayed", async () => {
  for (const status of ['unknown', 'in-flight', 'blocked'] as const) {
    const state = baseState();
    const op = { kind: 'pr-create' as const, idempotencyKey: '29@branch' };
    const { id } = beginExternalOp(state, op);
    finishExternalOp(state, { id, status });
    let writes = 0;
    await assert.rejects(runExternalOp(state, async () => { writes++; }, op, async () => { writes++; }), { code: 'FACTORY_STATE_EXTERNAL_OP_UNRESOLVED' });
    assert.equal(writes, 0);
  }
});
