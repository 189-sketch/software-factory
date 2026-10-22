import test from 'node:test';
import assert from 'node:assert/strict';
import { beginTechnicalSpecificationRepair, finishTechnicalSpecificationRepair } from '../orchestrator/specification-repair.js';

function candidate(): any {
  return { specs: { commitSha: 'approved-spec', specBranch: 'spec/example',
    product: { body: 'Immutable user outcome' }, tech: { slug: 'example' } },
    specReview: { verdict: 'APPROVE' }, specReviewedKey: 'spec/example@approved-spec',
    implementation: { commitSha: 'implementation', behaviorVerification: { status: 'verified' } },
    reviewedSha: 'implementation', verifiedSha: 'implementation', mergeCandidate: { headSha: 'implementation' },
    review: { verdict: 'REJECT', body: 'Concrete lifecycle contradiction', comments: [], mergeRoute: { mode: 'escalate' },
      generatedReview: { specCommitSha: 'approved-spec' },
      typesafeBatch: { b4: { value: 'REJECT', confidence: 0.99 },
        b5: [{ findingId: 'technical', value: 'important', confidence: 0.99 }] },
      findings: [
        { id: 'technical', status: 'open', severity: 'important', evidence: { path: 'specs/example/TECH.md', line: 12 } },
        { id: 'product', status: 'open', severity: 'important', evidence: { path: 'src/state.ts', line: 3 } },
      ] } };
}

test('technical revision retains user requirements and product findings across checkpoint serialization', () => {
  const state = candidate(), original = structuredClone(state);
  assert.equal(beginTechnicalSpecificationRepair(state, 0.9), true);
  assert.deepEqual(state.specReview.findings.map((finding: any) => finding.id), ['technical']);
  assert.deepEqual(state.specs, original.specs);
  assert.deepEqual(state.implementation, original.implementation);
  assert.equal(finishTechnicalSpecificationRepair(state), false, 'An unreviewed revision cannot resume implementation');
  const restored: any = JSON.parse(JSON.stringify(state));
  assert.deepEqual(restored.specificationRepair, state.specificationRepair);
  restored.specReview = { verdict: 'APPROVE' };
  restored.specReviewedKey = 'spec/example@approved-spec';
  assert.equal(finishTechnicalSpecificationRepair(restored), false, 'The old approval is not a repaired revision');
  restored.specs.commitSha = 'revised-spec';
  restored.specReviewedKey = 'spec/example@revised-spec';
  assert.equal(finishTechnicalSpecificationRepair(restored), true);
  assert.equal(restored.review.findings[0].status, 'resolved');
  assert.equal(restored.review.findings[1].status, 'open');
  assert.equal(restored.specs.product.body, original.specs.product.body);
  assert.equal(restored.implementation.commitSha, original.implementation.commitSha);
  assert.equal(restored.implementation.behaviorVerification, undefined);
  assert.equal(restored.verifiedSha, undefined);
  assert.equal(restored.mergeCandidate, undefined);
  assert.equal(restored.correction.targetStage, 'implementation');
  assert.equal(restored.specificationRepair, undefined);
  assert.equal(finishTechnicalSpecificationRepair(restored), false);
});

test('unjudged, stale, advisory, product and unlocated findings cannot rewrite technical specifications', () => {
  const mutations = [
    (state: any) => { state.review.judgmentFailure = { code: 'UNAVAILABLE' }; },
    (state: any) => { delete state.review.mergeRoute; },
    (state: any) => { delete state.review.typesafeBatch; },
    (state: any) => { state.review.typesafeBatch.b4.value = 'APPROVE'; },
    (state: any) => { state.review.typesafeBatch.b4.confidence = 0.6; },
    (state: any) => { state.review.typesafeBatch.b5[0].confidence = 0.6; },
    (state: any) => { state.review.typesafeBatch.b5[0].value = 'suggestion'; },
    (state: any) => { state.review.generatedReview.specCommitSha = 'stale'; },
    (state: any) => { state.reviewedSha = 'stale'; },
    (state: any) => { state.review.findings[0].evidence.path = 'specs/other/TECH.md'; },
    (state: any) => { state.review.findings[0].evidence.path = 'specs/example/PRODUCT.md'; },
    (state: any) => { state.review.findings[0].evidence.line = 0; },
    (state: any) => { state.review.findings[0].status = 'resolved'; },
  ];
  for (const mutate of mutations) {
    const state = candidate(); mutate(state);
    const before = structuredClone(state);
    assert.equal(beginTechnicalSpecificationRepair(state, 0.9), false);
    assert.deepEqual(state, before);
  }
});
