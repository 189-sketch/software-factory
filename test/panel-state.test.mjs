import test from "node:test";
import assert from "node:assert/strict";
import { buildStages, issueSummary } from "../control-panel/src/data/api.ts";

test("blocked behavior verification is rendered as failed", () => {
  const issue = {
    issue: { number: 1, title: "Dashboard" },
    implementation: {
      comment: "All implementation work is complete",
      behaviorVerification: { status: "blocked", notes: "Browser verification unavailable" },
    },
    review: { verdict: "APPROVE" },
    merged: false,
    status: "waiting",
    nextLabel: "verify-failed",
    stages: {
      implementation: { status: "completed" },
      review: { status: "completed" },
      verify: { status: "completed" },
    },
  };

  assert.equal(buildStages(issue).find((stage) => stage.id === "verify")?.status, "failed");
  assert.equal(issueSummary(issue), "Browser verification unavailable");
});

test('running stage takes precedence over task waiting and results from the previous attempt', () => {
  const issue = { status: 'waiting', nextLabel: 'ready-to-merge',
    implementation: { behaviorVerification: { status: 'blocked', notes: 'Old failure' } },
    review: { verdict: 'APPROVE' }, stages: { verify: { status: 'running' } } };
  assert.equal(buildStages(issue).find(stage => stage.id === 'verify').status, 'running');
  assert.match(issueSummary(issue), /verif/i);
  assert.doesNotMatch(issueSummary(issue), /Old failure/);
});

test('a completed implementation does not imply stages with no execution evidence have passed', () => {
  const stages = buildStages({ nextLabel: 'review-needed', stages: { implementation: { status: 'completed' } } });
  assert.equal(stages.find(stage => stage.id === 'implementation').status, 'passed');
  assert.equal(stages.find(stage => stage.id === 'spec').status, 'pending');
});

test('a completed review execution still displays a rejected gate as failed', () => {
  const issue = { specReview: { verdict: 'REJECT' }, review: { verdict: 'REJECT' },
    stages: { spec: { status: 'completed' }, review: { status: 'completed' } } };
  for (const id of ['spec', 'review']) {
    assert.equal(buildStages(issue).find(stage => stage.id === id).status, 'failed');
    issue.stages[id].status = 'running';
    assert.equal(buildStages(issue).find(stage => stage.id === id).status, 'running');
  }
});

test('queue, explicit wait and confirmed completion are distinct from execution', () => {
  assert.equal(issueSummary({ nextLabel: 'ready-to-implement' }), 'Awaiting implementation');
  assert.equal(issueSummary({ nextLabel: 'verified', wait: { note: 'Manual merge required' } }), 'Manual merge required');
  assert.equal(issueSummary({ merged: true, status: 'waiting' }), 'PR merged; finalizing issue closure');
  assert.equal(issueSummary({ merged: true, status: 'waiting', nextLabel: 'verified' }), 'PR merged; finalizing issue closure');
  assert.equal(issueSummary({ merged: true, status: 'completed' }), 'Completed');
});
