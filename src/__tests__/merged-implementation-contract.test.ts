import test from 'node:test';
import assert from 'node:assert/strict';
import { canConfirmMergedImplementation } from '../orchestrator/contracts.js';
import { FactoryOrchestrator } from '../orchestrator/index.js';

const sha = 'verified-head';
function proof(): any {
  return { merged: false, issue: { number: 53, labels: [] },
    implementation: { commitSha: sha, prUrl: 'https://github.com/acme/repo/pull/56', behaviorVerification: { status: 'verified' } },
    review: { verdict: 'APPROVE' }, reviewedSha: sha, verifiedSha: sha };
}
const pr = { number: 56, merged: true, html_url: 'https://github.com/acme/repo/pull/56', head: { sha }, base: { ref: 'main' } };

test('merge completion requires the exact reviewed and verified remote head and base', () => {
  assert.equal(canConfirmMergedImplementation(proof(), pr, 'main'), true);
  for (const altered of [ { ...pr, merged: false }, { ...pr, html_url: 'other' },
    { ...pr, head: { sha: 'changed' } }, { ...pr, base: { ref: 'other' } } ]) {
    assert.equal(canConfirmMergedImplementation(proof(), altered, 'main'), false);
  }
  for (const altered of [ { ...proof(), reviewedSha: 'old' }, { ...proof(), verifiedSha: 'old' },
    { ...proof(), review: { verdict: 'REJECT' } },
    { ...proof(), implementation: { ...proof().implementation, behaviorVerification: { status: 'blocked' } } } ]) {
    assert.equal(canConfirmMergedImplementation(altered, pr, 'main'), false);
  }
});

test('remote completion is checked before needs-info budget reset or empty-diff review', async () => {
  const state = { ...proof(), status: 'waiting', nextLabel: 'needs-info',
    lastFailure: { message: 'Review diff is empty' }, failureCounts: { verify: { AGENT_REASONING: 2 } } };
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  let confirmations = 0;
  orchestrator.confirmMergedImplementation = async (current: any) => {
    confirmations++;
    assert.equal(current, state);
    assert.deepEqual(current.failureCounts, { verify: { AGENT_REASONING: 2 } });
    current.merged = true;
    current.status = 'completed';
    return true;
  };
  orchestrator.store = { load: async () => state };
  assert.equal(await orchestrator.runForIssue(state.issue), state);
  assert.equal(confirmations, 1);
  assert.equal(state.status, 'completed');
});
