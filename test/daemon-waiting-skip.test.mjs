import assert from "node:assert/strict";
import test from "node:test";

import { shouldParkWaitingIssue } from "../scripts/daemon-support.mjs";

/**
 * F-XX (2026-09-17) regression coverage for the polling-loop park
 * decision. A `waiting` checkpoint may only be parked when the
 * pipeline genuinely waits for an external actor; a runnable-stage
 * nextLabel (ready-to-implement etc.) means "resume me next poll".
 * The old unconditional label-match park deadlocked issue #29 after a
 * supervisor-scheduled implementation retry.
 */

const base = {
  unchanged: true,
  retiredLabels: [],
  autoMerge: false,
};

test('operator-blocked completion parks even with autoMerge enabled until fresh input', () => {
  const checkpoint = { status: 'waiting', nextLabel: 'verified', merged: true,
    wait: { reason: 'blocked-operator', note: 'Restore issue write permission' } };
  assert.equal(shouldParkWaitingIssue({ ...base, autoMerge: true, checkpoint, factoryLabels: ['verified'] }), true);
  assert.equal(shouldParkWaitingIssue({ ...base, unchanged: false, autoMerge: true, checkpoint, factoryLabels: ['verified'] }), false);
});

test("parks needs-info when the GitHub label matches the checkpoint", () => {
  assert.equal(shouldParkWaitingIssue({
    ...base,
    checkpoint: { status: "waiting", nextLabel: "needs-info" },
    factoryLabels: ["needs-info"],
  }), true);
});

test("parks wait-to-implement (triage-mapped label)", () => {
  assert.equal(shouldParkWaitingIssue({
    ...base,
    checkpoint: { status: "waiting", nextLabel: "wait-to-implement" },
    factoryLabels: ["wait-to-implement"],
  }), true);
});

test("resumes waiting + ready-to-implement (issue #29 supervisor retry deadlock)", () => {
  assert.equal(shouldParkWaitingIssue({
    ...base,
    checkpoint: { status: "waiting", nextLabel: "ready-to-implement" },
    factoryLabels: ["ready-to-implement"],
  }), false);
});

test("resumes every other runnable-stage label", () => {
  for (const nextLabel of ["ready-to-spec", "review-needed", "ready-to-merge", "changes-requested"]) {
    assert.equal(shouldParkWaitingIssue({
      ...base,
      checkpoint: { status: "waiting", nextLabel },
      factoryLabels: [nextLabel],
    }), false, `expected resume for ${nextLabel}`);
  }
});

test("resumes when content changed, labels mismatch, or an error is recorded", () => {
  const checkpoint = { status: "waiting", nextLabel: "needs-info" };
  assert.equal(shouldParkWaitingIssue({
    ...base, unchanged: false, checkpoint, factoryLabels: ["needs-info"],
  }), false);
  assert.equal(shouldParkWaitingIssue({
    ...base, checkpoint, factoryLabels: ["ready-to-spec"],
  }), false);
  assert.equal(shouldParkWaitingIssue({
    ...base, checkpoint: { ...checkpoint, error: "boom" }, factoryLabels: ["needs-info"],
  }), false);
});

test("resumes when a retired label is present (orchestrator must clean it up)", () => {
  assert.equal(shouldParkWaitingIssue({
    ...base,
    retiredLabels: ["spec-ready-for-review"],
    checkpoint: { status: "waiting", nextLabel: "needs-info" },
    factoryLabels: ["needs-info"],
  }), false);
});

test("verified parks only while autoMerge is off", () => {
  const checkpoint = { status: "waiting", nextLabel: "verified" };
  assert.equal(shouldParkWaitingIssue({
    ...base, autoMerge: false, checkpoint, factoryLabels: ["verified"],
  }), true);
  assert.equal(shouldParkWaitingIssue({
    ...base, autoMerge: true, checkpoint, factoryLabels: ["verified"],
  }), false);
});

test("verify-failed parks only while behavior verification is blocked", () => {
  assert.equal(shouldParkWaitingIssue({
    ...base,
    checkpoint: {
      status: "waiting",
      nextLabel: "verify-failed",
      implementation: { behaviorVerification: { status: "blocked" } },
    },
    factoryLabels: ["verify-failed"],
  }), true);
  assert.equal(shouldParkWaitingIssue({
    ...base,
    checkpoint: { status: "waiting", nextLabel: "verify-failed" },
    factoryLabels: ["verify-failed"],
  }), false);
});

test("non-waiting checkpoints and missing checkpoints never park", () => {
  assert.equal(shouldParkWaitingIssue({
    ...base,
    checkpoint: { status: "running", nextLabel: "needs-info" },
    factoryLabels: ["needs-info"],
  }), false);
  assert.equal(shouldParkWaitingIssue({
    ...base, checkpoint: null, factoryLabels: ["needs-info"],
  }), false);
});

test("unknown nextLabel never parks (orchestrator reconciles stale labels)", () => {
  assert.equal(shouldParkWaitingIssue({
    ...base,
    checkpoint: { status: "waiting", nextLabel: "some-future-label" },
    factoryLabels: [],
  }), false);
});
