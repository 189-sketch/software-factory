import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('nested transport failures identify the actual connection deadline without leaking addresses', async t => {
  t.after(() => { setGitHubFetchImplForTest(null); closeSharedAgent(); });
  const cause = Object.assign(new Error('Connection to private-address failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  setGitHubFetchImplForTest(async () => { throw new TypeError('fetch failed', { cause }); });
  await assert.rejects(_test_getWithRetry('https://api.github.com/repos/private/repo/git/ref/heads/test',
    { token: 'private-token', maxRetries: 0 }), error => {
    assert.equal(error.requestTimedOut, true);
    assert.equal(error.githubRequest.phase, 'connect');
    assert.equal(error.githubRequest.timeoutMs, 10000);
    assert.equal(error.githubRequest.transportCode, 'UND_ERR_CONNECT_TIMEOUT');
    assert.ok(!JSON.stringify(error.githubRequest).includes('private'));
    return true;
  });
});

test('git ref reads tolerate transient connection failures but never retry permission errors', async t => {
  t.after(() => { setGitHubFetchImplForTest(null); closeSharedAgent(); });
  let calls = 0;
  setGitHubFetchImplForTest(async () => {
    if (++calls <= 2) throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    return new Response(JSON.stringify({ object: { sha: 'confirmed-head' } }));
  });
  assert.equal(await github.getRef({ token: 'fixture', repository: 'local/retry', ref: 'heads/test' }), 'confirmed-head');
  assert.equal(calls, 3);
  calls = 0;
  setGitHubFetchImplForTest(async () => { calls++; return new Response('{}', { status: 403 }); });
  await assert.rejects(github.getRef({ token: 'fixture', repository: 'local/retry', ref: 'heads/test' }), { status: 403, transient: false });
  assert.equal(calls, 1);
});

test('request failures distinguish header and body deadlines without exposing URLs or credentials', async t => {
  const origin = await serverFor(t, (request, response) => {
    if (request.url.includes('/body')) { response.writeHead(200); response.flushHeaders(); }
  });
  for (const phase of ['headers', 'body']) {
    await assert.rejects(_test_getWithRetry(`${origin}/${phase}?private=secret-value`,
      { token: 'private-token', maxRetries: 0, timeoutMs: 100 }), error => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.requestTimedOut, true);
      assert.equal(error.githubRequest.phase, phase);
      assert.equal(error.githubRequest.status, phase === 'body' ? 200 : undefined);
      assert.equal(error.githubRequest.attempt, 1);
      assert.equal(error.githubRequest.timeoutMs, 100);
      assert.ok(error.githubRequest.elapsedMs >= 80);
      assert.ok(!JSON.stringify(error.githubRequest).includes('secret-value'));
      assert.ok(!JSON.stringify(error.githubRequest).includes('private-token'));
      return true;
    });
  }
});

test('timed-out comment bodies shrink pages, restart complete history and retain remote authority', { timeout: 45000 }, async t => {
  const repository = 'local/adaptive', number = 1;
  const first = encodeState({ version: 1, repository, issueNumber: number, revision: 1, parentHash: null,
    snapshot: { issue: { number }, revision: 1, merged: false } });
  const second = encodeState({ ...first.envelope, revision: 2, parentHash: first.hash,
    snapshot: { issue: { number }, revision: 2, merged: false } });
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, user: { login: 'author' }, body: `Input ${index}` }));
  rows.push({ id: 6, user: { login: 'factory-bot' }, body: first.body },
    { id: 7, user: { login: 'factory-bot' }, body: second.body });
  let stalled = false, forbidden = false;
  const requests = [];
  const origin = await serverFor(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname.includes('/git/ref/')) { response.writeHead(404); response.end('{}'); return; }
    const page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('per_page'));
    const observed = { page, size, status: 200 }; requests.push(observed);
    if (forbidden) { observed.status = 403; response.writeHead(403); response.end('{}'); return; }
    if (!stalled && size === 4 && page === 2) {
      stalled = true;
      response.writeHead(200); response.flushHeaders(); // Same real body timeout as the large GitHub history.
      return;
    }
    const text = JSON.stringify(rows.slice((page - 1) * size, page * size));
    const etag = `"${createHash('sha256').update(text).digest('hex')}"`;
    const unchanged = request.headers['if-none-match'] === etag;
    observed.status = unchanged ? 304 : 200;
    response.writeHead(observed.status, { etag }); response.end(unchanged ? undefined : text);
  });
  setGitHubFetchImplForTest((url, args) => {
    const remote = new URL(url); return fetch(origin + remote.pathname + remote.search, args);
  });
  const store = new GitHubStateStore({ repository, token: 'fixture-reader', writers: ['factory-bot'],
    stateDir: process.cwd(), ghClient: { ...github, listIssueComments: args => github.listIssueComments({ ...args, perPage: 4 }) } });
  const result = await store.readRecord(number);
  assert.equal(result.latest.hash, second.hash);
  assert.deepEqual(result.comments.map(comment => comment.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(requests.map(({ page, size }) => [page, size]), [[1, 4], [2, 4], [1, 2], [2, 2], [3, 2], [4, 2]],
    'One body deadline changes the page size, without four identical oversized retries or history gaps');
  const previous = requests.length;
  assert.equal((await store.readRecord(number)).latest.hash, second.hash);
  assert.deepEqual(requests.slice(previous).map(request => [request.size, request.status]), [[2, 304], [2, 304], [2, 304], [2, 304]]);
  for (const changed of [{ token: 'another-reader', number }, { token: 'fixture-reader', number: 2 }]) {
    const start = requests.length;
    await github.listIssueComments({ repository, perPage: 4, ...changed });
    assert.equal(requests[start].size, 4, 'Adaptive page hints must be isolated by credential and issue');
  }
  forbidden = true;
  const beforeForbidden = requests.length;
  await assert.rejects(store.readRecord(number), { status: 403, transient: false });
  assert.equal(requests.length, beforeForbidden + 1, 'Permission failures must neither shrink nor use cached history');
  forbidden = false;
  rows[0].body = 'Edited business input';
  assert.equal((await store.readRecord(number)).comments[0].body, rows[0].body);
  rows.splice(5, 1);
  await assert.rejects(store.readRecord(number), /missing parent/);
});

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

test('large paged histories retain lossless validators without UTF-16 scan eviction', async t => {
  const payload = JSON.stringify([{ body: randomBytes(768 * 1024).toString('base64').repeat(3), value: '反证保留' }]);
  const seen = [];
  const origin = await serverFor(t, (request, response) => {
    const supplied = request.headers['if-none-match'];
    seen.push(supplied);
    response.writeHead(supplied ? 304 : 200, { etag: '"history"' });
    response.end(supplied ? undefined : payload);
  });
  for (let round = 0; round < 2; round++) {
    for (let page = 1; page <= 6; page++) {
      const result = await _test_getWithRetry(`${origin}/page-${page}`, { ...options, timeoutMs: 10000 });
      assert.equal(JSON.stringify(result), payload, 'Compression cannot change the actual evidence');
      result[0].value = 'Caller mutation';
    }
  }
  assert.deepEqual(seen.slice(0, 6), Array(6).fill(undefined));
  assert.deepEqual(seen.slice(6), Array(6).fill('"history"'), 'An 18 MiB history must not evict every page on sequential revalidation');
});

test('conditional history memory is bounded and eviction performs a full remote read', async t => {
  const opaqueBlock = randomBytes(1024 * 1024).toString('base64');
  let payload = JSON.stringify(opaqueBlock.repeat(18));
  const seen = [];
  const origin = await serverFor(t, (request, response) => {
    seen.push(request.headers['if-none-match']);
    response.writeHead(200, { etag: '"large"' }); response.end(payload);
  });
  for (const suffix of ['/one', '/two', '/one']) await _test_getWithRetry(origin + suffix, { ...options, timeoutMs: 10000 });
  assert.equal(seen.at(-1), undefined, 'Two representations exceeding the budget evict the least recently validated page');
  payload = JSON.stringify(opaqueBlock.repeat(34));
  for (let index = 0; index < 2; index++) await _test_getWithRetry(origin + '/oversized', { ...options, timeoutMs: 10000 });
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
    if (url.pathname.includes('/git/ref/')) { response.writeHead(404); response.end('{}'); return; }
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

test('a lost state ref response is reconciled against current remote authority without rewriting legacy pages', async t => {
  const repository = 'local/conditional-save', number = 1;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-conditional-save-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('factory-conditional-save-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const first = encodeState({ version: 1, repository, issueNumber: number, revision: 1, parentHash: null,
    snapshot: { issue: { number }, revision: 1, merged: false } });
  const rows = [{ id: 1, user: { login: 'factory-bot' }, body: first.body }];
  let publications = 0, revalidated = 0, stateSha = null, commentPosts = 0, leaseOutage = false;
  const commits = new Map(), blobs = new Map();
  const origin = await serverFor(t, async (request, response) => {
    const url = decodeURIComponent(new URL(request.url, 'http://fixture').pathname);
    if (url.includes('/git/ref/')) {
      if (leaseOutage && url.includes('/factory/leases/')) { request.socket.destroy(); return; }
      const sha = url.includes('/factory/state/') ? stateSha : 'fixture-lease';
      response.writeHead(sha ? 200 : 404); response.end(JSON.stringify(sha ? { object: { sha } } : {})); return;
    }
    if (request.method === 'GET' && url.includes('/git/commits/')) {
      response.end(JSON.stringify(commits.get(url.split('/').at(-1)))); return;
    }
    if (request.method === 'GET' && url.includes('/git/blobs/')) {
      const content = blobs.get(url.split('/').at(-1));
      response.end(JSON.stringify({ content: Buffer.from(content).toString('base64'), encoding: 'base64', size: Buffer.byteLength(content) })); return;
    }
    if (request.method === 'PATCH' && url.includes('/git/refs/')) {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      assert.equal(input.force, false);
      assert.equal(commits.get(input.sha).parents[0].sha, stateSha);
      stateSha = input.sha;
      publications++;
      response.end('{}'); return;
    }
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (url.endsWith('/git/trees')) {
        const sha = createHash('sha1').update(input.tree[0].content).digest('hex');
        blobs.set(sha, input.tree[0].content);
        response.end(JSON.stringify({ sha: 'state-tree', tree: [{ path: 'state.json', sha }] })); return;
      }
      if (url.endsWith('/git/commits')) {
        const sha = `state-${commits.size + 1}`;
        commits.set(sha, { message: input.message, tree: { sha: input.tree }, parents: input.parents.map(sha => ({ sha })) });
        response.end(JSON.stringify({ sha })); return;
      }
      if (url.endsWith('/git/refs')) {
        if (stateSha) { response.writeHead(422); response.end('{}'); return; }
        stateSha = input.sha; publications++;
        request.socket.destroy(); // The ref advances remotely, but its response is lost.
        return;
      }
      commentPosts++;
      response.writeHead(500); response.end('{}'); return;
    }
    const text = JSON.stringify(rows), etag = `"${createHash('sha256').update(text).digest('hex')}"`;
    const unchanged = request.headers['if-none-match'] === etag;
    if (unchanged) revalidated++;
    response.writeHead(unchanged ? 304 : 200, { etag }); response.end(unchanged ? undefined : text);
  });
  setGitHubFetchImplForTest((url, args) => {
    const remote = new URL(url); return fetch(origin + remote.pathname + remote.search, args);
  });
  const store = new GitHubStateStore({ repository, token: 'fixture-reader', stateDir: directory,
    leaseSha: 'fixture-lease', writers: ['factory-bot'] });
  await store.readRecord(number);
  const state = structuredClone(first.envelope.snapshot);
  state.status = 'waiting';
  await store.save(state);
  assert.equal(publications, 1, 'Lost response reconciliation must not duplicate an already confirmed ref publication');
  assert.equal(commentPosts, 0);
  assert.equal(rows.length, 1, 'Legacy recovery comments remain untouched');
  assert.ok(revalidated > 0, 'The old page was genuinely cached and remotely revalidated before the write');
  assert.equal(state.revision, 2);
  assert.equal((await store.readRecord(number)).latest.envelope.revision, 2);
  await assert.rejects(fs.access(path.join(directory, 'recover', '1.json')), { code: 'ENOENT' });

  // Exercise the same pre-upload failure as the production worker, through real HTTP.
  state.implementation = { commitSha: 'a'.repeat(40), behaviorVerification: {
    status: 'not-verified', notes: 'Completed observations must survive a state outage', checks: [],
  } };
  leaseOutage = true;
  await assert.rejects(store.save(state));
  assert.equal(state.revision, 2);
  const journal = JSON.parse(await fs.readFile(path.join(directory, 'recover', '1.json'), 'utf8'));
  assert.deepEqual(journal.envelope.snapshot.implementation, state.implementation);
  await assert.rejects(store.readRecord(number).then(() => store.assertLease(number)),
    'Unavailable live lease cannot be replaced with a cached observation');
  leaseOutage = false;
  const restarted = new GitHubStateStore({ repository, token: 'fixture-reader', stateDir: directory,
    leaseSha: 'fixture-lease', writers: ['factory-bot'] });
  assert.deepEqual(await restarted.recover(number), { recovered: true, revision: 3 });
  assert.deepEqual((await restarted.readRecord(number)).latest.envelope.snapshot.implementation, state.implementation);
  assert.equal(publications, 2);
  assert.deepEqual(await restarted.recover(number), { recovered: false });
  assert.equal(commentPosts, 0);
});
