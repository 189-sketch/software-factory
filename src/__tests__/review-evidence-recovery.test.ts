import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { ReviewPrAgent, parseReviewResult } from '../agents/review-pr.js';
import { VerifyBehaviorAgent } from '../agents/verify-behavior.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';
import { reviewJudgmentInputHash } from '../../runtime/review-judgment-context.mjs';

for (const scenario of ['repaired', 'exhausted', 'technical-spec'] as const) {
const repairSucceeds = scenario === 'repaired';
test(scenario === 'technical-spec' ? 'confirmed technical defects return through specification repair before product implementation'
  : repairSucceeds ? 'actual review recovery repairs evidence after cooldown without author intervention or product reimplementation'
  : 'unchanged review evidence failures stop after the durable repair budget is exhausted', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-review-recovery-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const exec = promisify(execFile);
  const workdir = path.join(root, 'project'), origin = path.join(root, 'origin.git');
  await fs.mkdir(workdir);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: workdir })).stdout.trim();
  await exec('git', ['init', '--bare', origin]);
  await git('init', '-b', 'main');
  await fs.mkdir(path.join(workdir, 'specs', 'feedback'), { recursive: true });
  await fs.writeFile(path.join(workdir, 'specs', 'feedback', 'PRODUCT.md'), 'Approved feedback');
  await fs.writeFile(path.join(workdir, 'specs', 'feedback', 'TECH.md'), 'Approved SQLite design');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Approved baseline');
  const base = await git('rev-parse', 'HEAD');
  await git('remote', 'add', 'origin', origin);
  await git('push', 'origin', 'main');
  await git('checkout', '-b', 'feature/issue-7-feedback');
  await fs.writeFile(path.join(workdir, 'Feedback.tsx'), 'export const Feedback = () => "form";\n');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Feedback implementation');
  const head = await git('rev-parse', 'HEAD');
  await git('push', 'origin', 'feature/issue-7-feedback');
  const issue = { number: 7, title: 'Feedback', body: 'Add feedback with SQLite', author: 'operator',
    labels: ['review-needed'], comments: [], state: 'open', createdAt: '' };
  const specs = { commitSha: base, specBranch: 'spec/feedback',
    product: { slug: 'feedback', acceptanceCriteria: ['Form above feedback list'] }, tech: { slug: 'feedback' } };
  const state: any = { issue, merged: false, status: 'waiting', nextLabel: 'review-needed', specs,
    specReview: { verdict: 'APPROVE' }, specReviewedKey: `spec/feedback@${base}`, stages: {},
    implementation: { branch: 'feature/issue-7-feedback', commitSha: head, prUrl: 'https://github.com/local/probe/pull/7', comment: 'Feedback implementation' } };
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  orchestrator.repo = { owner: 'local', name: 'probe', defaultBranch: 'main', workdir };
  orchestrator.config = resolveFactoryConfig({ cwd: workdir, env: {} });
  orchestrator.store = { load: async () => state, save: async () => state };
  orchestrator.logger = { info() {}, warn() {}, error() {} };
  orchestrator.handleStageFailure = async (_state: unknown, _issue: unknown, _ctx: unknown, error: Error) => { throw error; };
  const roles: string[] = [];
  orchestrator.context = async (_issue: unknown, role: string, _runId: string, correction: unknown) => {
    roles.push(role);
    assert.notEqual(role, 'implementation');
    return { repo: orchestrator.repo, issue, logger: orchestrator.logger, correction, runId: `run-${roles.length}` };
  };
  orchestrator.withProviderSession = async (_state: unknown, _role: string, _ctx: unknown, run: () => Promise<unknown>) => run();
  let reviews = 0;
  t.mock.method(ReviewPrAgent.prototype, 'run', async function(this: any, previous: unknown) {
    reviews++;
    assert.equal(previous, undefined, 'Unsupported review evidence must be regenerated, not blindly rejudged');
    if (scenario === 'technical-spec') {
      const result = parseReviewResult(JSON.stringify({ verdict: 'REJECT', comments: [],
        body: '[IMPORTANT] specs/feedback/TECH.md:1 AC-1: The technical design assigns persistent identity to a remounting consumer.',
        references: [{ path: 'specs/feedback/TECH.md', line: 1, side: 'RIGHT' }, { path: 'Feedback.tsx', line: 1, side: 'RIGHT' }],
      }), 'run-review', [{ id: 'AC-1' }]);
      result.typesafeBatch = { b4: { id: 'B7', value: 'REJECT', confidence: 0.99 },
        b5: result.findings!.map(finding => ({ id: `B8-${finding.id}`, findingId: finding.id, value: 'important', confidence: 0.99 })), meanConfidence: 0.99 };
      result.mergeRoute = { mode: 'escalate' };
      result.generatedReview = { verdict: result.verdict, body: result.body, comments: [], findings: structuredClone(result.findings), origin: 'claude-code', specCommitSha: base };
      result.judgmentInputHash = reviewJudgmentInputHash(issue as any, result, { specs: specs as any, approved: true, headSha: head, baseSha: base });
      return result;
    }
    if (reviews > 1 && reviews <= 3) {
      assert.equal(this.ctx.correction.targetStage, 'review-pr');
      assert.match(this.ctx.correction.turns.join('\n'), /exact repository-relative paths/);
      assert.match(this.ctx.correction.turns.join('\n'), /missing.ts/);
      assert.match(this.ctx.correction.turns.join('\n'), /Do not modify product files/);
    }
    const result = { verdict: 'APPROVE', body: `Review attempt ${reviews}: AC-1: Feedback.tsx:1 renders the form.`, comments: [], findings: [],
      ...(reviews < 3 || !repairSucceeds ? { judgmentFailure: { kind: 'contract', code: 'REVIEW_EVIDENCE_INSUFFICIENT',
        reviewEvidence: { codeBytes: 0, changedFiles: 1, selectedFiles: 0, missingPaths: ['missing.ts'], ambiguousPaths: [], missingLines: [] } } }
        : { mergeRoute: { mode: 'auto' } }) } as any;
    result.generatedReview = { verdict: result.verdict, body: result.body, comments: [], findings: [], origin: 'claude-code', specCommitSha: base };
    result.judgmentInputHash = reviewJudgmentInputHash(issue as any, result, { specs: specs as any, approved: true, headSha: head, baseSha: base });
    return result;
  });
  let verifications = 0;
  t.mock.method(VerifyBehaviorAgent.prototype, 'run', async () => {
    verifications++;
    assert.equal(Boolean(state.implementation.behaviorVerification), verifications > 1,
      'Review context changes preserve same-candidate execution evidence for validated rejudgment');
    return { status: 'blocked', notes: 'Fixture service recovery',
      judgmentFailure: { kind: 'transient', code: 'JUDGMENT_SERVICE_UNAVAILABLE' }, checks: [] } as any;
  });
  if (scenario === 'technical-spec') {
    const boundary = new Error('Fixture observes normal specification revision boundary');
    orchestrator.runSpecPhase = async () => {
      assert.equal(state.nextLabel, 'ready-to-spec');
      assert.equal(state.specReview.verdict, 'REJECT');
      assert.equal(state.specReviewedKey, undefined, 'Previous approval cannot authorize the changed specification');
      assert.equal(state.specReview.findings[0].evidence.path, 'specs/feedback/TECH.md');
      assert.equal(state.specificationRepair.sourceSpecSha, base);
      assert.match(state.correction.turns.join('\n'), /Preserve PRODUCT.md and human constraints exactly/);
      assert.equal(state.implementation.commitSha, head, 'Retain the factory-produced implementation');
      assert.equal(await git('status', '--porcelain'), '', 'Controller must not patch product files');
      throw boundary;
    };
    await assert.rejects(orchestrator.runForIssue(issue), boundary);
    assert.equal(reviews, 1);
    assert.equal(verifications, 0);
    assert.deepEqual(roles, ['review-pr']);
    return;
  }
  await orchestrator.runForIssue(issue);
  assert.equal(reviews, 1);
  assert.equal(state.nextLabel, 'review-needed');
  assert.equal(state.wait.reason, 'judgment-retry');
  assert.equal(state.wait.attempts, 1);
  assert.match(state.wait.note, /自动补齐/);
  assert.match(state.wait.note, /无需你操作/);
  assert.doesNotMatch(state.wait.note, /AC|REVIEW_EVIDENCE|需要你的操作/);
  const saved = JSON.parse(JSON.stringify(state));
  Object.assign(state, saved);
  await orchestrator.runForIssue(issue);
  assert.equal(reviews, 1, 'Persisted cooldown must survive restart without another agent invocation');
  state.wait.nextAttemptAt = '2000-01-01T00:00:00Z';
  await orchestrator.runForIssue(issue);
  assert.equal(reviews, 2);
  assert.equal(state.wait.attempts, 2, 'Unchanged evidence failure retains backoff history');
  state.wait.nextAttemptAt = '2000-01-01T00:00:00Z';
  await orchestrator.runForIssue(issue);
  if (!repairSucceeds) {
    assert.equal(state.wait.reason, 'blocked-operator');
    assert.equal(state.wait.attempts, 3);
    assert.equal(state.nextLabel, 'review-needed');
    assert.equal(verifications, 0);
    const restored = JSON.parse(JSON.stringify(state));
    Object.assign(state, restored);
    await orchestrator.runForIssue(issue);
    assert.equal(reviews, 3, 'An unchanged blocked context must not launch a fourth review after restart');
    assert.equal(await git('status', '--porcelain'), '');
    return;
  }
  assert.deepEqual(roles, ['review-pr', 'review-pr', 'review-pr', 'verify-behavior']);
  assert.equal(state.wait.stage, 'verify');
  assert.equal(state.review.verdict, 'APPROVE');
  assert.equal(state.correction, undefined);
  state.review.judgmentInputHash = 'previous-review-contract';
  state.wait.nextAttemptAt = '2000-01-01T00:00:00Z';
  const oldVerification = state.implementation.behaviorVerification;
  await orchestrator.runForIssue(issue);
  assert.equal(reviews, 4, 'An old review contract requires fresh generation for the same unchanged commit');
  assert.equal(verifications, 2, 'Old verification must be rerun after the changed review contract');
  assert.notEqual(state.implementation.behaviorVerification, oldVerification);
  assert.equal(state.implementation.commitSha, head);
  assert.equal(await git('status', '--porcelain'), '');
});
}
