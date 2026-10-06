import test from 'node:test';
import assert from 'node:assert/strict';
import { canConfirmMergedImplementation } from '../orchestrator/contracts.js';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { acceptanceRequirementsHash, verificationChecksHash } from '../core/completion-contract.js';
import { setGitHubFetchImplForTest, closeSharedAgent } from '../../runtime/github-rest.mjs';

const sha = 'verified-head';
function proof(): any {
  const specs = { specBranch: 'spec/issue-53', commitSha: 'spec-head', product: { acceptanceCriteria: ['Works', 'Recovers'] } } as any;
  const checks = [{ criterion: 'Works and recovers', requirementIds: ['AC-1', 'AC-2'], passed: true, receiptIds: ['receipt-1'] }];
  return { merged: false, issue: { number: 53, labels: [] },
    specs,
    specReview: { verdict: 'APPROVE' }, specReviewedKey: 'spec/issue-53@spec-head',
    implementation: { commitSha: sha, prUrl: 'https://github.com/acme/repo/pull/56', behaviorVerification: { status: 'verified',
      checks, judgment: { runId: 'run-1', checksHash: verificationChecksHash(checks), verdict: 'verified', confidence: 0.93,
        checks: [{ index: 0, probability: 0.9 }] },
      coverage: { specCommitSha: specs.commitSha, implementationSha: sha, requirementsHash: acceptanceRequirementsHash(specs), runId: 'run-1', passingReceiptIds: ['receipt-1'] } } },
    review: { verdict: 'APPROVE' }, reviewedSha: sha, verifiedSha: sha, reviewedBaseSha: 'reviewed-base',
    mergeCandidate: { headSha: sha, baseSha: 'reviewed-base', treeSha: 'verified-tree' } };
}
const pr = { number: 56, merged: true, merge_commit_sha: 'actual-merge', html_url: 'https://github.com/acme/repo/pull/56', head: { sha }, base: { ref: 'main' } };
const commit = { sha: 'actual-merge', tree: { sha: 'verified-tree' }, parents: [{ sha: 'reviewed-base' }, { sha }] };

test('merge completion requires the exact reviewed and verified remote head and base', () => {
  assert.equal(canConfirmMergedImplementation(proof(), pr, 'main', commit), true);
  for (const altered of [ { ...pr, merged: false }, { ...pr, html_url: 'other' },
    { ...pr, head: { sha: 'changed' } }, { ...pr, base: { ref: 'other' } } ]) {
    assert.equal(canConfirmMergedImplementation(proof(), altered, 'main', commit), false);
  }
  for (const altered of [ { ...proof(), reviewedSha: 'old' }, { ...proof(), verifiedSha: 'old' },
    { ...proof(), review: { verdict: 'REJECT' } },
    { ...proof(), implementation: { ...proof().implementation, behaviorVerification: { status: 'blocked' } } } ]) {
    assert.equal(canConfirmMergedImplementation(altered, pr, 'main', commit), false);
  }
});

test('completion binds actual merge commit parents and tree, not a mutable post-merge base snapshot', () => {
  assert.equal(canConfirmMergedImplementation(proof(), { ...pr, base: { ref: 'main', sha: 'later-tip' } }, 'main', commit), true);
  assert.equal(canConfirmMergedImplementation(proof(), pr, 'main'), false);
  assert.equal(canConfirmMergedImplementation({ ...proof(), mergeCandidate: undefined }, pr, 'main', commit), false);
  const legacy = { ...proof(), mergeCandidate: undefined };
  const head = { sha, tree: { sha: 'verified-tree' } };
  assert.equal(canConfirmMergedImplementation(legacy, pr, 'main', commit, head), true);
  assert.equal(canConfirmMergedImplementation(legacy, { ...pr, merged: false }, 'main', commit, head), false);
  assert.equal(canConfirmMergedImplementation(legacy, pr, 'main', commit, { ...head, sha: 'other' }), false);
  assert.equal(canConfirmMergedImplementation(legacy, pr, 'main', commit, { ...head, tree: { sha: 'other' } }), false);
  for (const changed of [
    { ...commit, sha: 'different' }, { ...commit, tree: { sha: 'different-tree' } },
    { ...commit, parents: [{ sha: 'advanced-base' }, { sha }] },
    { ...commit, parents: [{ sha }, { sha: 'reviewed-base' }] },
    { ...commit, parents: [{ sha: 'reviewed-base' }] },
  ]) assert.equal(canConfirmMergedImplementation(proof(), pr, 'main', changed), false);
});

test('already merged candidate mismatch is surfaced without closing issue or rerunning product work', async () => {
  const state = proof();
  let issueRequests = 0, notices = 0;
  setGitHubFetchImplForTest((async (url: any) => {
    if (String(url).endsWith('/pulls/56')) return new Response(JSON.stringify(pr));
    if (String(url).endsWith('/git/commits/actual-merge')) return new Response(JSON.stringify({ ...commit, tree: { sha: 'different' } }));
    issueRequests++;
    throw new Error('Must not close or fetch issue');
  }) as typeof fetch);
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  orchestrator.config = { github: { token: 'test', repository: 'acme/repo' } };
  orchestrator.repo = { defaultBranch: 'main' };
  orchestrator.waitForOperator = async (_state: any, label: string, note: string) => {
    assert.equal(label, 'verified'); assert.ok(note.includes('实际合并提交')); notices++;
  };
  try {
    assert.equal(await orchestrator.confirmMergedImplementation(state), true, 'Handled wait, not approval');
    assert.equal(state.merged, false); assert.notEqual(state.status, 'completed');
    assert.equal(issueRequests, 0); assert.equal(notices, 1);
  } finally { setGitHubFetchImplForTest(null); await closeSharedAgent(); }
});

test('completion rejects partial coverage, invented receipts and stale specification proof', () => {
  for (const mutate of [
    (s: any) => { delete s.implementation.behaviorVerification.coverage; },
    (s: any) => { s.implementation.behaviorVerification.checks[0].requirementIds = ['AC-1']; },
    (s: any) => { s.implementation.behaviorVerification.checks[0].receiptIds = ['invented']; },
    (s: any) => { s.specs.product.acceptanceCriteria.push('Another requirement'); },
    (s: any) => { s.specs.commitSha = 'new-spec'; },
    (s: any) => { delete s.implementation.behaviorVerification.judgment; },
    (s: any) => { s.implementation.behaviorVerification.judgment.runId = 'old-run'; },
    (s: any) => { s.implementation.behaviorVerification.judgment.checks = []; },
    (s: any) => { s.implementation.behaviorVerification.judgment.checks[0].probability = 0.1; },
    (s: any) => { s.implementation.behaviorVerification.judgment.verdict = 'not-verified'; },
    (s: any) => { s.implementation.behaviorVerification.checks[0].criterion = 'Different assertion'; },
  ]) {
    const state = proof();
    mutate(state);
    assert.equal(canConfirmMergedImplementation(state, pr, 'main', commit), false);
  }
});

test('completion admits factory engineering checks without treating them as business coverage', () => {
  const state = proof();
  const result = state.implementation.behaviorVerification;
  result.checks.push({ kind: 'operator-regression', criterion: 'Configured command exited zero',
    requirementIds: [], passed: true, receiptIds: ['operator-receipt'] });
  result.coverage.passingReceiptIds.push('operator-receipt');
  result.judgment.checks.push({ index: 1, probability: 0.95 });
  result.judgment.checksHash = verificationChecksHash(result.checks);
  assert.equal(canConfirmMergedImplementation(state, pr, 'main', commit), true);
  for (const mutate of [
    (s: any) => { s.checks[0].requirementIds = ['AC-1']; },
    (s: any) => { s.checks[1].requirementIds = ['AC-2']; },
    (s: any) => { delete s.checks[1].kind; },
    (s: any) => { s.checks[1].kind = 'invented-kind'; },
    (s: any) => { s.checks[1].passed = false; },
    (s: any) => { s.checks[1].receiptIds = ['unknown']; },
    (s: any) => { s.checks[1].receiptIds.push('receipt-1'); },
  ]) {
    const altered = structuredClone(state);
    const verification = altered.implementation.behaviorVerification;
    mutate(verification);
    verification.judgment.checksHash = verificationChecksHash(verification.checks);
    assert.equal(canConfirmMergedImplementation(altered, pr, 'main', commit), false);
  }
  const altered = structuredClone(state);
  delete altered.implementation.behaviorVerification.checks[1].kind;
  assert.notEqual(verificationChecksHash(altered.implementation.behaviorVerification.checks), result.judgment.checksHash,
    'Factory check kind is bound by the independent judgment hash');
});

test('completion never closes an issue with rejected, missing or stale specification approval', async () => {
  for (const mutate of [
    (s: any) => { s.specReview.verdict = 'REJECT'; },
    (s: any) => { delete s.specReview; },
    (s: any) => { s.specReviewedKey = 'spec/issue-53@old-head'; },
  ]) {
    const state = proof();
    mutate(state);
    let requests = 0;
    setGitHubFetchImplForTest((async () => { requests++; throw new Error('Must not access remote completion'); }) as typeof fetch);
    const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
    try {
      assert.equal(await orchestrator.confirmMergedImplementation(state), false);
      assert.equal(state.merged, false);
      assert.notEqual(state.status, 'completed');
      assert.equal(requests, 0);
    } finally { setGitHubFetchImplForTest(null); await closeSharedAgent(); }
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

test('completion observes issue closure, migrates only an exact already-merged legacy tree and reconciles a lost PATCH response', async () => {
  for (const loseResponse of [false, true, 'legacy']) {
    const state = proof();
    if (loseResponse === 'legacy') delete state.mergeCandidate;
    state.status = 'waiting';
    let closed = false;
    let patches = 0;
    setGitHubFetchImplForTest((async (url: any, options: any) => {
      if (String(url).endsWith('/pulls/56')) return new Response(JSON.stringify(pr));
      if (String(url).endsWith('/git/commits/actual-merge')) return new Response(JSON.stringify(commit));
      if (String(url).endsWith('/git/commits/verified-head')) return new Response(JSON.stringify({ sha, tree: { sha: 'verified-tree' } }));
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
