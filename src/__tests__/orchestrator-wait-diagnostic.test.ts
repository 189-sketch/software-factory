import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { businessInputHash } from '../../runtime/business-input.mjs';

test('legacy operator wait gains concrete diagnostics once without running an agent or resetting budgets', async () => {
  const issue = { number: 48, title: 'Login', body: 'Mock accounts', author: 'operator', state: 'open',
    labels: ['needs-info'], createdAt: '', comments: [] };
  const state = { issue, status: 'waiting', nextLabel: 'needs-info', merged: false,
    lastFailure: { stage: 'review-spec', message: 'AppNav test fixtures need AuthProvider' },
    failureCounts: { 'review-spec': { AGENT_REASONING: 2 } },
    wait: { reason: 'blocked-operator', note: 'Budget exhausted', since: 'original' },
    lastJudgmentHash: businessInputHash(issue),
  };
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  orchestrator.config = { syncLabels: false, syncProjects: false };
  orchestrator.store = { load: async () => state, save: async () => state };
  orchestrator.context = async () => { throw new Error('Must not start an agent'); };
  let published = 0;
  orchestrator.waitForOperator = async (current: any, label: string, note: string) => {
    published++;
    assert.equal(label, 'needs-info');
    assert.match(note, /AppNav test fixtures need AuthProvider/);
    current.wait.note = note;
  };
  assert.equal(await orchestrator.runForIssue(issue), state);
  assert.equal(await orchestrator.runForIssue(issue), state);
  assert.equal(published, 1);
  assert.deepEqual(state.failureCounts, { 'review-spec': { AGENT_REASONING: 2 } });
  assert.equal(state.status, 'waiting');
});
