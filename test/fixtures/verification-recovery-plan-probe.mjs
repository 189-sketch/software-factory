// Read-only replay of the actual recovery branch over trusted project evidence.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { closeSharedAgent } from '../../runtime/github-rest.mjs';
import * as recovery from '../../src/core/verification-recovery.ts';

const [repository, numberText, stateDir] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && stateDir && Number.isSafeInteger(number) && number > 0);
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
try {
  const original = await new GitHubStateStore({ repository, token, stateDir }).load(number);
  const originalCopy = structuredClone(original);
  const result = original?.implementation?.behaviorVerification;
  assert.equal(result?.failure?.kind, 'evidence', 'Requires a real evidence-rejected execution');
  assert.equal(result.judgmentFailure, undefined);
  const unsupported = result.checks.map((check, index) => ({ check, index }))
    .filter(({ check }) => !check.passed);
  assert.ok(unsupported.length, 'Requires actual unsupported checks');
  const source = await readFile(new URL('../../src/orchestrator/index.ts', import.meta.url), 'utf8');
  const branch = source.slice(source.indexOf('const recovery = advanceVerificationRecovery'));
  const statement = branch.match(/state\.correction = \{ targetStage: 'verify-behavior', turns: \[[\s\S]*?\]\s*\};/)?.[0];
  assert.ok(statement, 'The production evidence-recovery branch must still be identifiable');
  const state = structuredClone(original);
  const correction = new Function('state', 'sha', 'detail', 'buildVerificationRecoveryPlan',
    `${statement}; return state.correction;`)(state, original.implementation.commitSha,
    result.failure.reason || result.notes, recovery.buildVerificationRecoveryPlan);
  const prefix = 'Verification recovery obligations (prior execution only):\n';
  const turn = correction.turns.find(turn => turn.startsWith(prefix));
  console.log(JSON.stringify({ revision: original.revision, unsupportedChecks: unsupported.length,
    structuredRecoveryPlan: Boolean(turn), remoteWrites: 0, workerStarts: 0, productAcceptance: 'not-claimed' }));
  assert.ok(turn, 'Actual recovery must provide check/AC/receipt obligations, not only truncated failure prose');
  const plan = JSON.parse(turn.slice(prefix.length));
  assert.equal(plan.sourceRunId, result.coverage.runId);
  assert.equal(plan.boundToCurrentApproval, true);
  for (const { check, index } of unsupported) {
    const target = plan.checksNeedingEvidence.find(target => target.index === index);
    assert.ok(target, 'Every actual unsupported check must remain actionable');
    assert.equal(target.criterion, check.criterion);
    assert.deepEqual(target.requirementIds, check.requirementIds);
    assert.deepEqual(target.receiptIds, check.receiptIds);
  }
  assert.deepEqual(original, originalCopy, 'Read-only branch replay cannot mutate its input');
} finally {
  closeSharedAgent();
}
