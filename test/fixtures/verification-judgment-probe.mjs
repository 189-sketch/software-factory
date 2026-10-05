// Audit a real trusted verification without executing or writing the workflow.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { hasImplementationApproval } from '../../runtime/completion-contract.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [repository, numberText, stateDir, envFile, workdir] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && Number.isSafeInteger(number) && number > 0 && stateDir);
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const state = await new GitHubStateStore({ repository, token, stateDir }).load(number);
assert.ok(state?.implementation?.behaviorVerification, 'Requires actual trusted verification');
const verification = state.implementation.behaviorVerification;
const approval = hasImplementationApproval(state);
console.log(JSON.stringify({ revision: state.revision, status: verification.status,
  independentJudgmentPresent: Boolean(verification.judgment), implementationApproval: approval,
  remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
if (!verification.judgment) assert.equal(approval, false, 'Unjudged real verification must not authorize completion');
if (envFile) {
  assert.ok(workdir, 'Actual judgment requires the dedicated checkout');
  process.loadEnvFile(envFile);
  const { VerifyBehaviorAgent, setVerifyBehaviorFetchImpl } = await import('../../src/agents/verify-behavior.ts');
  const runId = verification.coverage?.runId;
  assert.match(runId ?? '', /^[a-f0-9-]{36}$/);
  const namespace = createHash('sha256').update(repository).digest('hex');
  const receiptPath = path.join(stateDir, 'evidence', namespace, String(number), runId, 'acceptance.json');
  const originalBytes = await readFile(receiptPath);
  const registry = JSON.parse(originalBytes.toString('utf8'));
  assert.equal(registry.issue, number);
  assert.equal(registry.runId, runId);
  const [owner, name] = repository.split('/');
  const logger = { warn(message) { console.error(message); }, info() {}, error() {}, child() { return this; } };
  const context = { issue: state.issue, repo: { owner, name, defaultBranch: 'main', workdir }, runId, logger, artifactStateDir: stateDir };
  setVerifyBehaviorFetchImpl((url, options) => fetch(url, { ...options,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) }));
  try {
    const result = await new VerifyBehaviorAgent(context, 'verify', { spec: state.specs,
      implementationSha: state.implementation.commitSha }).rejudge(verification);
    const judgment = result?.judgment;
    console.log(JSON.stringify({ realJudgment: true, available: Boolean(judgment), verdict: judgment?.verdict,
      recoveredStatus: result?.status, reusedExecutionRun: result?.coverage?.runId === runId,
      judgedChecks: judgment?.checks.length, checks: verification.checks.length,
      unsupportedChecks: verification.checks.flatMap((check, index) => (judgment?.checks.find(item => item.index === index)?.probability ?? -1) < 0.5
        ? [{ index, requirementIds: check.requirementIds, probability: judgment?.checks.find(item => item.index === index)?.probability }] : []),
      remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
    assert.ok(judgment, 'Actual independent judgment unavailable');
    assert.equal(judgment.checks.length, verification.checks.length, 'Every existing acceptance check must receive a judgment');
    assert.equal(judgment.runId, runId);
    assert.deepEqual(await readFile(receiptPath), originalBytes, 'Recovery must not rewrite actual execution evidence');
  } finally { setVerifyBehaviorFetchImpl(null); }
}
