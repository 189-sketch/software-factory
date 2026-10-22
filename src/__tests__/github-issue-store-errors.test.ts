import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitHubIssueStore } from '../core/github-issue-store.js';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { SessionStore } from '../core/session-store.js';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { workerFailure } from '../../runtime/worker-failure.mjs';
import type { FactoryIssueState } from '../core/types.js';
import { setGitHubFetchImplForTest, closeSharedAgent } from '../../runtime/github-rest.mjs';

const state = { issue: { number: 1 }, merged: false } as FactoryIssueState;

test('stage preserves the first persistence failure and does not overwrite its pending journal in finally', async () => {
  const primary = Object.assign(new Error('GitHub upload response was lost'), { code: 'FACTORY_STATE_UPLOAD_PENDING',
    cause: Object.assign(new Error('Headers timed out'), { request: { resource: 'git-ref', phase: 'headers' } }) });
  const secondary = Object.assign(new Error('Journal already pending'), { code: 'FACTORY_STATE_UNAVAILABLE' });
  const orchestrator = Object.create(FactoryOrchestrator.prototype) as any;
  let saves = 0;
  orchestrator.repo = { workdir: os.tmpdir() };
  orchestrator.logger = { info() {} };
  orchestrator.store = { save: async () => { throw ++saves === 1 ? primary : secondary; } };
  orchestrator.publishWorkflowLabel = async (current: FactoryIssueState) => orchestrator.store.save(current);
  const current = { issue: { number: 1, body: '', comments: [], labels: [] }, merged: false } as unknown as FactoryIssueState;
  await assert.rejects(orchestrator.stage(current, 'review', async () => assert.fail('No agent after a failed checkpoint')), error => {
    assert.equal(error, primary);
    return true;
  });
  assert.equal(saves, 1);
  assert.equal(current.stages?.review?.status, 'failed');
});

test('real state-save network abort preserves the DOMException and marks persistence ownership', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-state-error-'));
  const abort = new DOMException('This operation was aborted', 'AbortError');
  let calls = 0;
  setGitHubFetchImplForTest(async () => { calls++; throw abort; });
  try {
    const store = new GitHubIssueStore({ repository: 'local/diagnostic', token: 'diagnostic-only',
      stateDir: directory, leaseSha: 'diagnostic-lease', writers: ['diagnostic'] });
    await assert.rejects(store.save(state), error => {
      assert.equal((error as { code: string }).code, 'FACTORY_STATE_UNAVAILABLE');
      assert.equal(((error as Error).cause as Error).cause, abort);
      assert.equal((error as Error).message, 'Factory state save failed');
      const failure = workerFailure(error);
      assert.equal(failure.owner, 'state-runtime');
      assert.equal(failure.operation, 'save');
      assert.equal(failure.request?.resource, 'git-ref');
      assert.equal(failure.request?.phase, 'headers');
      assert.equal(abort.code, 20);
      return true;
    });
    assert.ok(calls > 0);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'sessions', '1.json'), 'utf8')).providerSessions, {});
  } finally {
    setGitHubFetchImplForTest(null);
    closeSharedAgent();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('state load, history and lease preflight aborts retain state ownership and safe request diagnostics', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-state-error-'));
  const abort = new DOMException('This operation was aborted', 'AbortError');
  setGitHubFetchImplForTest(async () => { throw abort; });
  try {
    const store = new GitHubIssueStore({ repository: 'local/diagnostic', token: 'diagnostic-only',
      stateDir: directory, leaseSha: 'diagnostic-lease', writers: ['diagnostic'] });
    for (const [operation, resource, run] of [
      ['read', ['issue-comments', 'git-ref', 'issue'], () => store.load(1)],
      ['history', ['issue-comments', 'git-ref'], () => store.priorVerifications(1)],
      ['lease-read', ['git-ref'], () => store.withLease(1, async () => assert.fail('Business callback must not run'))],
    ] as const) {
      await assert.rejects(run(), error => {
        const failure = workerFailure(error);
        assert.equal(failure.owner, 'state-runtime');
        assert.equal(failure.code, 'FACTORY_STATE_UNAVAILABLE');
        assert.equal(failure.operation, operation);
        assert.ok((resource as readonly string[]).includes(failure.request?.resource ?? ''));
        assert.equal(failure.request?.phase, 'headers');
        assert.equal(((error as Error).cause as Error).cause, abort);
        return true;
      });
    }
    assert.equal(abort.code, 20);
  } finally {
    setGitHubFetchImplForTest(null);
    closeSharedAgent();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('state recovery is owned but the business callback is never relabeled as a state fault', async () => {
  const original = { assertLease: GitHubStateStore.prototype.assertLease, read: GitHubStateStore.prototype.read,
    recover: GitHubStateStore.prototype.recover };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-state-error-'));
  const disk = Object.freeze(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
  const business = Object.freeze(new Error('Business agent failed'));
  try {
    const store = new GitHubIssueStore({ repository: 'local/diagnostic', token: 'diagnostic-only',
      stateDir: directory, leaseSha: 'diagnostic-lease' });
    GitHubStateStore.prototype.recover = async () => { throw disk; };
    await assert.rejects(store.recover(1), error => {
      assert.equal((error as Error).cause, disk);
      assert.equal(workerFailure(error).operation, 'recover');
      return true;
    });
    GitHubStateStore.prototype.assertLease = async () => {};
    GitHubStateStore.prototype.recover = async () => ({ recovered: false });
    GitHubStateStore.prototype.read = async () => ({ ...state, issue: { ...state.issue, state: 'open' } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(store.withLease(1, async () => { throw business; }), error => {
        assert.equal(error, business);
        assert.equal(workerFailure(error).owner, 'worker-runtime');
        return true;
      });
    }
  } finally {
    Object.assign(GitHubStateStore.prototype, original);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('session persistence failures cannot mutate frozen errors or masquerade as agent failures', async () => {
  const originalSave = SessionStore.prototype.save;
  const disk = Object.freeze(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
  const pending = Object.freeze(Object.assign(new Error('Upload pending'), { code: 'FACTORY_STATE_UPLOAD_PENDING' }));
  try {
    const store = new GitHubIssueStore({ repository: 'local/diagnostic', token: 'diagnostic-only', stateDir: os.tmpdir() });
    for (const original of [disk, pending, 'non-Error failure']) {
      SessionStore.prototype.save = async () => { throw original; };
      await assert.rejects(store.save(state), error => {
        if (original === pending) assert.equal(error, pending);
        else {
          assert.equal((error as { code: string }).code, 'FACTORY_STATE_UNAVAILABLE');
          assert.equal((error as Error).cause, original);
        }
        return true;
      });
    }
    assert.equal(disk.code, 'EACCES');
  } finally {
    SessionStore.prototype.save = originalSave;
  }
});
