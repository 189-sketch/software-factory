import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryOrchestrator } from '../orchestrator/index.js';

test('execution labels cannot bypass the specification acceptance baseline', async () => {
  for (const label of ['ready-to-implement', 'review-needed', 'ready-to-merge', 'verified']) {
    const issue = { number: 48, title: 'Login', body: 'Mock login and registration', labels: [label], comments: [] };
    const state: any = { issue, merged: false, nextLabel: label };
    const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
    orchestrator.config = { syncLabels: false, syncProjects: false };
    orchestrator.store = { save: async () => state };
    orchestrator.logger = { info() {}, warn() {} };
    orchestrator.context = async () => { throw new Error('Must establish baseline before execution'); };
    const transitions: string[] = [];
    orchestrator.transition = async (current: any, next: string) => {
      transitions.push(next);
      current.nextLabel = next;
    };
    let specs = 0;
    orchestrator.runSpecPhase = async (current: any) => {
      specs++;
      assert.equal(current.nextLabel, 'ready-to-spec');
      current.nextLabel = 'wait-to-implement';
      current.wait = { note: 'Specification handoff observed' };
    };
    assert.equal(await orchestrator.runForIssueState(issue, state), state);
    assert.deepEqual(transitions, ['ready-to-spec']);
    assert.equal(specs, 1);
  }
});
