import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { businessInputHash } from '../../runtime/business-input.mjs';

test('blocked verification stays parked until genuinely new business input, then resumes without clearing budgets', async () => {
  const issue = { number: 53, title: 'Docs', body: 'README only', author: 'operator', state: 'open',
    labels: ['verify-failed'], createdAt: '', comments: [{ author: 'operator', body: 'Earlier clarification', createdAt: '2026-09-30' }] };
  const state = { issue, status: 'waiting', nextLabel: 'verify-failed', merged: false,
    implementation: { prUrl: 'https://github.com/acme/repo/pull/56', behaviorVerification: { status: 'blocked', notes: 'Receipt mismatch' } },
    verifiedSha: 'old', wait: { note: 'Fix receipts' }, failureCounts: { verify: { AGENT_REASONING: 1 } },
    lastJudgmentHash: businessInputHash(issue),
  };
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  orchestrator.config = { syncLabels: false, syncProjects: false };
  orchestrator.store = { load: async () => state, save: async () => state };
  assert.equal(await orchestrator.runForIssue(issue), state);
  assert.equal(state.implementation.behaviorVerification.status, 'blocked');
  issue.comments.push({ author: 'operator', body: 'Tooling fixed, rerun validation with fresh receipts', createdAt: '2026-09-30T08:00:00Z' });
  orchestrator.transition = async (current: any, label: string) => {
    assert.equal(label, 'ready-to-merge');
    assert.equal(current.implementation.behaviorVerification, undefined);
    assert.equal(current.verifiedSha, undefined);
    assert.equal(current.wait, undefined);
    assert.deepEqual(current.failureCounts, { verify: { AGENT_REASONING: 1 } });
    throw new Error('verification-resume-observed');
  };
  await assert.rejects(orchestrator.runForIssue(issue), /verification-resume-observed/);
});
