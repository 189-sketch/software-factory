import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { _test_getWithRetry, closeSharedAgent } from '../../runtime/github-rest.mjs';

test('GitHub GET retries malformed JSON without treating it as remote state', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(requests === 1 ? '{broken' : '[]');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    assert.deepEqual(await _test_getWithRetry(`http://127.0.0.1:${port}`, { token: 'test', maxRetries: 1 }), []);
    assert.equal(requests, 2);
  } finally {
    closeSharedAgent();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('GitHub GET fails closed on exhausted invalid JSON and does not echo response contents', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('private-response-content');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await assert.rejects(_test_getWithRetry(`http://127.0.0.1:${port}`, { token: 'test', maxRetries: 0 }),
      { message: 'GitHub API returned invalid JSON', transient: true });
  } finally {
    closeSharedAgent();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
