import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';
import { workerFailure } from '../../runtime/worker-failure.mjs';

test('agent execution faults bypass business retry counters and needs-info routing', async () => {
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  const state: any = { issue: { number: 77 }, status: 'running', nextLabel: 'spec-in-review', agentFailures: 0 };
  const before = structuredClone(state);
  for (const code of ['FACTORY_AGENT_CAPABILITY_UNAVAILABLE', 'FACTORY_AGENT_EXECUTION_FAILED']) {
    const error = Object.assign(new Error('Tools unavailable'), { code });
    await assert.rejects(orchestrator.handleStageFailure(state, state.issue, () => {
      throw new Error('Must not ask the business supervisor');
    }, error), error);
    assert.deepEqual(state, before);
    assert.equal(workerFailure(error).owner, 'worker-runtime');
    assert.equal(workerFailure(error).code, code);
  }
});

test('independent dependency validation failures preserve evidence and retry after backoff without needs-info', async () => {
  const state: any = { issue: { number: 77, state: 'open' }, status: 'running', nextLabel: 'implementing',
    events: [], stages: { implementation: { status: 'failed', startedAt: new Date().toISOString() } },
    failureCounts: { implementation: { ENVIRONMENT: 1 } },
    validationFailure: { command: 'npm ci', exitCode: 1, stdout: '', stderr: 'EPERM unlink esbuild.exe' } };
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  orchestrator.config = resolveFactoryConfig({ env: {} });
  orchestrator.logger = { info() {}, warn() {}, error() {} };
  let saves = 0;
  orchestrator.store = { save: async () => { saves++; } };
  orchestrator.publishWorkflowLabel = async (_state: any, label: string) => assert.notEqual(label, 'needs-info');
  await orchestrator.handleStageFailure(state, state.issue, () => { throw new Error('No supervisor required'); },
    Object.assign(new Error('Implementation validation failed: npm ci\nstderr:\nEPERM unlink esbuild.exe'), { code: 'FACTORY_VALIDATION_FAILED' }));
  assert.equal(state.lastFailure.class, 'VALIDATION_FAILED');
  assert.equal(state.lastFailure.stage, 'implementation');
  assert.equal(state.wait.reason, 'runtime-retry');
  assert.ok(Date.parse(state.wait.nextAttemptAt) > Date.now());
  assert.equal(state.nextLabel, 'ready-to-implement');
  assert.equal(state.correction.targetStage, 'implementation');
  assert.match(state.correction.turns.join('\n'), /file locks/);
  assert.match(state.validationFailure.stderr, /EPERM/);
  assert.equal(state.failureCounts.implementation.ENVIRONMENT, 1);
  assert.equal(state.failureCounts.implementation.VALIDATION_FAILED, 1);
  assert.ok(saves > 0);
});

for (const [action, message, code] of [
  ['retry', 'Connection reset', 'ETIMEDOUT'],
  ['reroute', 'JSON parse error', ''],
  ['needs-info', 'Blocked by policy', 'POLICY_BLOCK'],
  ['abort', 'Cannot start executor', 'ENOENT'],
]) {
  test(`actual ${action} failure routing records only a plan, never successful healing`, async () => {
    const state: any = { issue: { number: 7, title: 'Behavior', body: 'Expected behavior', labels: [],
      comments: [], author: 'operator', state: 'open' }, merged: false, status: 'waiting',
      nextLabel: 'ready-to-implement', events: [],
      stages: { implementation: { status: 'failed', startedAt: '2026-10-06T00:00:00Z' } } };
    if (action === 'abort') state.failureCounts = { implementation: { EXECUTOR_CRASH: 1 } };
    const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
    orchestrator.config = resolveFactoryConfig({ env: {} });
    orchestrator.logger = { info() {}, warn() {}, error() {} };
    let saves = 0, agentStarts = 0;
    orchestrator.store = { save: async () => { saves++; } };
    const run = () => orchestrator.handleStageFailure(state, state.issue,
      async () => { agentStarts++; throw new Error('Routing cannot execute or confirm recovery'); },
      Object.assign(new Error(message), { code }));
    await run();
    const events = state.events.filter((event: any) => event.reason?.startsWith('[router]'));
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'recovery-planned');
    assert.match(events[0].reason, new RegExp(`\\[router\\] ${action}`));
    assert.ok(saves > 0);
    assert.equal(agentStarts, 0);
    assert.equal(state.merged, false);
    assert.notEqual(state.status, 'completed');
    if (action === 'abort') {
      assert.equal(state.status,'failed');
      assert.equal(state.wait.reason,'blocked-operator','A handled business stop must not also emit an uncaught worker failure');
    }
  });
}
