// Read-only replay of an actual trusted negative verification, not product acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { stageForLabel } from '../../runtime/pipeline-definition.mjs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const [repository, numberText, stateDir, envFile, workdir] = process.argv.slice(2);
const issueNumber = Number(numberText);
if (!repository || !Number.isSafeInteger(issueNumber) || issueNumber < 1 || !stateDir) {
  throw new Error('Usage: verification-route-probe <repository> <issue> <state-dir>');
}
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const history = await new GitHubStateStore({ repository, token, stateDir }).history(issueNumber);
const record = history.toReversed().find(record => {
  const result = record.envelope.snapshot.implementation?.behaviorVerification;
  return result?.status === 'not-verified' && result.checks?.length && result.checks.every(check => check.passed);
});
assert.ok(record, 'No trusted evidence-rejected verification with passing claimed checks');
const result = record.envelope.snapshot.implementation.behaviorVerification;
const nextStage = stageForLabel('verify-failed');
console.log(JSON.stringify({ trustedRevision: record.envelope.revision, verificationStatus: result.status,
  checks: result.checks.length, failedClaimedChecks: 0, nextStage, remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
assert.equal(nextStage, 'verify', 'Evidence rejection must rerun verification, not mutate the product');
if (envFile) {
  if (!workdir) throw new Error('Real judgment also requires the dedicated project checkout');
  process.loadEnvFile(envFile);
  const { VerifyBehaviorAgent } = await import('../../src/agents/verify-behavior.ts');
  const { fetchIssue } = await import('../../runtime/github-rest.mjs');
  const row = await fetchIssue({ repository, token, number: issueNumber });
  const issue = { ...row, author: row.user?.login ?? '', labels: row.labels.map(label => label.name), comments: [] };
  const runId = result.coverage?.runId ?? /\/runs\/([a-f0-9-]{36})$/.exec(result.ozRunUrl)?.[1];
  assert.match(runId ?? '', /^[a-f0-9-]{36}$/);
  const namespace = createHash('sha256').update(repository).digest('hex');
  const registry = JSON.parse(await readFile(path.join(stateDir, 'evidence', namespace, String(issueNumber), runId, 'acceptance.json'), 'utf8'));
  assert.equal(registry.issue, issueNumber);
  assert.equal(registry.runId, runId);
  const [owner, name] = repository.split('/');
  const logger = { warn(message) { console.error(message); }, info() {}, error() {}, child() { return this; } };
  const context = { issue, repo: { owner, name, defaultBranch: 'main', workdir }, skills: [], skillsRoot: workdir, runId, logger };
  const snapshot = record.envelope.snapshot;
  const judgment = await new VerifyBehaviorAgent(context, 'verify', { spec: snapshot.specs,
    implementationSha: snapshot.implementation.commitSha }).tryTypesafeBatch({ result, checks: result.checks }, registry.receipts);
  console.log(JSON.stringify({ realJudgment: true, status: judgment?.b9?.value, failureKind: judgment?.failureKind,
    judgedChecks: judgment?.b11.size, remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
  assert.ok(judgment, 'Real Jev judgment unavailable; no proof of classification');
  assert.ok(['evidence', 'tool'].includes(judgment.failureKind), 'Unsupported passing claims must not authorize product repair');
}
