import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { IssueStore } from '../core/state.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';
import { setGitHubFetchImplForTest, closeSharedAgent } from '../../runtime/github-rest.mjs';
import { ReviewPrAgent } from '../agents/review-pr.js';
import { VerifyBehaviorAgent } from '../agents/verify-behavior.js';

test('GitHub labels track every executing stage before agent work and recover to the pending stage after failure', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let remoteLabels = ['ready-to-spec', 'customer-label'];
  setGitHubFetchImplForTest(async (input, init) => {
    if (String(input).includes('/comments')) return new Response(JSON.stringify(init?.method === 'POST' ? { id: 1 } : []));
    if (init?.method === 'PUT') remoteLabels = JSON.parse(String(init.body)).labels;
    return new Response(JSON.stringify({ labels: remoteLabels.map(name => ({ name })) }), { status: 200 });
  });
  t.after(() => { setGitHubFetchImplForTest(null); closeSharedAgent(); });
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  const config = resolveFactoryConfig({ env: {} });
  orchestrator.config = { ...config, syncProjects: false, syncLabels: true,
    github: { ...config.github, repository: 'fixture/lifecycle', token: 'fixture-token' } };
  orchestrator.repo = { owner: 'fixture', name: 'lifecycle', defaultBranch: 'main', workdir: root };
  orchestrator.store = new IssueStore(root);
  orchestrator.logger = { info() {}, warn() {}, error() {} };
  orchestrator.emit = () => {};
  const state: any = { issue: { number: 72, title: 'Feedback', body: 'SQLite', labels: [...remoteLabels], comments: [] },
    status: 'waiting', nextLabel: 'ready-to-spec', merged: false };
  for (const [stage, label] of [
    ['triage', 'triaging'], ['spec', 'writing-spec'], ['review-spec', 'reviewing-spec'],
    ['merge-spec-pr', 'merging-spec'], ['implementation', 'implementing'],
    ['review', 'reviewing'], ['verify', 'verifying'], ['merge', 'merging'],
  ]) {
    await orchestrator.stage(state, stage, async () => {
      assert.deepEqual(remoteLabels.sort(), ['customer-label', label].sort(), `Remote label before ${stage} work`);
      const saved = await orchestrator.store.load(72);
      assert.equal(saved.nextLabel, label);
      assert.equal(saved.stages[stage].status, 'running');
      assert.equal(saved.status, 'waiting', 'Task lifecycle stays independent of stage execution');
    });
    assert.equal(state.stages[stage].status, 'completed');
  }
  await assert.rejects(orchestrator.stage(state, 'implementation', async () => {
    assert.ok(remoteLabels.includes('implementing'));
    throw Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
  }), /Request timed out/);
  await orchestrator.handleStageFailure(state, state.issue, async () => { throw new Error('No supervisor needed'); },
    Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
  assert.deepEqual(remoteLabels.sort(), ['customer-label', 'ready-to-implement'].sort());
  assert.equal(state.nextLabel, 'ready-to-implement');
  await orchestrator.handleStageFailure(state, state.issue, async () => { throw new Error('No supervisor needed'); },
    Object.assign(new Error('Implementation validation failed: node test/run-tests.js; command timed out after 120000ms; stdout: generated project build passed'), { code: 'FACTORY_COMMAND_TIMEOUT' }));
  assert.equal(state.nextLabel, 'ready-to-implement', 'A validation timeout cannot request missing product requirements');
  assert.equal(state.wait.reason, 'runtime-retry');
  assert.match(state.correction.turns.join('\n'), /generated project build passed/);
  await orchestrator.stage(state, 'implementation', async () => {
    assert.ok(remoteLabels.includes('implementing'), 'Retry re-enters the actual executing state');
  });
  await orchestrator.recordWorkerInterruption(state.issue, 'FACTORY_WORKER_EXIT');
  const postAgentInterruption = await orchestrator.store.load(72);
  assert.equal(postAgentInterruption.nextLabel, 'ready-to-implement', 'Worker exit between agent completion and pipeline transition cannot leave a running label');
  assert.equal(postAgentInterruption.stages.implementation.status, 'interrupted');
  Object.assign(state, postAgentInterruption);
  state.stages.implementation.status = 'running';
  delete state.stages.implementation.endedAt;
  await orchestrator.store.save(state);
  await orchestrator.recordWorkerInterruption(state.issue, 'FACTORY_WORKER_EXIT');
  const interrupted = await orchestrator.store.load(72);
  assert.equal(interrupted.stages.implementation.status, 'interrupted');
  assert.ok(interrupted.stages.implementation.endedAt);
  assert.equal(interrupted.wait.reason, 'runtime-retry');
  assert.equal(interrupted.nextLabel, 'ready-to-implement');
  assert.ok(remoteLabels.includes('ready-to-implement'));
  assert.equal(interrupted.merged, false);
  assert.deepEqual(interrupted.failureCounts, state.failureCounts, 'Worker interruption cannot reset product failure counters');
  await orchestrator.recordWorkerInterruption(interrupted.issue, 'FACTORY_WORKER_EXIT');
  assert.equal((await orchestrator.store.load(72)).revision, interrupted.revision, 'Interruption settlement is idempotent');
  orchestrator.context = async () => ({});
  orchestrator.withProviderSession = async (_state: unknown, _stage: string, _ctx: unknown, run: () => Promise<unknown>) => run();
  orchestrator.reviewDirFor = () => root;
  await writeFile(path.join(root, 'pr_diff.txt'), '+[NEW:1] feedback');
  t.mock.method(VerifyBehaviorAgent.prototype, 'run', async () => {
    assert.ok(remoteLabels.includes('verifying'));
    return { status: 'confirmed', notes: 'Fixture reproduction', checks: [] };
  });
  const reviewMock = t.mock.method(ReviewPrAgent.prototype, 'run', async () => {
    assert.ok(remoteLabels.includes('reviewing'));
    return { verdict: 'APPROVE', body: 'Fixture review', comments: [] };
  });
  await orchestrator.runVerifyBehavior(interrupted.issue, 'reproduce');
  await orchestrator.runReviewPr(interrupted.issue);
  reviewMock.mock.mockImplementation(async () => { throw new Error('Standalone request failed'); });
  await assert.rejects(orchestrator.runReviewPr(interrupted.issue), /Standalone request failed/);
  const standalone = await orchestrator.store.load(72);
  assert.equal(standalone.nextLabel, 'ready-to-implement', 'Standalone commands restore the existing pipeline queue');
  assert.deepEqual(standalone.wait, interrupted.wait);
  assert.equal(standalone.stages['review-pr'].status, 'failed');
  assert.ok(remoteLabels.includes('ready-to-implement'));
});
