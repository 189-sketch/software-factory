import assert from "node:assert/strict";
import test from "node:test";

import { shouldParkWaitingIssue } from "../scripts/daemon-support.mjs";
import { classifyJudgmentUnavailable, judgmentRecoveryContext, judgmentRetryPending,
  judgmentResumeStage, scheduleJudgmentRetry } from '../runtime/judgment-recovery.mjs';
import { publicSnapshot } from '../runtime/state-codec.mjs';
import { verificationRecoveryContext, VERIFICATION_CAPABILITY_HASH } from '../runtime/verification-capabilities.mjs';
import { businessInputHash } from '../runtime/business-input.mjs';
import { acceptanceRequirementsHash } from '../runtime/completion-contract.mjs';

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

test('daemon wakes legacy browser evidence once per actual executor contract, not per poll or build', () => {
  const checkpoint = { status: 'waiting', nextLabel: 'verify-failed', merged: false,
    issue: { number: 7, title: 'UI', body: 'Behavior', author: 'operator', labels: ['verify-failed'], comments: [], state: 'open' },
    wait: { reason: 'blocked-operator' }, specs: { commitSha: 'spec', specBranch: 'spec/issue-7', product: { acceptanceCriteria: ['Behavior'] } },
    specReview: { verdict: 'APPROVE' }, specReviewedKey: 'spec/issue-7@spec',
    review: { verdict: 'APPROVE' }, reviewedSha: 'implementation',
    implementation: { commitSha: 'implementation', behaviorVerification: { status: 'blocked', channel: 'browser',
      failure: { kind: 'evidence', runId: 'run' }, coverage: { runId: 'run', specCommitSha: 'spec', implementationSha: 'implementation' } } },
  };
  checkpoint.implementation.behaviorVerification.coverage.requirementsHash = acceptanceRequirementsHash(checkpoint.specs);
  const input = businessInputHash({ ...checkpoint.issue, labels: [] });
  checkpoint.verificationRecovery = { context: verificationRecoveryContext(checkpoint, input), attempts: 2, coveredRequirementIds: [] };
  const park = () => shouldParkWaitingIssue({ ...base, checkpoint, factoryLabels: ['verify-failed'] });
  assert.equal(park(), false);
  assert.equal(checkpoint.verificationRecovery.attempts, 2, 'Admission does not erase the prior budget');
  checkpoint.implementation.behaviorVerification.executionCapabilities = VERIFICATION_CAPABILITY_HASH;
  checkpoint.verificationRecovery.capabilities = VERIFICATION_CAPABILITY_HASH;
  checkpoint.verificationRecovery.context = verificationRecoveryContext(checkpoint, input, VERIFICATION_CAPABILITY_HASH);
  assert.equal(park(), true);
  checkpoint.revision = 999;
  assert.equal(park(), true);
});

function recoveryState() {
  return { issue: { number: 123, title: 'Any CLI behavior', body: 'Expected result', labels: ['verified'], comments: [], state: 'open' },
    status: 'waiting', nextLabel: 'verified', reviewedSha: 'candidate', reviewedBaseSha: 'base',
    specs: { commitSha: 'spec' }, review: { verdict: 'APPROVE' },
    implementation: { commitSha: 'candidate', behaviorVerification: { status: 'verified' } } };
}

test('legacy unjudged execution resumes to review or verify, never directly to merge', () => {
  const checkpoint = recoveryState();
  assert.equal(shouldParkWaitingIssue({ ...base, autoMerge: true, checkpoint, factoryLabels: ['verified'] }), false);
  assert.equal(judgmentResumeStage(checkpoint), 'review');
  checkpoint.review.mergeRoute = { mode: 'auto' };
  assert.equal(judgmentResumeStage(checkpoint), 'verify');
  assert.equal(shouldParkWaitingIssue({ ...base, checkpoint, factoryLabels: ['verified'] }), true, 'Preserve manual merge policy');
  checkpoint.issue.state = 'closed';
  assert.equal(judgmentResumeStage(checkpoint), undefined);
});

test('judgment cooldown is persistent and expires without a user reply or resetting counters', () => {
  const checkpoint = recoveryState(), now = Date.parse('2026-10-05T00:00:00Z');
  checkpoint.nextLabel = 'ready-to-merge';
  checkpoint.wait = scheduleJudgmentRetry(checkpoint, 'verify', 1000, 4000, now);
  const restored = { ...checkpoint, ...publicSnapshot(checkpoint), issue: checkpoint.issue };
  assert.equal(judgmentRetryPending(restored, now), true);
  assert.equal(judgmentResumeStage(restored, now), undefined);
  assert.equal(shouldParkWaitingIssue({ ...base, checkpoint: restored, factoryLabels: ['ready-to-merge'], now }), true);
  assert.equal(judgmentResumeStage(restored, now + 1000), 'verify');
  assert.equal(shouldParkWaitingIssue({ ...base, checkpoint: restored, factoryLabels: ['ready-to-merge'], now: now + 1000 }), false);
  restored.wait = scheduleJudgmentRetry(restored, 'verify', 1000, 4000, now + 1000);
  assert.equal(restored.wait.attempts, 2);
  assert.equal(Date.parse(restored.wait.nextAttemptAt), now + 3000);
  restored.wait = scheduleJudgmentRetry(restored, 'verify', 1000, 4000, now + 3000);
  assert.equal(restored.wait.attempts, 3);
  assert.equal(Date.parse(restored.wait.nextAttemptAt), now + 7000);
});

test('only genuine contract input changes invalidate judgment cooldown', () => {
  const checkpoint = recoveryState(), now = Date.now();
  checkpoint.wait = scheduleJudgmentRetry(checkpoint, 'review', 1000, 4000, now);
  const context = judgmentRecoveryContext(checkpoint, 'review');
  checkpoint.issue.labels = ['review-needed'];
  checkpoint.revision = 500;
  checkpoint.issue.comments.push({ body: '<!-- pi-software-factory:triage:123:internal -->', author: 'operator' });
  assert.equal(judgmentRecoveryContext(checkpoint, 'review'), context);
  assert.equal(judgmentRetryPending(checkpoint, now), true);
  checkpoint.implementation.commitSha = 'new-candidate';
  assert.equal(judgmentRetryPending(checkpoint, now), false);
});

test('configuration, capacity and malformed contracts park instead of retrying every poll', () => {
  for (const warnings of [['http 401'], ['TYPESAFE_API_KEY missing'], ['max_tokens_exceeded'], []]) {
    const checkpoint = recoveryState();
    checkpoint.nextLabel = 'review-needed';
    checkpoint.review.judgmentFailure = classifyJudgmentUnavailable(warnings);
    checkpoint.wait = { reason: 'blocked-operator' };
    assert.equal(shouldParkWaitingIssue({ ...base, checkpoint, factoryLabels: ['review-needed'] }), true);
    assert.equal(shouldParkWaitingIssue({ ...base, checkpoint, unchanged: false, factoryLabels: ['review-needed'] }), false);
  }
  assert.equal(classifyJudgmentUnavailable(['http 503']).kind, 'transient');
  assert.equal(classifyJudgmentUnavailable(['fetch failed']).kind, 'transient');
  assert.equal(classifyJudgmentUnavailable(['http 429']).kind, 'transient');
  assert.equal(classifyJudgmentUnavailable(['max_tokens_exceeded']).kind, 'capacity');
});

test('corrupt retry counters fail closed rather than reset the recovery budget', () => {
  const checkpoint = recoveryState();
  checkpoint.wait = scheduleJudgmentRetry(checkpoint, 'verify', 1000, 4000);
  checkpoint.wait.attempts = NaN;
  assert.throws(() => judgmentRetryPending(checkpoint), { code: 'FACTORY_STATE_JUDGMENT_RECOVERY_INVALID' });
  assert.throws(() => scheduleJudgmentRetry(checkpoint, 'verify', 1000, 4000), { code: 'FACTORY_STATE_JUDGMENT_RECOVERY_INVALID' });
});

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
  assert.equal(shouldParkWaitingIssue({ ...base, factoryLabels: ['verify-failed'],
    checkpoint: { status: 'waiting', nextLabel: 'verify-failed', wait: { reason: 'blocked-operator' },
      implementation: { behaviorVerification: { status: 'not-verified', failure: { kind: 'evidence' } } } } }), true);
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
