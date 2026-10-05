// Read-only production state-read benchmark. No cache can substitute for a GitHub response.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fetch } from 'undici';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { setGitHubFetchImplForTest, closeSharedAgent } from '../../runtime/github-rest.mjs';

const [repository, numberText, stateDir] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && Number.isSafeInteger(number) && number > 0 && stateDir,
  'Usage: github-read-probe <repository> <issue> <state-dir>');
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
let run;
setGitHubFetchImplForTest(async (url, options) => {
  const response = await fetch(url, options);
  return { ok: response.ok, status: response.status, statusText: response.statusText, headers: response.headers,
    text: async () => {
      const text = await response.text();
      if (new URL(url).pathname.endsWith('/comments')) {
        run.responses.push({ status: response.status, wireBytes: Buffer.byteLength(text) });
      }
      return text;
    } };
});
try {
  const store = new GitHubStateStore({ repository, token, stateDir });
  const runs = [];
  for (const name of ['cold', 'revalidated']) {
    run = { name, responses: [] };
    const started = Date.now();
    const { latest } = await store.readRecord(number);
    assert.ok(latest, 'The complete trusted revision chain must still validate');
    run.elapsedMs = Date.now() - started;
    run.revision = latest.envelope.revision;
    runs.push(run);
  }
  const bytes = record => record.responses.reduce((total, response) => total + response.wireBytes, 0);
  console.log(JSON.stringify({ runs, remoteWrites: 0, workflowExecutions: 0 }));
  assert.ok(runs[1].responses.some(response => response.status === 304), 'Unchanged history must be revalidated by GitHub');
  assert.ok(bytes(runs[1]) < bytes(runs[0]) / 2, 'Unchanged history must not repeatedly transfer the complete recovery payload');
} catch (error) {
  console.log(JSON.stringify({ passed: false, phase: run?.name, error: error.code ?? error.name,
    validatorMismatch: error.message === 'GitHub conditional response has no matching validated representation', responses: run?.responses,
    remoteWrites: 0, workflowExecutions: 0 }));
  process.exitCode = 1;
} finally {
  setGitHubFetchImplForTest(null);
  closeSharedAgent();
}
