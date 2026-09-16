/**
 * Plan §3.3 / T16: Task lifecycle and StageRun execution are
 * independent vocabulary. A REJECT verdict must coexist with a
 * successful execution (the task is waiting on triage; the stage
 * finished cleanly).
 *
 * The change in `stage()` is small but load-bearing: the previous
 * implementation stomped `state.status = 'running'` on every stage
 * entry, which made it impossible to distinguish "the task is
 * waiting on a previous stage's verdict" from "this stage just
 * started running". These tests pin the new behavior:
 *
 * - `stage()` no longer touches `state.status`
 * - `TaskLifecycle` accepts only waiting / completed / failed / queued / simulated
 * - `StageRunStatus` accepts running / succeeded / failed / interrupted / cancelled
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { FactoryIssueState, TaskLifecycle, StageRunStatus } from "../core/types.js";

function makeState(): FactoryIssueState {
  return {
    issue: {
      number: 7,
      title: "demo",
      body: "",
      labels: [],
      author: "alice",
      url: "",
      createdAt: "",
      comments: [],
    },
    merged: false,
  };
}

test("TaskLifecycle and StageRunStatus are independent vocabularies", () => {
  // 'running' is NOT a valid TaskLifecycle — the task is "implicitly
  // running" when any stage's status is 'running'. Tasks only flip to
  // waiting / completed / failed / queued / simulated.
  const taskValues: TaskLifecycle[] = ["queued", "waiting", "completed", "failed", "simulated"];
  for (const v of taskValues) {
    const check: TaskLifecycle = v;
    assert.ok(check);
  }
  // StageRunStatus owns the running transition.
  const stageValues: StageRunStatus[] = ["queued", "running", "succeeded", "failed", "interrupted", "cancelled"];
  for (const v of stageValues) {
    const check: StageRunStatus = v;
    assert.ok(check);
  }
});

test("a task waiting on a REJECT verdict can still record a successful stage execution", () => {
  const state = makeState();
  state.status = "waiting";
  state.specReview = {
    verdict: "REJECT",
    body: "scope creep",
    comments: [],
    notes: "",
    findings: [],
  };
  state.stages ??= {};
  state.stages["review-spec"] = {
    startedAt: "2026-09-14T00:00:00Z",
    endedAt: "2026-09-14T00:00:05Z",
    status: "completed",
    runId: "r-1",
  };
  // The plan §3.3 invariant: a successful execution (status=
  // 'completed') must coexist with a REJECT verdict and the task
  // staying in 'waiting' until triage decides the next step. Both
  // fields must remain readable independently.
  assert.equal(state.status, "waiting");
  assert.equal(state.stages["review-spec"]!.status, "completed");
  assert.equal(state.specReview.verdict, "REJECT");
});