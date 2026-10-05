// Replay actual admission of an incomplete judgment; never executes or writes a worker.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { shouldParkWaitingIssue } from '../../scripts/daemon-support.mjs';
import { hasVerificationJudgment } from '../../runtime/completion-contract.mjs';

const [repository, numberText, stateDir] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && Number.isSafeInteger(number) && number > 0 && stateDir);
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const state = await new GitHubStateStore({ repository, token, stateDir }).load(number);
assert.equal(state?.status, 'waiting');
assert.equal(state.nextLabel, 'verified');
assert.equal(state.review?.mergeRoute, undefined);
assert.equal(hasVerificationJudgment(state.implementation?.behaviorVerification), false);
const parked = shouldParkWaitingIssue({ checkpoint: state, factoryLabels: ['verified'], retiredLabels: [], unchanged: true, autoMerge: true });
console.log(JSON.stringify({ revision: state.revision, parked, missingReviewRoute: true, missingVerificationJudgment: true,
  workerStarts: 0, remoteStateWrites: 0 }));
assert.equal(parked, false, 'Missing independent judgment must enter automatic recovery, not permanent operator wait');
