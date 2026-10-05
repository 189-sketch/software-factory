import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { VerifyBehaviorAgent } from '../agents/verify-behavior.js';
import { acceptanceRequirementsHash } from '../core/completion-contract.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';

test('actual orchestrator retries evidence only, parks boundedly and preserves product/review on replay', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-verification-route-'));
  const exec = promisify(execFile);
  const workdir = path.join(root, 'project');
  const origin = path.join(root, 'origin.git');
  const original = VerifyBehaviorAgent.prototype.run;
  try {
    await fs.mkdir(workdir);
    const git = async (...args: string[]) => (await exec('git', args, { cwd: workdir })).stdout.trim();
    await exec('git', ['init', '--bare', origin]);
    await git('init', '-b', 'main');
    await fs.mkdir(path.join(workdir, 'specs', 'behavior'), { recursive: true });
    await fs.writeFile(path.join(workdir, 'specs', 'behavior', 'PRODUCT.md'), 'Approved behavior');
    await fs.writeFile(path.join(workdir, 'specs', 'behavior', 'TECH.md'), 'Approved approach');
    await git('add', '.');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Fixture baseline');
    const sha = await git('rev-parse', 'HEAD');
    await git('remote', 'add', 'origin', origin);
    await git('push', 'origin', 'main');
    await git('checkout', '-b', 'feature/issue-7');
    await git('push', 'origin', 'feature/issue-7');
    const issue = { number: 7, title: 'CLI behavior', body: 'Verify expected output', author: 'operator',
      labels: ['verify-failed'], comments: [], state: 'open', createdAt: '' };
    const specs = { commitSha: sha, specBranch: 'spec/issue-7',
      product: { slug: 'behavior', acceptanceCriteria: ['Expected output'] }, tech: { slug: 'behavior' } };
    const state: any = { issue, merged: false, status: 'waiting', nextLabel: 'verify-failed', specs,
      specReview: { verdict: 'APPROVE' }, specReviewedKey: `spec/issue-7@${sha}`, review: { verdict: 'APPROVE', mergeRoute: { mode: 'auto' } },
      reviewedSha: sha, reviewedBaseSha: sha, stages: {}, failureCounts: { implementation: { AGENT_REASONING: 1 } },
      implementation: { branch: 'feature/issue-7', commitSha: sha, prUrl: 'https://github.com/local/probe/pull/7',
        behaviorVerification: { status: 'not-verified', notes: 'Legacy unsupported claim', checks: [] } } };
    const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
    orchestrator.repo = { owner: 'local', name: 'probe', defaultBranch: 'main', workdir };
    orchestrator.config = resolveFactoryConfig({ cwd: workdir, env: {} });
    orchestrator.store = { load: async () => state, save: async () => state };
    orchestrator.logger = { info() {}, warn() {}, error() {} };
    const roles: string[] = [];
    orchestrator.context = async (_issue: unknown, role: string, _runId: string, correction: unknown) => {
      roles.push(role);
      assert.equal(role, 'verify-behavior', 'Evidence rejection must never start an implementation or repeat approved review');
      if (roles.length > 1) assert.ok(correction, 'The recovery verifier must receive concrete feedback');
      return { repo: orchestrator.repo, issue, runId: `run-${roles.length}`, logger: orchestrator.logger };
    };
    orchestrator.stage = async (_state: unknown, name: string, run: () => Promise<unknown>) => {
      state.stages[name] = { status: 'running' };
      return run();
    };
    orchestrator.withProviderSession = async (_state: unknown, _role: string, _ctx: unknown, run: () => Promise<unknown>) => run();
    VerifyBehaviorAgent.prototype.run = async () => ({ mode: 'verify', status: 'not-verified', channel: 'desktop',
      ozRunUrl: '', evidence: [], notes: 'Assertion does not demonstrate AC-1', checks: [],
      failure: { kind: 'evidence', runId: `run-${roles.length}`, requirementIds: [], receiptIds: [], reason: 'Wrong assertion scope' },
      coverage: { specCommitSha: sha, implementationSha: sha, requirementsHash: acceptanceRequirementsHash(specs as any),
        runId: `run-${roles.length}`, passingReceiptIds: [] } });
    assert.equal(await orchestrator.runForIssue(issue), state);
    assert.deepEqual(roles, ['verify-behavior', 'verify-behavior']);
    assert.equal(state.verificationRecovery.attempts, 2);
    assert.equal(state.nextLabel, 'verify-failed');
    assert.equal(state.wait.reason, 'blocked-operator');
    assert.match(state.wait.note, /需要你的操作/);
    assert.match(state.wait.note, /Wrong assertion scope/);
    assert.equal(state.implementation.commitSha, sha);
    assert.equal(state.review.verdict, 'APPROVE');
    assert.deepEqual(state.failureCounts, { implementation: { AGENT_REASONING: 1 } });
    assert.equal(await git('status', '--porcelain'), '');
    await orchestrator.runForIssue(issue);
    assert.equal(roles.length, 2, 'An unchanged parked replay must not rerun agents');
    // A service outage has its own durable clock; it cannot consume AC/product budgets.
    const evidenceBudget = structuredClone(state.verificationRecovery);
    const run = VerifyBehaviorAgent.prototype.run;
    VerifyBehaviorAgent.prototype.run = async function () {
      return { ...await run.call(this), status: 'blocked',
        judgmentFailure: { kind: 'transient', code: 'JUDGMENT_SERVICE_UNAVAILABLE' } };
    };
    delete state.wait;
    state.nextLabel = 'ready-to-merge';
    await orchestrator.runForIssue(issue);
    assert.equal(roles.length, 3);
    assert.equal(state.wait.reason, 'judgment-retry');
    assert.equal(state.wait.stage, 'verify');
    assert.equal(state.wait.attempts, 1);
    assert.deepEqual(state.verificationRecovery, evidenceBudget);
    await orchestrator.runForIssue(issue);
    assert.equal(roles.length, 3, 'Cooldown must return before another agent starts');
    state.wait.nextAttemptAt = '2000-01-01T00:00:00Z';
    await orchestrator.runForIssue(issue);
    assert.equal(roles.length, 4);
    assert.equal(state.wait.attempts, 2, 'Due retries do not reset the persistent counter');
    assert.deepEqual(state.verificationRecovery, evidenceBudget);
    assert.deepEqual(state.failureCounts, { implementation: { AGENT_REASONING: 1 } });
  } finally {
    VerifyBehaviorAgent.prototype.run = original;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-verification-route-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
