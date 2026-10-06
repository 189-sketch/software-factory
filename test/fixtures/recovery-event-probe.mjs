// Read-only trusted state replay with an explicitly injected policy fault.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { FactoryOrchestrator } from '../../src/orchestrator/index.ts';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { closeSharedAgent, setGitHubFetchImplForTest } from '../../runtime/github-rest.mjs';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';

const [repository, numberText, stateDir] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && stateDir && Number.isSafeInteger(number) && number > 0);
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
try {
  const original = await new GitHubStateStore({ repository, token, stateDir }).load(number);
  assert.ok(original?.implementation && original?.review && original?.stages);
  const untouched = structuredClone(original);
  const state = structuredClone(original);
  const offset = state.events?.length ?? 0;
  let diagnosticSaves = 0, workerStarts = 0;
  const orchestrator = Object.create(FactoryOrchestrator.prototype);
  orchestrator.config = resolveFactoryConfig({ env: {} });
  orchestrator.logger = { info() {}, warn() {}, error() {} };
  orchestrator.store = { save: async value => { assert.equal(value, state); diagnosticSaves++; } };
  setGitHubFetchImplForTest(() => { throw new Error('Fault replay must never access GitHub'); });
  await orchestrator.handleStageFailure(state, state.issue,
    async () => { workerStarts++; throw new Error('No execution may be claimed'); },
    Object.assign(new Error('Injected diagnostic fault, blocked by policy'), { code: 'POLICY_BLOCK' }));
  const event = state.events.slice(offset).find(event => event.reason?.startsWith('[router]'));
  console.log(JSON.stringify({ revision: original.revision, injectedFault: 'POLICY_BLOCK',
    routeEventStatus: event?.status, diagnosticStatus: state.status, diagnosticLabel: state.nextLabel,
    diagnosticSaves, workerStarts, remoteWrites: 0, productAcceptance: 'not-claimed' }));
  assert.equal(state.nextLabel, 'needs-info');
  assert.equal(workerStarts, 0);
  assert.equal(event?.status, 'recovery-planned', 'A failure routed to waiting must not claim self-healing');
  assert.deepEqual(original, untouched);
} finally {
  setGitHubFetchImplForTest(null);
  closeSharedAgent();
}
