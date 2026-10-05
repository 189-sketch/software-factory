// Isolated diagnostic: real save entry and session persistence, failed network only.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { GitHubIssueStore } from '../../src/core/github-issue-store.js';
import type { FactoryIssueState } from '../../src/core/types.js';
import { setGitHubFetchImplForTest, closeSharedAgent } from '../../runtime/github-rest.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-state-error-'));
const originalError = new DOMException('This operation was aborted', 'AbortError');
let calls = 0;
setGitHubFetchImplForTest(async () => { calls++; throw originalError; });
try {
  const store = new GitHubIssueStore({ repository: 'local/diagnostic', token: 'diagnostic-only',
    stateDir: directory, leaseSha: 'diagnostic-lease', writers: ['diagnostic'] });
  try {
    await store.save({ issue: { number: 1 }, merged: false } as FactoryIssueState);
    throw new Error('Injected network failure unexpectedly succeeded');
  } catch (error) {
    let current: unknown = error;
    let preserved = false;
    for (let depth = 0; current && depth < 8; depth++) {
      if (current === originalError) { preserved = true; break; }
      current = (current as Error).cause;
    }
    console.log(JSON.stringify({ calls, originalPreserved: preserved,
      name: (error as Error).name, message: (error as Error).message, code: (error as { code?: unknown }).code }));
    process.exitCode = preserved && String((error as { code?: unknown }).code).startsWith('FACTORY_STATE_') ? 0 : 1;
  }
} finally {
  setGitHubFetchImplForTest(null);
  closeSharedAgent();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('factory-state-error-'));
  await fs.rm(directory, { recursive: true, force: true });
}
