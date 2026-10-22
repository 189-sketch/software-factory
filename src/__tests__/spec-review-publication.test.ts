import test from 'node:test';
import assert from 'node:assert/strict';
import { publishSpecReviewDecision, publishReviewDecision } from '../orchestrator/decision-publish.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';
import { setGitHubFetchImplForTest, closeSharedAgent } from '../../runtime/github-rest.mjs';
import type { SpecReviewResult } from '../core/types.js';

test('published spec decision separates reviewer, Jev and final gate and deduplicates the complete decision', async t => {
  const comments: Array<{ id: number; body: string }> = [];
  setGitHubFetchImplForTest(async (_input, init) => {
    if (init?.method === 'POST') {
      const { body } = JSON.parse(String(init.body));
      const row = { id: comments.length + 1, body };
      comments.push(row);
      return new Response(JSON.stringify(row), { status: 201 });
    }
    return new Response(JSON.stringify(comments), { status: 200 });
  });
  t.after(() => { setGitHubFetchImplForTest(null); closeSharedAgent(); });
  const baseConfig = resolveFactoryConfig({ env: {} });
  const config = { ...baseConfig, syncLabels: true,
    github: { ...baseConfig.github, repository: 'test/review-publication', token: 'fixture-token' } };
  const state: any = { issue: { number: 72 }, specs: { commitSha: 'spec-commit-72' } };
  const store = { async save(current: any) { return current; } };
  const review: SpecReviewResult = {
    verdict: 'APPROVE', reviewerVerdict: 'APPROVE', inputRevision: 'snapshot-72',
    body: 'Found: 0 critical, 0 important, 0 suggestions, 1 nit. Ready for implementation.',
    comments: [], notes: 'B4 disagreement is advisory: no current blocking finding.',
    findings: [],
    typesafeBatch: { b4: { id: 'B4', value: 'REJECT', confidence: 0.62 }, b5: [], meanConfidence: 0.62 },
  };
  await publishSpecReviewDecision(state, review, config, store);
  assert.equal(comments.length, 1);
  const body = comments[0].body;
  assert.match(body, /\*\*Spec review: APPROVE\*\*/);
  assert.match(body, /Reviewer: APPROVE/);
  assert.match(body, /Jev B4: REJECT \(confidence=0\.62\)/);
  assert.match(body, /Final gate: APPROVE/);
  assert.match(body, /Review snapshot: snapshot-72/);
  assert.match(body, /Spec commit: spec-commit-72/);
  assert.match(body, /Final findings: 0 blocking\/important/);
  assert.ok(body.includes(review.body));
  await publishSpecReviewDecision(state, review, config, store);
  assert.equal(comments.length, 1, 'The same decision must not post twice');

  await publishSpecReviewDecision(state, { ...review, verdict: 'REJECT' }, config, store);
  assert.equal(comments.length, 2, 'A changed final gate must not reuse the previous publication marker');
  assert.match(comments[1].body, /Reviewer: APPROVE/);
  assert.match(comments[1].body, /Final gate: REJECT/);
  await publishSpecReviewDecision(state, { ...review, inputRevision: 'snapshot-73' }, config, store);
  assert.equal(comments.length, 3, 'A new snapshot must have a separate publication identity');
});

test('PR evidence repair publishes a pending status and a later judged result is not deduplicated away', async t => {
  const comments: Array<{ id: number; body: string }> = [];
  setGitHubFetchImplForTest(async (_input, init) => {
    if (init?.method === 'POST') {
      const row = { id: comments.length + 1, body: JSON.parse(String(init.body)).body };
      comments.push(row);
      return new Response(JSON.stringify(row), { status: 201 });
    }
    return new Response(JSON.stringify(comments), { status: 200 });
  });
  t.after(() => { setGitHubFetchImplForTest(null); closeSharedAgent(); });
  const base = resolveFactoryConfig({ env: {} });
  const config = { ...base, syncLabels: true, github: { ...base.github, repository: 'test/review', token: 'fixture-token' } };
  const state: any = { issue: { number: 72 } };
  const store = { async save(current: any) { return current; } };
  const review = { verdict: 'APPROVE', body: 'AC-1: Feedback.tsx:1 renders the form.' };
  const unjudged = { ...review, judgmentFailure: { kind: 'contract' as const, code: 'REVIEW_EVIDENCE_INSUFFICIENT' } };
  await publishReviewDecision(state, unjudged, config, store);
  await publishReviewDecision(state, unjudged, config, store);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /代码审查尚未完成/);
  assert.match(comments[0].body, /自动补齐/);
  assert.doesNotMatch(comments[0].body, /需要你的操作|PR review: APPROVE/);
  await publishReviewDecision(state, review, config, store);
  assert.equal(comments.length, 2);
  assert.match(comments[1].body, /PR review: APPROVE/);
});
