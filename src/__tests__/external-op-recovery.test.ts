import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverExternalOps } from '../core/external-op-recovery.js';
import { beginExternalOp, finishExternalOp } from '../core/external-op-ledger.js';
import type { FactoryIssueState } from '../core/types.js';
import * as github from '../../runtime/github-rest.mjs';

function fixture() {
  const state = { issue: { number: 29 }, merged: false } as FactoryIssueState;
  const comments: github.IssueComment[] = [];
  let saves = 0;
  const api = { ...github,
    fetchAuthenticatedUser: async () => ({ login: 'bot' }),
    listIssueComments: async () => comments,
    createIssueComment: async ({ body }: { body: string }) => { comments.push({ author: 'bot', body, createdAt: '' }); return 1; },
  };
  const run = () => recoverExternalOps(state, { repository: 'owner/repo', token: 'test' }, async () => { saves++; }, api);
  return { state, comments, api, run, get saves() { return saves; } };
}

test('remote label overrides interrupted label intent without replay', async () => {
  const f = fixture();
  f.state.nextLabel = 'ready-to-implement';
  const { id } = beginExternalOp(f.state, { kind: 'label-sync', idempotencyKey: 'label', payload: { label: 'needs-info' } });
  finishExternalOp(f.state, { id, status: 'unknown' });
  await f.run();
  assert.equal(f.state.externalOps![0].status, 'failed');
  assert.equal(f.state.nextLabel, 'ready-to-implement');
});

test('only a trusted comment confirms a lost comment response', async () => {
  for (const author of ['bot', 'stranger']) {
    const f = fixture();
    const { id } = beginExternalOp(f.state, { kind: 'issue-comment', idempotencyKey: 'marker', payload: { marker: 'marker' } });
    finishExternalOp(f.state, { id, status: 'unknown' });
    f.comments.push({ author, body: 'marker', createdAt: '' });
    await f.run();
    assert.equal(f.state.externalOps![0].status, author === 'bot' ? 'succeeded' : 'failed');
  }
});

test('uncertain push stops execution and emits one actionable operator comment', async () => {
  const f = fixture();
  const { id } = beginExternalOp(f.state, { kind: 'implementation-push', idempotencyKey: 'branch' });
  finishExternalOp(f.state, { id, status: 'unknown' });
  await assert.rejects(f.run(), { code: 'FACTORY_STATE_EXTERNAL_OP_UNRESOLVED' });
  await assert.rejects(f.run(), /需要你的操作/);
  assert.equal(f.comments.length, 1);
  assert.equal(f.state.externalOps![0].status, 'unknown');
});

test('remote outage leaves unresolved operations untouched and performs no writes', async () => {
  const f = fixture();
  beginExternalOp(f.state, { kind: 'pr-create', idempotencyKey: 'branch' });
  f.api.listIssueComments = async () => { throw new Error('offline'); };
  await assert.rejects(f.run(), /offline/);
  assert.equal(f.saves, 0);
  assert.equal(f.comments.length, 0);
});

test('lost issue-close response is reconciled from GitHub without reissuing the write', async () => {
  for (const remoteState of ['open', 'closed']) {
    const f = fixture();
    f.api.fetchIssue = async () => ({ number: 29, state: remoteState } as github.IssueRow);
    const { id } = beginExternalOp(f.state, { kind: 'issue-close', idempotencyKey: 'closure' });
    finishExternalOp(f.state, { id, status: 'unknown' });
    await f.run();
    assert.equal(f.state.externalOps![0].status, remoteState === 'closed' ? 'succeeded' : 'failed');
    assert.notEqual(f.state.status, 'completed');
  }
});

test('merge recovery cannot promote missing acceptance proof to completed', async () => {
  const f = fixture();
  f.api.fetchPullRequest = async () => ({ merged: true, head: { sha: 'head' } } as github.PullRequestRow);
  const { id } = beginExternalOp(f.state, { kind: 'pr-merge', idempotencyKey: 'merge', payload: { prUrl: 'https://github.com/owner/repo/pull/1', expectedHeadSha: 'head' } });
  finishExternalOp(f.state, { id, status: 'unknown' });
  await f.run();
  assert.equal(f.state.externalOps![0].status, 'succeeded');
  assert.notEqual(f.state.status, 'completed');
});
