// Replay actual admission of an incomplete judgment; never executes or writes a worker.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { shouldParkWaitingIssue } from '../../scripts/daemon-support.mjs';
import { hasVerificationJudgment } from '../../runtime/completion-contract.mjs';
import { judgmentResumeStage, VERIFICATION_JUDGMENT_CONTRACT_VERSION } from '../../runtime/judgment-recovery.mjs';

const [repository, numberText, stateDir, mode] = process.argv.slice(2);
assert.ok(mode === undefined || mode === 'capacity-contract');
const number = Number(numberText);
assert.ok(repository && Number.isSafeInteger(number) && number > 0 && stateDir);
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const state = await new GitHubStateStore({ repository, token, stateDir }).load(number);
assert.equal(state?.status, 'waiting');
if (mode === 'capacity-contract') {
  const failure = state.implementation?.behaviorVerification?.judgmentFailure;
  assert.equal(failure?.kind, 'capacity', 'Requires a real capacity-blocked verification');
  const parked = shouldParkWaitingIssue({ checkpoint: state, factoryLabels: [state.nextLabel],
    retiredLabels: [], unchanged: true, autoMerge: true });
  console.log(JSON.stringify({ revision: state.revision, nextLabel: state.nextLabel, parked,
    failureKind: failure.kind, failureCode: failure.code, priorRequestContract: failure.requestContractVersion ?? null,
    approvedReviewPresent: state.review?.verdict === 'APPROVE',
    semanticAcceptancePresent: hasVerificationJudgment(state.implementation?.behaviorVerification),
    workerStarts: 0, remoteStateWrites: 0 }));
  assert.equal(parked, false, 'A repaired verification request contract must admit bounded automatic recovery');
  assert.equal(judgmentResumeStage(state), 'verify', 'Recovery must bypass unchanged-input freshness, not just polling park');
  const resumed = structuredClone(state);
  resumed.implementation.behaviorVerification.judgmentFailure.requestContractVersion = VERIFICATION_JUDGMENT_CONTRACT_VERSION;
  assert.equal(shouldParkWaitingIssue({ checkpoint: resumed, factoryLabels: [resumed.nextLabel],
    retiredLabels: [], unchanged: true, autoMerge: true }), true, 'Same-version capacity failure must not spin');
  assert.deepEqual(resumed.verificationRecovery, state.verificationRecovery, 'Admission cannot clear the real AC budget');
  assert.deepEqual(resumed.failureCounts, state.failureCounts, 'Admission cannot clear the real failure counters');
} else {
  assert.equal(state.nextLabel, 'verified');
  assert.equal(state.review?.mergeRoute, undefined);
  assert.equal(hasVerificationJudgment(state.implementation?.behaviorVerification), false);
  const parked = shouldParkWaitingIssue({ checkpoint: state, factoryLabels: ['verified'], retiredLabels: [], unchanged: true, autoMerge: true });
  console.log(JSON.stringify({ revision: state.revision, parked, missingReviewRoute: true, missingVerificationJudgment: true,
    workerStarts: 0, remoteStateWrites: 0 }));
  assert.equal(parked, false, 'Missing independent judgment must enter automatic recovery, not permanent operator wait');
}
