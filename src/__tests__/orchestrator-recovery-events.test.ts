import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';

for (const [action, message, code] of [
  ['retry', 'Connection reset', 'ETIMEDOUT'],
  ['reroute', 'JSON parse error', ''],
  ['needs-info', 'Blocked by policy', 'POLICY_BLOCK'],
  ['abort', 'Permanent failure', ''],
]) {
  test(`actual ${action} failure routing records only a plan, never successful healing`, async () => {
    const state: any = { issue: { number: 7, title: 'Behavior', body: 'Expected behavior', labels: [],
      comments: [], author: 'operator', state: 'open' }, merged: false, status: 'waiting',
      nextLabel: 'ready-to-implement', events: [],
      stages: { implementation: { status: 'failed', startedAt: '2026-10-06T00:00:00Z' } } };
    const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
    orchestrator.config = resolveFactoryConfig({ env: {} });
    orchestrator.logger = { info() {}, warn() {}, error() {} };
    let saves = 0, agentStarts = 0;
    orchestrator.store = { save: async () => { saves++; } };
    const run = () => orchestrator.handleStageFailure(state, state.issue,
      async () => { agentStarts++; throw new Error('Routing cannot execute or confirm recovery'); },
      Object.assign(new Error(message), { code }));
    if (action === 'abort') await assert.rejects(run(), /Permanent|permanent/);
    else await run();
    const events = state.events.filter((event: any) => event.reason?.startsWith('[router]'));
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'recovery-planned');
    assert.match(events[0].reason, new RegExp(`\\[router\\] ${action}`));
    assert.ok(saves > 0);
    assert.equal(agentStarts, 0);
    assert.equal(state.merged, false);
    assert.notEqual(state.status, 'completed');
  });
}
