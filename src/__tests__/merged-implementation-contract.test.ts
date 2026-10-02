import test from 'node:test';
import assert from 'node:assert/strict';
import { canConfirmMergedImplementation } from '../orchestrator/contracts.js';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { acceptanceRequirementsHash } from '../core/completion-contract.js';
import { setGitHubFetchImplForTest, closeSharedAgent } from '../../runtime/github-rest.mjs';

const sha = 'verified-head';
function proof(): any {
  const specs = { commitSha: 'spec-head', product: { acceptanceCriteria: ['Works', 'Recovers'] } } as any;
  return { merged: false, issue: { number: 53, labels: [] },
    specs,
    implementation: { commitSha: sha, prUrl: 'https://github.com/acme/repo/pull/56', behaviorVerification: { status: 'verified',
      checks: [{ criterion: 'Works and recovers', requirementIds: ['AC-1', 'AC-2'], passed: true, receiptIds: ['receipt-1'] }],
      coverage: { specCommitSha: specs.commitSha, implementationSha: sha, requirementsHash: acceptanceRequirementsHash(specs), runId: 'run-1', passingReceiptIds: ['receipt-1'] } } },
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

test('completion rejects partial coverage, invented receipts and stale specification proof', () => {
  for (const mutate of [
    (s: any) => { delete s.implementation.behaviorVerification.coverage; },
    (s: any) => { s.implementation.behaviorVerification.checks[0].requirementIds = ['AC-1']; },
    (s: any) => { s.implementation.behaviorVerification.checks[0].receiptIds = ['invented']; },
    (s: any) => { s.specs.product.acceptanceCriteria.push('Another requirement'); },
    (s: any) => { s.specs.commitSha = 'new-spec'; },
  ]) {
    const state = proof();
    mutate(state);
    assert.equal(canConfirmMergedImplementation(state, pr, 'main'), false);
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

test('completion observes issue closure and reconciles a lost PATCH response without another write', async () => {
  for (const loseResponse of [false, true]) {
    const state = proof();
    state.status = 'waiting';
    let closed = false;
    let patches = 0;
    setGitHubFetchImplForTest((async (url: any, options: any) => {
      if (String(url).endsWith('/pulls/56')) return new Response(JSON.stringify(pr));
      assert.ok(String(url).endsWith('/issues/53'));
      if (options.method === 'PATCH') {
        patches++;
        assert.notEqual(state.status, 'completed');
        closed = true;
        if (loseResponse) throw new Error('ECONNRESET after remote commit');
      }
      return new Response(JSON.stringify({ number: 53, state: closed ? 'closed' : 'open', labels: [] }));
    }) as typeof fetch);
    const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
    orchestrator.config = { github: { token: 'test', repository: 'acme/repo' } };
    orchestrator.repo = { defaultBranch: 'main' };
    orchestrator.store = { save: async () => undefined };
    orchestrator.syncProject = async () => undefined;
    orchestrator.waitForOperator = async () => { throw new Error('Unexpected operator intervention'); };
    try {
      assert.equal(await orchestrator.confirmMergedImplementation(state), true);
      assert.equal(state.status, 'completed');
      assert.equal(state.issue.state, 'closed');
      assert.equal(patches, 1);
      assert.equal(state.externalOps[0].status, 'succeeded');
      assert.equal(await orchestrator.confirmMergedImplementation(state), true);
      assert.equal(patches, 1);
    } finally { setGitHubFetchImplForTest(null); await closeSharedAgent(); }
  }
});
