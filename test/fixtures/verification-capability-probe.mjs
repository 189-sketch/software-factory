// Read-only replay of a trusted parked verification, never an execution or acceptance proof.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { shouldParkWaitingIssue } from '../../scripts/daemon-support.mjs';
import { needsVerificationCapabilityRecovery, VERIFICATION_CAPABILITY_HASH } from '../../runtime/verification-capabilities.mjs';
import { hasImplementationApproval } from '../../runtime/completion-contract.mjs';

const [repository, numberText, stateDir] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && Number.isSafeInteger(number) && number > 0 && stateDir);
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const state = await new GitHubStateStore({ repository, token, stateDir }).load(number);
assert.ok(state);
const snapshot = structuredClone(state);
const admission = needsVerificationCapabilityRecovery(state);
const parked = shouldParkWaitingIssue({ checkpoint: state, factoryLabels: [state.nextLabel], unchanged: true, autoMerge: true });
console.log(JSON.stringify({ revision: state.revision, admission, parked, priorAttempts: state.verificationRecovery?.attempts,
  priorCapabilities: state.implementation?.behaviorVerification?.executionCapabilities ?? 'legacy',
  currentCapabilities: VERIFICATION_CAPABILITY_HASH, implementationApproval: hasImplementationApproval(state),
  remoteWrites: 0, workerStarts: 0, productAcceptance: 'not-claimed' }));
assert.equal(admission, true, 'A changed verified executor must admit bounded fresh verification');
assert.equal(parked, false);
assert.equal(hasImplementationApproval(state), false, 'Recovery admission must not authorize completion');
assert.deepEqual(state, snapshot, 'Admission must preserve the actual checkpoint and budget');
