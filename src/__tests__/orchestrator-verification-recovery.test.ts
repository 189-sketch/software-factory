import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { VerifyBehaviorAgent } from '../agents/verify-behavior.js';
import { acceptanceRequirementsHash, verificationChecksHash } from '../core/completion-contract.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';
import { VERIFICATION_CAPABILITY_HASH } from '../../runtime/verification-capabilities.mjs';
import { reviewJudgmentContextHash } from '../../runtime/review-judgment-context.mjs';

test('actual orchestrator repairs evidence beyond old budgets and preserves product/review during service recovery', { timeout: 20000 }, async () => {
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
    state.review.judgmentInputHash = reviewJudgmentContextHash(state);
    const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
    orchestrator.repo = { owner: 'local', name: 'probe', defaultBranch: 'main', workdir };
    orchestrator.config = { ...resolveFactoryConfig({ cwd: workdir, env: {} }), syncLabels: false, syncProjects: false };
    orchestrator.store = { load: async () => state, save: async () => {
      if (state.stages.verify?.status === 'completed') {
        assert.equal(state.implementation.behaviorVerification.failure.runId, `run-${roles.length}`,
          'The completed verifier result must be in the checkpoint before the stage wrapper saves');
      }
      return state;
    } };
    const transitions: string[] = [];
    orchestrator.logger = { info(message:string) {
      if(message.includes('workflow label=')) transitions.push(message.match(/workflow label=(\S+)/)![1]!);
    }, warn() {}, error() {} };
    orchestrator.emit = () => {};
    const roles: string[] = [];
    orchestrator.context = async (_issue: unknown, role: string, _runId: string, correction: unknown) => {
      roles.push(role);
      assert.equal(role, 'verify-behavior', 'Evidence rejection must never start an implementation or repeat approved review');
      if (roles.length > 1) assert.ok(correction, 'The recovery verifier must receive concrete feedback');
      if (roles.length === 2 || roles.length === 4) {
        assert.ok(correction, 'The recovery verifier must receive concrete feedback');
        const prefix = 'Verification recovery obligations (prior execution only):\n';
        const turn = (correction as { turns: string[] }).turns.find(turn => turn.startsWith(prefix));
        assert.ok(turn, 'The actual next verifier must receive structured obligations');
        const plan = JSON.parse(turn.slice(prefix.length));
        assert.equal(plan.boundToCurrentApproval, true);
        assert.deepEqual(plan.unregisteredRequirementIds, ['AC-1']);
        assert.equal(plan.sourceRunId, `run-${roles.length - 1}`);
      }
      return { repo: orchestrator.repo, issue, runId: `run-${roles.length}`, logger: orchestrator.logger };
    };
    orchestrator.withProviderSession = async (_state: unknown, _role: string, _ctx: unknown, run: () => Promise<unknown>) => run();
    VerifyBehaviorAgent.prototype.run = async () => ({ mode: 'verify', status: 'not-verified', channel: 'desktop',
      ozRunUrl: '', evidence: [], notes: 'Assertion does not demonstrate AC-1', checks: [],
      executionCapabilities: VERIFICATION_CAPABILITY_HASH,
      failure: { kind: 'evidence', runId: `run-${roles.length}`, requirementIds: [], receiptIds: [], reason: 'Wrong assertion scope' },
      coverage: { specCommitSha: sha, implementationSha: sha, requirementsHash: acceptanceRequirementsHash(specs as any),
        runId: `run-${roles.length}`, passingReceiptIds: [] },
      ...(roles.length >= 6 ? { judgmentFailure: { kind: 'transient', code: 'JUDGMENT_SERVICE_UNAVAILABLE' } } : {}),
    });
    assert.equal(await orchestrator.runForIssue(issue), state);
    assert.deepEqual(roles, Array(6).fill('verify-behavior'));
    assert.deepEqual(transitions.filter(label=>label==='ready-to-merge'),['ready-to-merge'],
      'Only the final service wait may queue the issue; immediate evidence retries stay verifying');
    assert.equal(state.verificationRecovery.attempts, 5, 'Evidence repair continues beyond the former two-attempt limit');
    assert.equal(state.verificationRecovery.capabilities, VERIFICATION_CAPABILITY_HASH);
    assert.equal(state.nextLabel, 'ready-to-merge');
    assert.equal(state.wait.reason, 'judgment-retry');
    assert.equal(state.wait.stage, 'verify');
    assert.equal(state.wait.attempts, 1);
    assert.equal(state.implementation.commitSha, sha);
    assert.equal(state.review.verdict, 'APPROVE');
    assert.deepEqual(state.failureCounts, { implementation: { AGENT_REASONING: 1 } });

    assert.equal(await git('status', '--porcelain'), '');
    const evidenceHistory = structuredClone(state.verificationRecovery);
    await orchestrator.runForIssue(issue);
    assert.equal(roles.length, 6, 'Service cooldown must return before another agent starts');
    state.wait.nextAttemptAt = '2000-01-01T00:00:00Z';
    await orchestrator.runForIssue(issue);
    assert.equal(roles.length, 7);
    assert.equal(state.wait.attempts, 2, 'Service recovery retains its durable counter');
    assert.deepEqual(state.verificationRecovery, evidenceHistory);
    assert.equal(state.implementation.commitSha, sha);
    assert.equal(state.review.verdict, 'APPROVE');
    assert.deepEqual(state.failureCounts, { implementation: { AGENT_REASONING: 1 } });

    // Fail the real stage-finalization save, then resume from the captured journal.
    state.wait.nextAttemptAt = '2000-01-01T00:00:00Z';
    VerifyBehaviorAgent.prototype.run = async () => {
      const checks = [{ passed: true, requirementIds: ['AC-1'], receiptIds: ['receipt-1'] }];
      const runId = `run-${roles.length}`;
      return { mode: 'verify', status: 'verified', channel: 'desktop', ozRunUrl: '', evidence: [], notes: '', checks,
        coverage: { specCommitSha: sha, implementationSha: sha, requirementsHash: acceptanceRequirementsHash(specs as any),
          runId, passingReceiptIds: ['receipt-1'] },
        judgment: { runId, checksHash: verificationChecksHash(checks as any), verdict: 'verified', confidence: 0.99,
          checks: [{ index: 0, probability: 0.99 }] },
      } as any;
    };
    const pendingFile = path.join(root, 'pending-save.json');
    let injected = false;
    orchestrator.store.save = async () => {
      if (!injected && state.stages.verify?.status === 'completed'
        && state.implementation.behaviorVerification.status === 'verified') {
        injected = true;
        await fs.writeFile(pendingFile, JSON.stringify(state));
        throw Object.assign(new Error('Lease connection failed while saving completed result'), { code: 'FACTORY_STATE_UNAVAILABLE' });
      }
      return state;
    };
    await assert.rejects(orchestrator.runForIssue(issue), { code: 'FACTORY_STATE_UNAVAILABLE' });
    assert.equal(roles.length, 8);
    Object.assign(state, JSON.parse(await fs.readFile(pendingFile, 'utf8')));
    orchestrator.store.save = async () => state;
    assert.equal(state.verifiedSha, sha, 'Completed result retains the exact validated code binding');
    await orchestrator.runForIssue(issue);
    assert.equal(roles.length, 8, 'A recovered, fully judged result must not rerun the verifier');
    assert.equal(state.nextLabel, 'verified');
    assert.equal(state.merged, false, 'Saving or recovering a result cannot authorize a merge');
    assert.equal(await git('status', '--porcelain'), '');
  } finally {
    VerifyBehaviorAgent.prototype.run = original;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-verification-route-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
