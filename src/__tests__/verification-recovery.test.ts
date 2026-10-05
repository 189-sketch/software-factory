import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { advanceVerificationRecovery, hasProductVerificationFailure } from '../core/verification-recovery.js';
import { acceptanceRequirementsHash, verificationChecksHash } from '../core/completion-contract.js';
import type { FactoryIssueState } from '../core/types.js';
import { businessInputHash } from '../../runtime/business-input.mjs';
import { needsVerificationCapabilityRecovery, VERIFICATION_CAPABILITY_HASH } from '../../runtime/verification-capabilities.mjs';

function fixture(): FactoryIssueState {
  const state = { issue: { number: 7 }, merged: false,
    specs: { commitSha: 'spec', product: { acceptanceCriteria: ['First behavior', 'Second behavior'] } },
    implementation: { commitSha: 'implementation', behaviorVerification: { mode: 'verify', status: 'not-verified',
      channel: 'desktop', ozRunUrl: '', evidence: [], notes: 'Insufficient proof', checks: [],
      coverage: { specCommitSha: 'spec', implementationSha: 'implementation', runId: 'run', passingReceiptIds: [], requirementsHash: '' },
    } },
  } as unknown as FactoryIssueState;
  state.implementation!.behaviorVerification!.coverage!.requirementsHash = acceptanceRequirementsHash(state.specs);
  return state;
}

function judgeChecks(state: FactoryIssueState): void {
  const result = state.implementation!.behaviorVerification!;
  result.judgment = { runId: result.coverage!.runId, checksHash: verificationChecksHash(result.checks),
    verdict: 'verified', confidence: 1,
    checks: result.checks!.map((check, index) => ({ index, probability: check.passed ? 0.9 : 0.1 })) };
}

test('negative status or semantic downgrade alone never authorizes product repair', () => {
  const state = fixture();
  assert.equal(hasProductVerificationFailure(state), false);
  state.implementation!.behaviorVerification!.failure = { kind: 'evidence', runId: 'run', receiptIds: [], requirementIds: [], reason: 'B11 lacks support' };
  assert.equal(hasProductVerificationFailure(state), false);
});

test('product recovery requires exact current AC, run, spec and implementation bindings', () => {
  const state = fixture();
  const result = state.implementation!.behaviorVerification!;
  result.checks = [{ criterion: 'First behavior', requirementIds: ['AC-1'], passed: false, receiptIds: ['failed'] }];
  result.failure = { kind: 'product', runId: 'run', receiptIds: ['failed'], requirementIds: ['AC-1'], reason: 'Observed failure' };
  assert.equal(hasProductVerificationFailure(state), true);
  for (const mutate of [
    (copy: FactoryIssueState) => { copy.specs!.commitSha = 'new-spec'; },
    (copy: FactoryIssueState) => { copy.implementation!.commitSha = 'new-implementation'; },
    (copy: FactoryIssueState) => { copy.implementation!.behaviorVerification!.failure!.runId = 'other-run'; },
    (copy: FactoryIssueState) => { copy.implementation!.behaviorVerification!.failure!.requirementIds = ['invented']; },
    (copy: FactoryIssueState) => { copy.implementation!.behaviorVerification!.coverage!.passingReceiptIds = ['failed']; },
  ]) {
    const copy = structuredClone(state);
    mutate(copy);
    assert.equal(hasProductVerificationFailure(copy), false);
  }
});

test('new receipts, notes and checkpoint revisions do not reset no-progress recovery', () => {
  const state = fixture();
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'retry');
  const result = state.implementation!.behaviorVerification!;
  result.coverage!.runId = randomUUID();
  result.notes = 'New wording is not new evidence';
  state.revision = 100;
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'park');
  assert.equal(state.verificationRecovery!.attempts, 2);
  const restarted = structuredClone(state);
  assert.equal(advanceVerificationRecovery(restarted, 'input', 2), 'park');
});

test('AC progress permits recovery but alternating old coverage cannot create an endless loop', () => {
  const state = fixture();
  const result = state.implementation!.behaviorVerification!;
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'retry');
  result.coverage!.passingReceiptIds = ['receipt'];
  result.checks = [{ criterion: 'First behavior', requirementIds: ['AC-1'], passed: true, receiptIds: ['receipt'] }];
  judgeChecks(state);
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'retry');
  result.checks = [];
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'park');
  result.checks = [{ criterion: 'First behavior', requirementIds: ['AC-1'], passed: true, receiptIds: ['receipt'] }];
  judgeChecks(state);
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'park');
  assert.deepEqual(state.verificationRecovery!.coveredRequirementIds, ['AC-1']);
});

test('a passing sub-check cannot hide unsupported evidence for the same AC; completing it is progress', () => {
  const state = fixture();
  const result = state.implementation!.behaviorVerification!;
  result.coverage!.passingReceiptIds = ['action', 'assertion'];
  result.checks = [
    { criterion: 'First behavior interaction', requirementIds: ['AC-1'], passed: true, receiptIds: ['action'] },
    { criterion: 'First behavior outcome', requirementIds: ['AC-1'], passed: false, receiptIds: ['assertion'] },
  ];
  judgeChecks(state);
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'retry');
  assert.deepEqual(state.verificationRecovery!.coveredRequirementIds, []);
  result.checks[1]!.passed = true;
  judgeChecks(state);
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'retry');
  assert.deepEqual(state.verificationRecovery!.coveredRequirementIds, ['AC-1']);
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'park');
  assert.equal(advanceVerificationRecovery(structuredClone(state), 'input', 2), 'park');
});

test('unbound, missing, duplicate or negative judgments cannot replenish the evidence budget', () => {
  for (const mutate of [
    (state: FactoryIssueState) => { delete state.implementation!.behaviorVerification!.judgment; },
    (state: FactoryIssueState) => { state.implementation!.behaviorVerification!.judgment!.runId = 'different'; },
    (state: FactoryIssueState) => { state.implementation!.behaviorVerification!.judgment!.checksHash = 'different'; },
    (state: FactoryIssueState) => { state.implementation!.behaviorVerification!.judgment!.checks = []; },
    (state: FactoryIssueState) => { state.implementation!.behaviorVerification!.judgment!.checks[0]!.probability = 0.1; },
    (state: FactoryIssueState) => { state.implementation!.behaviorVerification!.judgment!.checks[0]!.probability = 1.1; },
    (state: FactoryIssueState) => { state.implementation!.behaviorVerification!.judgment!.checks.push({ index: 0, probability: 0.1 }); },
  ]) {
    const state = fixture();
    advanceVerificationRecovery(state, 'input', 2);
    const result = state.implementation!.behaviorVerification!;
    result.coverage!.passingReceiptIds = ['receipt'];
    result.checks = [{ criterion: 'First behavior', requirementIds: ['AC-1'], passed: true, receiptIds: ['receipt'] }];
    judgeChecks(state);
    mutate(state);
    assert.equal(advanceVerificationRecovery(state, 'input', 2), 'park');
    assert.deepEqual(state.verificationRecovery!.coveredRequirementIds, []);
  }
});

test('only actual business or implementation changes establish a fresh recovery context', () => {
  const state = fixture();
  advanceVerificationRecovery(state, 'input', 2);
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'park');
  assert.equal(advanceVerificationRecovery(state, 'new input', 2), 'retry');
  state.implementation!.commitSha = 'new implementation';
  assert.equal(advanceVerificationRecovery(state, 'new input', 2), 'retry');
});

test('stale coverage cannot claim progress and corrupt counters fail closed as state faults', () => {
  const state = fixture();
  advanceVerificationRecovery(state, 'input', 2);
  const result = state.implementation!.behaviorVerification!;
  result.coverage!.implementationSha = 'old';
  result.coverage!.passingReceiptIds = ['receipt'];
  result.checks = [{ criterion: 'First behavior', requirementIds: ['AC-1'], passed: true, receiptIds: ['receipt'] }];
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'park');
  state.verificationRecovery!.attempts = NaN;
  assert.throws(() => advanceVerificationRecovery(state, 'input', 2), { code: 'FACTORY_STATE_VERIFICATION_RECOVERY_INVALID' });
});

test('a real executor upgrade admits bounded evidence recovery, not builds, replies or product repair', () => {
  const state = fixture();
  Object.assign(state.issue, { title: 'UI behavior', body: 'Expected behavior', author: 'operator',
    state: 'open', labels: ['verify-failed'], comments: [] });
  Object.assign(state, { status: 'waiting', nextLabel: 'verify-failed',
    wait: { reason: 'blocked-operator', note: 'Evidence exhausted', since: '2026-10-05T10:00:00Z' },
    specReview: { verdict: 'APPROVE' }, specReviewedKey: 'spec/issue-7@spec',
    review: { verdict: 'APPROVE' }, reviewedSha: 'implementation' });
  state.specs!.specBranch = 'spec/issue-7';
  const result = state.implementation!.behaviorVerification!;
  result.channel = 'browser';
  result.failure = { kind: 'evidence', runId: 'run', receiptIds: [], requirementIds: [], reason: 'Missing causal evidence' };
  const input = businessInputHash({ ...state.issue, labels: [] });
  advanceVerificationRecovery(state, input, 2);
  assert.equal(advanceVerificationRecovery(state, input, 2), 'park');
  const legacy = structuredClone(state);
  assert.equal(needsVerificationCapabilityRecovery(state), true);
  assert.deepEqual(state, legacy, 'Admission does not mutate evidence or budgets');
  const interrupted = structuredClone(legacy);
  interrupted.nextLabel = 'ready-to-merge';
  delete interrupted.wait;
  interrupted.verificationRecovery!.pendingCapabilities = VERIFICATION_CAPABILITY_HASH;
  assert.equal(needsVerificationCapabilityRecovery(interrupted), true, 'Durable admission survives interruption before execution');
  for (const mutate of [
    (copy: FactoryIssueState) => { copy.merged = true; },
    (copy: FactoryIssueState) => { copy.issue.state = 'closed'; },
    (copy: FactoryIssueState) => { copy.review!.verdict = 'REJECT'; },
    (copy: FactoryIssueState) => { copy.implementation!.behaviorVerification!.failure!.kind = 'product'; },
    (copy: FactoryIssueState) => { copy.implementation!.behaviorVerification!.channel = 'desktop'; },
    (copy: FactoryIssueState) => { copy.issue.body = 'Changed business input'; },
    (copy: FactoryIssueState) => { copy.implementation!.behaviorVerification!.coverage!.implementationSha = 'stale'; },
    (copy: FactoryIssueState) => { copy.implementation!.behaviorVerification!.judgmentFailure = { kind: 'capacity', code: 'MAX_TOKENS_EXCEEDED' }; },
    (copy: FactoryIssueState) => { copy.implementation!.behaviorVerification!.judgmentFailure = { kind: 'transient', code: 'JUDGMENT_SERVICE_UNAVAILABLE' }; },
  ]) {
    const copy = structuredClone(legacy);
    mutate(copy);
    assert.equal(needsVerificationCapabilityRecovery(copy), false);
  }
  result.executionCapabilities = VERIFICATION_CAPABILITY_HASH;
  assert.equal(advanceVerificationRecovery(state, input, 2), 'retry');
  assert.equal(state.verificationRecovery!.attempts, 1, 'Only an actually executed new contract establishes its own budget');
  assert.equal(advanceVerificationRecovery(state, input, 2), 'park');
  assert.equal(needsVerificationCapabilityRecovery(state), false);
  state.revision = 999;
  result.notes = 'New build and run identifiers are not new capabilities';
  assert.equal(needsVerificationCapabilityRecovery(state), false);
  result.executionCapabilities = 'model-selected-capabilities';
  assert.throws(() => advanceVerificationRecovery(state, input, 2), { code: 'FACTORY_STATE_VERIFICATION_RECOVERY_INVALID' });
  interrupted.verificationRecovery!.pendingCapabilities = 'model-selected-capabilities';
  assert.throws(() => needsVerificationCapabilityRecovery(interrupted), { code: 'FACTORY_STATE_VERIFICATION_RECOVERY_INVALID' });
});
