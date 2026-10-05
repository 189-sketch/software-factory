import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { advanceVerificationRecovery, hasProductVerificationFailure } from '../core/verification-recovery.js';
import { acceptanceRequirementsHash } from '../core/completion-contract.js';
import type { FactoryIssueState } from '../core/types.js';

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
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'retry');
  result.checks = [];
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'park');
  result.checks = [{ criterion: 'First behavior', requirementIds: ['AC-1'], passed: true, receiptIds: ['receipt'] }];
  assert.equal(advanceVerificationRecovery(state, 'input', 2), 'park');
  assert.deepEqual(state.verificationRecovery!.coveredRequirementIds, ['AC-1']);
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
