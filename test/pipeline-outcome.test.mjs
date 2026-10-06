import test from "node:test";
import assert from "node:assert/strict";
import { classifyPipelineOutcome } from "../scripts/pipeline-outcome.mjs";

test("verify-failed is waiting, never completed", () => {
  const result = classifyPipelineOutcome(0, {
    status: "waiting",
    verify: "blocked",
    merged: false,
    nextLabel: "verify-failed",
  });

  assert.deepEqual(result, {
    executionOk: true,
    completed: false,
    outcome: "waiting",
  });
});

test("only a merged completed pipeline is completed", () => {
  assert.deepEqual(
    classifyPipelineOutcome(0, { status: "completed", verify: "verified", merged: true }),
    { executionOk: true, completed: true, outcome: "completed" },
  );
});

test("a non-zero pipeline exit is failed", () => {
  assert.deepEqual(
    classifyPipelineOutcome(1, { status: "waiting", merged: false }),
    { executionOk: false, completed: false, outcome: "failed" },
  );
});

test('standalone stage success never claims product completion', () => {
  for (const stage of ['triage', 'review-pr', 'verify-behavior', 'improve-review-pr']) {
    assert.deepEqual(classifyPipelineOutcome(0, { status: 'completed', merged: true }, stage),
      { executionOk: true, completed: false, outcome: 'stage-completed' });
    assert.equal(classifyPipelineOutcome(1, {}, stage).outcome, 'failed');
  }
});
