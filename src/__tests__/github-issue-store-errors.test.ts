import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitHubIssueStore } from '../core/github-issue-store.js';
import { SessionStore } from '../core/session-store.js';
import type { FactoryIssueState } from '../core/types.js';
import { setGitHubFetchImplForTest, closeSharedAgent } from '../../runtime/github-rest.mjs';

const state = { issue: { number: 1 }, merged: false } as FactoryIssueState;

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
      assert.equal((error as Error).cause, abort);
      assert.match((error as Error).message, /This operation was aborted/);
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
