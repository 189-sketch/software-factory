import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveFactoryConfig } from '../runtime/factory-config.mjs';
import { readIssueState, listIssueStates } from '../runtime/issue-state.mjs';
import { encodeState, publicSnapshot } from '../runtime/state-codec.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-authority-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'issues'));
  await writeFile(path.join(directory, 'issues/51.json'), JSON.stringify({ issue: { number: 51 }, nextLabel: 'failed', merged: true }));
  const config = resolveFactoryConfig({ env: { FACTORY_GH_REPO: 'owner/repo', GH_TOKEN: 'test', FACTORY_STATE_DIR: directory } });
  const row = { number: 51, title: 'Live title', labels: [{ name: 'ready-to-implement' }], state: 'open', author: { login: 'user' } };
  const record = encodeState({ version: 1, repository: 'owner/repo', issueNumber: 51, revision: 1, parentHash: null,
    snapshot: publicSnapshot({ issue: { number: 51 }, revision: 1, nextLabel: 'needs-info', merged: false, attempts: 3 }) });
  const api = {
    fetchAuthenticatedUser: async () => ({ login: 'bot' }),
    fetchIssue: async () => row,
    listIssues: async () => [row],
    listIssueComments: async () => [{ author: 'bot', body: record.body }],
  };
  return { config, api, row };
}

test('production readers ignore conflicting local checkpoint and stale remote label projection', async (t) => {
  const f = await fixture(t);
  assert.equal(f.config.state.backend, 'github');
  const state = await readIssueState(f.config, 51, f.api);
  assert.equal(state.nextLabel, 'ready-to-implement');
  assert.equal(state.issue.title, 'Live title');
  assert.equal(state.merged, false);
  assert.equal(state.attempts, 3);
  assert.equal(state.issue.comments.length, 0);
  assert.deepEqual(await listIssueStates(f.config, { ghClient: f.api }), [state]);
});

test('production outage never falls back to local checkpoint', async (t) => {
  const f = await fixture(t);
  f.api.listIssueComments = async () => { throw new Error('network unavailable'); };
  await assert.rejects(readIssueState(f.config, 51, f.api), /network unavailable/);
  await assert.rejects(listIssueStates(f.config, { ghClient: f.api }), /network unavailable/);
});

test('conflicting GitHub labels remain readable but provide no executable stage', async (t) => {
  const f = await fixture(t);
  f.row.labels.push({ name: 'needs-info' });
  const state = await readIssueState(f.config, 51, f.api);
  assert.equal(state.nextLabel, undefined);
  assert.deepEqual(state.issue.workflowConflict, ['ready-to-implement', 'needs-info']);
  assert.equal(state.wait.reason, 'blocked-operator');
  assert.match(state.wait.note, /需要你的操作/);
});

test('closed GitHub issues remain visible to read-only metrics', async (t) => {
  const f = await fixture(t);
  f.row.state = 'closed';
  const [state] = await listIssueStates(f.config, { ghClient: f.api });
  assert.equal(state.issue.state, 'closed');
});
