import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fetch } from 'undici';
import { _test_getWithRetry, closeSharedAgent, setGitHubFetchImplForTest } from '../runtime/github-rest.mjs';
import * as github from '../runtime/github-rest.mjs';
import { GitHubStateStore } from '../runtime/github-state-store.mjs';
import { encodeState } from '../runtime/state-codec.mjs';

async function serverFor(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    setGitHubFetchImplForTest(null);
    closeSharedAgent();
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const options = { token: 'fixture-reader', conditional: true, maxRetries: 0 };

test('conditional JSON reads revalidate weak tags, return independent values and observe changed data', async t => {
  let version = 1;
  const seen = [];
  const origin = await serverFor(t, (request, response) => {
    const supplied = request.headers['if-none-match'];
    seen.push(supplied);
    const etag = `"v${version}"`;
    if (supplied?.replace(/^W\//, '') === etag) { response.writeHead(304, { etag }); response.end(); }
    else { response.writeHead(200, { etag: `W/${etag}` }); response.end(JSON.stringify([{ value: version }])); }
  });
  const first = await _test_getWithRetry(origin, options);
  first[0].value = 'caller modification';
  assert.deepEqual(await _test_getWithRetry(origin, options), [{ value: 1 }]);
  version = 2;
  assert.deepEqual(await _test_getWithRetry(origin, options), [{ value: 2 }]);
  assert.deepEqual(seen, [undefined, 'W/"v1"', 'W/"v1"']);
});

test('cached history never substitutes for offline, unauthorized or forbidden remote reads', async t => {
  let mode = 200, requests = 0;
  const origin = await serverFor(t, (request, response) => {
    requests++;
    if (mode === 'offline') { request.socket.destroy(); return; }
    if (mode === 'timeout') return;
    response.writeHead(mode, { etag: '"one"' });
    response.end(mode === 200 ? '[]' : '{"message":"permission denied"}');
  });
  await _test_getWithRetry(origin, options);
  for (const status of [401, 403]) {
    mode = status;
    const previous = requests;
    await assert.rejects(_test_getWithRetry(origin, { ...options, maxRetries: 3 }), { status, transient: false });
    assert.equal(requests, previous + 1, 'Permanent HTTP errors must not become retryable network flakes');
  }
  mode = 'offline';
  await assert.rejects(_test_getWithRetry(origin, options));
  mode = 'timeout';
  await assert.rejects(_test_getWithRetry(origin, { ...options, timeoutMs: 50 }), { name: 'AbortError' });
});

test('validators are scoped to credential and URL, and invalid 304 responses fail closed', async t => {
  let mismatch = false, noTag = false;
  const seen = [];
  const origin = await serverFor(t, (request, response) => {
    const supplied = request.headers['if-none-match'];
    seen.push(supplied);
    if (mismatch) { response.writeHead(304, { etag: '"different"' }); response.end(); }
    else { response.writeHead(200, noTag ? {} : { etag: '"one"' }); response.end('[]'); }
  });
  await _test_getWithRetry(`${origin}/a`, options);
  await _test_getWithRetry(`${origin}/a`, { ...options, token: 'another-reader' });
  await _test_getWithRetry(`${origin}/b`, options);
  assert.deepEqual(seen, [undefined, undefined, undefined]);
  mismatch = true;
  await assert.rejects(_test_getWithRetry(`${origin}/a`, options), /matching validated representation/);
  await assert.rejects(_test_getWithRetry(`${origin}/unknown`, options), /matching validated representation/);
  mismatch = false; noTag = true;
  await _test_getWithRetry(`${origin}/b`, options);
  await _test_getWithRetry(`${origin}/b`, options);
  assert.equal(seen.at(-1), undefined, 'A response without a validator removes the previous cached representation');
});

test('a successful invalid JSON replacement cannot retain an older cached representation', async t => {
  let invalid = false;
  const seen = [];
  const origin = await serverFor(t, (request, response) => {
    seen.push(request.headers['if-none-match']);
    response.writeHead(200, { etag: '"one"' }); response.end(invalid ? 'private invalid response' : '[]');
  });
  await _test_getWithRetry(origin, options);
  invalid = true;
  await assert.rejects(_test_getWithRetry(origin, options), /returned invalid JSON/);
  invalid = false;
  await _test_getWithRetry(origin, options);
  assert.equal(seen.at(-1), undefined);
});

test('conditional history memory is bounded and eviction performs a full remote read', async t => {
  let payload = JSON.stringify('x'.repeat(8_500_000));
  const seen = [];
  const origin = await serverFor(t, (request, response) => {
    seen.push(request.headers['if-none-match']);
    response.writeHead(200, { etag: '"large"' }); response.end(payload);
  });
  for (const suffix of ['/one', '/two', '/one']) await _test_getWithRetry(origin + suffix, { ...options, timeoutMs: 5000 });
  assert.equal(seen.at(-1), undefined, 'Two representations exceeding the budget evict the least recently validated page');
  payload = JSON.stringify('x'.repeat(17_000_000));
  for (let index = 0; index < 2; index++) await _test_getWithRetry(origin + '/oversized', { ...options, timeoutMs: 5000 });
  assert.equal(seen.at(-1), undefined, 'An individual oversized representation must not be retained');
});

test('production state reads revalidate every page and still reject missing parents after history edits', async t => {
  const repository = 'local/conditional', number = 1;
  const first = encodeState({ version: 1, repository, issueNumber: number, revision: 1, parentHash: null,
    snapshot: { issue: { number }, revision: 1, merged: false } });
  const second = encodeState({ ...first.envelope, revision: 2, parentHash: first.hash,
    snapshot: { issue: { number }, revision: 2, merged: false } });
  const rows = [{ id: 1, user: { login: 'author' }, body: 'Original business input' },
    { id: 2, user: { login: 'factory-bot' }, body: first.body }, { id: 3, user: { login: 'factory-bot' }, body: second.body }];
  const statuses = [];
  const origin = await serverFor(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/user') { response.end('{"login":"factory-bot"}'); return; }
    const page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('per_page'));
    const text = JSON.stringify(rows.slice((page - 1) * size, page * size));
    const tag = `"${createHash('sha256').update(text).digest('hex')}"`;
    const unchanged = request.headers['if-none-match']?.replace(/^W\//, '') === tag;
    statuses.push(unchanged ? 304 : 200);
    response.writeHead(unchanged ? 304 : 200, { etag: `W/${tag}` }); response.end(unchanged ? undefined : text);
  });
  setGitHubFetchImplForTest((url, args) => {
    const remote = new URL(url); return fetch(origin + remote.pathname + remote.search, args);
  });
  const store = new GitHubStateStore({ repository, token: 'fixture-reader', stateDir: process.cwd(), ghClient: {
    ...github, listIssueComments: args => github.listIssueComments({ ...args, perPage: 2 }),
  } });
  const result = await store.readRecord(number);
  assert.equal(result.latest.envelope.revision, 2);
  result.comments[1].body = 'Caller mutation';
  assert.equal((await store.readRecord(number)).latest.hash, second.hash);
  assert.deepEqual(statuses.slice(2), [304, 304], 'A validated latest page cannot bypass validation of earlier pages');
  rows[0].body = 'Edited author input';
  assert.equal((await store.readRecord(number)).comments[0].body, rows[0].body);
  rows.splice(1, 1);
  await assert.rejects(store.readRecord(number), /missing parent/);
});
