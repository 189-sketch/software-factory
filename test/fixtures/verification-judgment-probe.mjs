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
  const registry = JSON.parse(await readFile(path.join(stateDir, 'evidence', namespace, String(number), runId, 'acceptance.json'), 'utf8'));
  assert.equal(registry.issue, number);
  assert.equal(registry.runId, runId);
  const [owner, name] = repository.split('/');
  const logger = { warn(message) { console.error(message); }, info() {}, error() {}, child() { return this; } };
  const context = { issue: state.issue, repo: { owner, name, defaultBranch: 'main', workdir }, runId, logger };
  setVerifyBehaviorFetchImpl((url, options) => fetch(url, { ...options,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) }));
  try {
    const judgment = await new VerifyBehaviorAgent(context, 'verify', { spec: state.specs,
      implementationSha: state.implementation.commitSha }).tryTypesafeBatch({ result: verification, checks: verification.checks }, registry.receipts);
    console.log(JSON.stringify({ realJudgment: true, available: Boolean(judgment), verdict: judgment?.b9?.value,
      judgedChecks: judgment?.b11.size, checks: verification.checks.length,
      unsupportedChecks: verification.checks.flatMap((check, index) => (judgment?.b11.get(index) ?? -1) < 0.5
        ? [{ index, requirementIds: check.requirementIds, probability: judgment?.b11.get(index) }] : []),
      remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
    assert.ok(judgment, 'Actual independent judgment unavailable');
    assert.equal(judgment.b11.size, verification.checks.length, 'Every existing acceptance check must receive a judgment');
  } finally { setVerifyBehaviorFetchImpl(null); }
}
