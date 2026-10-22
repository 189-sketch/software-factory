import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SpecAgent } from '../agents/spec.js';
import { runSpecPhaseBody, type SpecPhaseDependencies } from '../orchestrator/spec-phase.js';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';

for (const gate of ['review', 'typesafe', 'advisory', 'resume', 'review-resume', 'review-drift'] as const) {
test(`spec ${gate} repairs in the same pipeline beyond prior revision budgets`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'spec-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remotePath = path.join(root, 'remote.git');
  const workdir = path.join(root, 'work');
  await mkdir(workdir);
  const git = (args: string[]) => execFileSync('git', args, { cwd: workdir, stdio: 'pipe' });
  git(['init', '--bare', remotePath]);
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  await writeFile(path.join(workdir, 'README.md'), 'Baseline\n');
  git(['add', '.']); git(['commit', '-m', 'Baseline']);
  git(['remote', 'add', 'origin', remotePath]); git(['push', '-u', 'origin', 'main']);
  const issue: any = { number: 72, title: 'feedback', body: 'SQLite feedback', comments: [], labels: ['ready-to-spec'] };
  const state: any = { issue, events: [], stages: {}, merged: false };
  const repo = { owner: 'test', name: 'test', defaultBranch: 'main', workdir };
  const logger: any = { info() {}, warn() {}, error() {} };
  let generations = 0, reviews = 0;
  let mergeInterrupted = false;
  const revisions: any[] = [];
  t.mock.method(SpecAgent.prototype, 'run', async function(this: any) {
    generations++;
    revisions.push(this.revision);
    const slug = 'issue-72-feedback';
    const product = { slug, title: 'Feedback', problem: 'Need feedback', goals: [], nonGoals: [],
      stories: [], acceptanceCriteria: ['Save feedback'], openQuestions: [], body: '# Product\nSave feedback\n' };
    const tech = { slug, approach: 'SQLite', affectedAreas: [], dataModel: 'Feedback', apiChanges: [],
      migrationPlan: 'Add database', validationPlan: ['Save feedback'], alternatives: [], openQuestions: [],
      body: `# Tech\nRevision ${generations}\n` };
    const dir = path.join(workdir, 'specs', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'PRODUCT.md'), product.body);
    await writeFile(path.join(dir, 'TECH.md'), tech.body);
    return { product, tech, specBranch: `spec/${slug}`, specPrUrl: '',
      ...(gate === 'typesafe' && generations <= 5 ? { typesafeBatch: {
        b1: { value: 'PRODUCT+TECH', confidence: 1 },
        b2: [{ acId: 'AC-1', value: 0.2, confidence: 1 }], b3: [], meanConfidence: 1,
      } } : {}) };
  });
  const deps: SpecPhaseDependencies = { repo, remotePath, logger, config: resolveFactoryConfig({ env: {} }),
    store: { async save(current) { return current; } },
    async stage(_state, name, run) {
      if (name === 'merge-spec-pr') {
        if (gate === 'resume' && !mergeInterrupted) {
          mergeInterrupted = true;
          state.nextLabel = 'merging-spec';
          throw new Error('Fixture interrupted before spec merge');
        }
        return undefined as any;
      }
      if (name === 'review-spec') {
        reviews++;
        if ((gate === 'review-resume' || gate === 'review-drift') && reviews === 1) {
          state.agentRuntimeFailure = { stage: 'review-spec', code: 'FACTORY_AGENT_CONTEXT_PREPARATION_FAILED' };
          throw new Error('Fixture interrupted during spec review');
        }
        const rejected = gate === 'review' && reviews <= 5;
        return { verdict: rejected ? 'REJECT' : 'APPROVE', body: `Review ${reviews}`, comments: [], notes: '',
          ...(gate === 'advisory' && reviews === 1 ? { typesafeBatch: {
            b4: { id: 'B4', value: 'REJECT', confidence: 0.62 }, b5: [], meanConfidence: 0.62,
          } } : {}),
          findings: rejected ? [{ id: `F-${reviews}`, ruleId: 'technical-fact', severity: 'important',
            summary: 'Correct the API', evidence: { path: 'specs/issue-72-feedback/TECH.md' } }]
            : gate === 'advisory' ? [{ id: 'NIT-1', ruleId: 'test-name', severity: 'nit', summary: 'Rename AppNav unchanged', evidence: {} }] : [] } as any;
      }
      return run(`run-${name}-${generations}`);
    },
    async withProviderSession(_state, _role, _ctx, run) { return run(); },
    async prepareSpecReviewArtifacts() {},
    async transition(_state, label) { state.nextLabel = label; },
  };
  const run = () => runSpecPhaseBody(deps, state, issue, async () => ({ repo, issue, logger, runId: 'run', skills: [] } as any));
  if (gate === 'resume') await assert.rejects(run(), /Fixture interrupted/);
  if (gate === 'review-resume' || gate === 'review-drift') await assert.rejects(run(), /Fixture interrupted/);
  if (gate === 'review-drift') {
    git(['commit','--allow-empty','-m','External specification change']);
    git(['push','origin',state.specs.specBranch]);
    await assert.rejects(run(),{code:'FACTORY_STATE_SPEC_REVISION_CHANGED'});
    assert.equal(generations,1);
    assert.equal(reviews,1,'Changed remote input cannot reuse the old review snapshot');
    return;
  }
  await run();
  assert.equal(reviews, gate === 'review' ? 6 : gate === 'review-resume' ? 2 : 1);
  assert.equal(generations, gate === 'advisory' || gate === 'resume' || gate === 'review-resume' ? 1 : 6, 'Review or merge recovery must not rewrite published specifications');
  assert.equal(state.nextLabel, 'ready-to-implement');
  assert.equal(state.agentFailures, undefined);
  assert.equal(state.specs.revisions.length, gate === 'review' ? 6 : 1, 'Retain all published revision history');
  if (gate === 'review' || gate === 'typesafe') {
    assert.equal(revisions[1].fixedProduct.body, revisions[1].previousProductBody);
    assert.equal(revisions[5].specReviewFindings[0].id, gate === 'review' ? 'F-5' : 'TYPESAFE-1');
  } else if (gate === 'advisory') {
    assert.equal(state.specReview.reviewerVerdict, 'APPROVE');
    assert.equal(state.specReview.verdict, 'APPROVE');
    assert.match(state.specReview.notes, /B4.*no.*blocking/i);
  }
  if (gate === 'typesafe') assert.equal(state.specTypesafeRevisions, 5);
});
}

test('agent failures remain repairable beyond old class and global limits', async () => {
  const state: any = { issue: { number: 72, title: 'feedback', body: 'SQLite', labels: [], comments: [] },
    status: 'waiting', nextLabel: 'ready-to-spec', agentFailures: 500,
    failureCounts: { spec: { AGENT_REASONING: 500 } }, events: [],
    stages: { spec: { status: 'failed', startedAt: '2026-10-07T00:00:00Z' } } };
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  orchestrator.config = resolveFactoryConfig({ env: {} });
  orchestrator.logger = { info() {}, warn() {}, error() {} };
  orchestrator.store = { async save() {} };
  await orchestrator.handleStageFailure(state, state.issue, async () => { throw new Error('No supervisor needed'); },
    new Error('Repair the inconsistent spec'));
  assert.equal(state.nextLabel, 'ready-to-spec');
  assert.equal(state.status, 'waiting');
  assert.equal(state.agentFailures, 501);
  assert.match(state.correction.turns[0], /Repair the inconsistent spec/);
});
