// Read-only replay of authoritative recovery records; never approves acceptance or writes GitHub.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { closeSharedAgent } from '../../runtime/github-rest.mjs';
import { advanceVerificationRecovery } from '../../src/core/verification-recovery.js';
import { verificationChecksHash } from '../../src/core/completion-contract.js';

const [repository, numberText, stateDir] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && stateDir && Number.isSafeInteger(number) && number > 0,
  'Usage: verification-progress-probe <repository> <issue> <state-dir>');
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
try {
  const history = await new GitHubStateStore({ repository, token, stateDir }).history(number);
  const latest = history.at(-1)!.envelope.snapshot;
  const candidates = new Map<string, typeof latest>();
  for (const record of history) {
    const state = record.envelope.snapshot;
    const result = state.implementation?.behaviorVerification;
    if (result?.checks?.length && result.executionCapabilities === latest.implementation?.behaviorVerification?.executionCapabilities
      && state.specs?.commitSha === latest.specs?.commitSha && state.implementation?.commitSha === latest.implementation?.commitSha) {
      candidates.set(verificationChecksHash(result.checks), state);
    }
  }
  const rounds = [...candidates.values()].slice(-2);
  assert.equal(rounds.length, 2, 'Two distinct real verification results are required');
  const state = structuredClone(rounds[0]);
  delete state.verificationRecovery;
  const first = advanceVerificationRecovery(state, 'read-only-replay', 2);
  const firstCovered = [...state.verificationRecovery!.coveredRequirementIds];
  state.implementation!.behaviorVerification = structuredClone(rounds[1].implementation!.behaviorVerification);
  const second = advanceVerificationRecovery(state, 'read-only-replay', 2);
  console.log(JSON.stringify({ revisions: rounds.map(round => round.revision), first, second, firstCovered,
    secondCovered: state.verificationRecovery!.coveredRequirementIds,
    unsupported: rounds.map(round => round.implementation!.behaviorVerification!.checks!.filter(check => !check.passed).length),
    reusedExecutionIdentity: rounds[0].implementation!.behaviorVerification!.coverage!.runId === rounds[1].implementation!.behaviorVerification!.coverage!.runId,
    remoteWrites: 0, workflowExecutions: 0, productAcceptance: 'not-claimed' }));
  assert.equal(second, 'retry', 'Improved complete AC evidence must not be parked as no progress');
} finally {
  await closeSharedAgent();
}
