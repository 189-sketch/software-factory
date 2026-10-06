import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrJudgmentState, projectReviewDiff, reviewGenerationEvidence,
  reviewJudgmentContextHash, needsReviewJudgmentContextRecovery } from '../../runtime/review-judgment-context.mjs';
import { judgmentResumeStage, scheduleJudgmentRetry, judgmentRetryPending } from '../../runtime/judgment-recovery.mjs';

function fixture(): any {
  return { issue: { number: 123, title: 'A feature', body: 'Expected behavior', state: 'open', labels: ['verified'],
    comments: [{ author: 'operator', body: 'Keep accessibility', createdAt: 't1' },
      { author: 'operator', body: '<!-- factory-stage:review --> progress', createdAt: 't2' }] },
    status: 'waiting', nextLabel: 'verified', merged: false, reviewedSha: 'head', reviewedBaseSha: 'base',
    specs: { commitSha: 'spec', specBranch: 'spec/feature',
      product: { slug: 'feature', acceptanceCriteria: ['Keyboard support'], nonGoals: ['No API'],
        authorOverrides: [{ requirementId: 'AC-1', rationale: 'Keep it' }], body: 'Full product source' },
      tech: { slug: 'feature', approach: 'Local state', validationPlan: ['Keyboard test'], body: 'Full design source' } },
    specReview: { verdict: 'APPROVE' }, specReviewedKey: 'spec/feature@spec',
    review: { verdict: 'APPROVE', body: 'Static observations', comments: [], findings: [
      { id: 'f1', severity: 'suggestion', status: 'open', summary: 'Extract helper', requirementIds: ['AC-1'],
        evidence: { path: 'src/a.ts', line: 3, excerpt: 'Duplication' }, sourceRunId: 'review-run' }],
      mergeRoute: { mode: 'escalate' }, confidence: 0.55 },
    implementation: { commitSha: 'head', behaviorVerification: { status: 'not-verified', checks: ['actual receipt'] } },
    verificationRecovery: { attempts: 2 }, failureCounts: { implementation: 1 }, wait: { reason: 'blocked-operator' } };
}

test('review context preserves actual constraints and full evidence without factory noise or invented repository facts', () => {
  const state = fixture();
  const packet: any = buildReviewPrJudgmentState(state.issue, state.review, { specs: state.specs, approved: true, headSha: 'head', baseSha: 'base' });
  assert.deepEqual(packet.reviewFindings, state.review.findings);
  assert.deepEqual(packet.specification.product.acceptanceCriteria, state.specs.product.acceptanceCriteria);
  assert.deepEqual(packet.specification.product.authorOverrides, state.specs.product.authorOverrides);
  assert.deepEqual(packet.specification.product.nonGoals, state.specs.product.nonGoals);
  assert.equal(packet.specification.product.body, undefined);
  assert.equal(packet.specification.technicalDesign.body, undefined);
  assert.match(packet.scope.productSource, /not independently audited/);
  assert.equal(packet.repoSignals, undefined);
  assert.equal(packet.issue.comments.length, 1);
  assert.equal(packet.specification.approved, true);
  assert.deepEqual(packet.decision, { stage: 'review-pr', headSha: 'head', baseSha: 'base' });
  assert.equal((buildReviewPrJudgmentState(state.issue, state.review) as any).specification.approved, null);
});

test('unparsed specifications keep their source body instead of inventing structured coverage', () => {
  const state = fixture();
  state.specs.product.acceptanceCriteria = [];
  state.specs.tech = { slug: 'feature', body: 'Only prose design' };
  const packet: any = buildReviewPrJudgmentState(state.issue, state.review, { specs: state.specs });
  assert.equal(packet.specification.product.body, 'Full product source');
  assert.equal(packet.specification.technicalDesign.body, 'Only prose design');
});

test('diff projection retains cited file changes verbatim, inventories other files, and declares missing references', () => {
  const a = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const b = 'diff --git "a/src/spaced name.ts" "b/src/spaced name.ts"\n--- "a/src/spaced name.ts"\n+++ "b/src/spaced name.ts"\n@@ -1 +1 @@\n-old\n+new\n';
  const c = 'diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-x\n+y\n';
  const source = reviewGenerationEvidence(fixture().review);
  source.comments = [{ path: 'src/spaced name.ts', line: 1, side: 'RIGHT', body: 'Observation' }];
  source.findings!.push({ ...source.findings![0], id: 'missing', evidence: { path: 'unavailable.ts' } });
  const result = projectReviewDiff(a + b + c, source);
  assert.equal(result.prDiff, a + b);
  assert.equal(result.changeInventory.length, 3);
  assert.equal(result.changeInventory[2].included, false);
  assert.deepEqual(result.missingReferencedPaths, ['unavailable.ts']);
  assert.ok(result.changeInventory.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.equal(projectReviewDiff(c, { ...source, findings: [], comments: [] }).prDiff, '');
  assert.equal(projectReviewDiff(a + b + c, { ...source, findings: [], comments: [], body: 'AC-1: src/other.ts implements the behavior' }).prDiff, c);
});

test('judgment results cannot rewrite their own input hash or original generation evidence', () => {
  const state = fixture();
  state.review.generatedReview = { ...reviewGenerationEvidence(state.review), origin: 'claude-code', specCommitSha: 'spec' };
  const expected = reviewJudgmentContextHash(state);
  state.review.body += ' Jev adjustment';
  state.review.findings[0].severity = 'blocking';
  state.review.confidence = 0.99;
  state.review.mergeRoute.mode = 'auto';
  assert.equal(reviewJudgmentContextHash(state), expected);
  assert.equal(reviewGenerationEvidence(state.review).findings![0].severity, 'suggestion');
});

test('only actual input changes invalidate review context, including body-only spec constraints', () => {
  const original = fixture(), expected = reviewJudgmentContextHash(original);
  for (const change of [
    (s: any) => { s.issue.body += ' new requirement'; },
    (s: any) => { s.issue.comments[0].body += ' new constraint'; },
    (s: any) => { s.specs.product.body += ' body-only constraint'; },
    (s: any) => { s.specs.tech.body += ' migration'; },
    (s: any) => { s.specs.product.acceptanceCriteria.push('Second AC'); },
    (s: any) => { s.review.findings[0].evidence.excerpt += ' detail'; },
    (s: any) => { s.implementation.commitSha = 'other-head'; },
    (s: any) => { s.reviewedBaseSha = 'other-base'; },
  ]) { const s = structuredClone(original); change(s); assert.notEqual(reviewJudgmentContextHash(s), expected); }
  original.issue.labels = ['review-needed'];
  original.issue.comments[1].body += ' notification';
  original.revision = 1000;
  original.failureCounts.implementation = 99;
  assert.equal(reviewJudgmentContextHash(original), expected);
});

test('changed review context admits one recovery, preserves budgets and evidence, then parks unchanged polls', () => {
  const state = fixture(), saved = structuredClone(state);
  assert.equal(needsReviewJudgmentContextRecovery(state), true);
  assert.equal(judgmentResumeStage(state), 'review');
  assert.deepEqual(state, saved);
  state.review.judgmentInputHash = reviewJudgmentContextHash(state);
  assert.equal(needsReviewJudgmentContextRecovery(state), false);
  assert.equal(judgmentResumeStage(state), undefined);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(needsReviewJudgmentContextRecovery(restored), false);
  assert.deepEqual(state.verificationRecovery, saved.verificationRecovery);
  assert.deepEqual(state.implementation, saved.implementation);
  assert.deepEqual(state.failureCounts, saved.failureCounts);
});

test('context recovery refuses closed, stale, unapproved or configuration-blocked candidates; retries retain their clock', () => {
  for (const change of [
    (s: any) => { s.issue.state = 'closed'; }, (s: any) => { s.merged = true; },
    (s: any) => { s.reviewedSha = 'stale'; }, (s: any) => { s.specReviewedKey = 'stale'; },
    (s: any) => { s.review.judgmentFailure = { kind: 'configuration' }; },
    (s: any) => { s.review.verdict = 'REJECT'; },
  ]) { const s = fixture(); change(s); assert.equal(needsReviewJudgmentContextRecovery(s), false); }
  const state = fixture();
  state.review.judgmentInputHash = reviewJudgmentContextHash(state);
  state.wait = scheduleJudgmentRetry(state, 'review', 1000, 8000, 10000);
  assert.equal(judgmentRetryPending(state, 10001), true);
  const second = scheduleJudgmentRetry(state, 'review', 1000, 8000, 11000);
  assert.equal(second.attempts, 2);
  assert.equal(second.since, state.wait.since);
});
