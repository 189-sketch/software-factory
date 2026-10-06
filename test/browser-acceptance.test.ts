import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntimeImpl } from '../src/core/agent-runtime.js';
import { VerifyBehaviorAgent } from '../src/agents/verify-behavior.js';
import type { AgentContext } from '../src/core/types.js';
import { BROWSER_ACTIONS, VERIFICATION_CAPABILITY_HASH } from '../runtime/verification-capabilities.mjs';

// Only the model driver is replaced. Production tools, Chromium, HTTP and receipt storage are real.
test('browser acceptance observes causal behavior without changing the scene or leaking passwords', { timeout: 90_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-browser-ci-'));
  const original = AgentRuntimeImpl.prototype.runStage;
  const values = { FACTORY_TYPESAFE_OFF: '1', FACTORY_VERIFY_COMMAND: '', FACTORY_VERIFY_URL: '' };
  const previous = Object.keys(values).map(key => process.env[key]);
  Object.assign(process.env, values);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === '/guard') {
      response.writeHead(302, { Location: '/before' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body>
      <input id="field"><input id="secret" type="password">
      <p id="result">old</p><button id="update">Update</button><button id="navigate">Navigate</button>
      <script>
        document.querySelector('#update').onclick = () => setTimeout(() => {
          document.querySelector('#result').textContent = 'new value';
        }, 200);
        document.querySelector('#navigate').onclick = () => setTimeout(() => {
          history.pushState({}, '', '/after?x=1#fragment');
          document.querySelector('#field').hidden = true;
        }, 200);
      </script>
    </body></html>`);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const ctx = {
      repo: { owner: 'local', name: 'browser-ci', defaultBranch: 'main', workdir: root },
      issue: { number: 1, title: 'Browser tool contract', body: 'Local tool contract, not product acceptance.',
        labels: [], comments: [], author: 'fixture', url: '', createdAt: '' },
      logger: { info() {}, warn() {}, error() {}, child() { return this; } },
      skills: [], skillsRoot: root, runId: randomUUID(), artifactStateDir: path.join(root, 'state'),
    } satisfies AgentContext;
    AgentRuntimeImpl.prototype.runStage = async (request, context) => {
      const browser = request.tools!.find(tool => tool.name === 'browser')!;
      assert.deepEqual((browser.inputSchema!.properties as any).action.enum, BROWSER_ACTIONS);
      const register = request.tools!.find(tool => tool.name === 'record_acceptance_check')!;
      const call = async (args: Record<string, unknown>) => browser.execute(args, context) as Promise<{
        id: string; kind: string; passed: boolean; detail: Record<string, unknown>;
      }>;
      await assert.rejects(call({ action: 'assert_url', value: '/before' }), /call open first/);
      await assert.rejects(call({ action: 'open', url: 'file:///forbidden' }), /HTTP\(S\)/);
      const opened = await call({ action: 'open', url: `${origin}/guard` });
      assert.equal(opened.kind, 'browser-action');
      assert.equal(opened.detail.requestedUrl, `${origin}/guard`);
      assert.equal(opened.detail.url, `${origin}/before`);
      await assert.rejects(register.execute({ criterion: 'Action is not an outcome', requirementIds: [], receiptIds: [opened.id] }, context));
      const location = await call({ action: 'assert_url', value: '/before' });
      assert.equal(location.passed, true);
      assert.equal(location.detail.actual, `${origin}/before`);
      assert.equal(location.detail.previousReceiptId, opened.id);
      await register.execute({ criterion: 'Observed redirect', requirementIds: [], receiptIds: [opened.id, location.id] }, context);

      await assert.rejects(call({ action: 'assert_text', url: `${origin}/forbidden`, selector: '#result', value: 'old' }), /Only open may navigate/);
      await assert.rejects(call({ action: 'unknown', url: `${origin}/forbidden` }), /Invalid browser request/);
      await assert.rejects(call({ action: 'fill', selector: '#field' }), /requires a string value/);
      assert.ok(!requests.includes('/forbidden'), 'Invalid requests must not navigate');
      assert.equal((await call({ action: 'assert_url', value: `${origin}/before` })).passed, true);
      assert.equal((await call({ action: 'assert_visible', selector: '#field' })).passed, true);
      await call({ action: 'fill', selector: '#field', value: 'hello' });
      assert.equal((await call({ action: 'assert_value', selector: '#field', value: 'hello' })).passed, true);
      const filled = await call({ action: 'fill', selector: '#secret', value: 'private-password' });
      assert.ok(!JSON.stringify(filled).includes('private-password'));
      const secret = await call({ action: 'assert_value', selector: '#secret', value: 'private-password' });
      assert.equal(secret.passed, true);
      assert.equal(secret.detail.expected, '[REDACTED]');
      assert.equal(secret.detail.actual, '[REDACTED]');
      assert.equal(secret.detail.valueRedacted, true);

      const update = await call({ action: 'click', selector: '#update' });
      const text = await call({ action: 'assert_text', selector: '#result', value: 'new value' });
      assert.equal(text.passed, true, 'Assertions must wait for actual asynchronous UI updates');
      assert.equal(text.detail.previousReceiptId, update.id);
      assert.equal((await call({ action: 'assert_text_contains', selector: '#result', value: 'new' })).passed, true);
      const exact = await call({ action: 'assert_text', selector: '#result', value: 'new' });
      assert.equal(exact.passed, false, 'Exact text must not become a substring assertion');
      assert.equal(exact.detail.actual, 'new value');
      await assert.rejects(register.execute({ criterion: 'Wrong assertion', requirementIds: [], receiptIds: [exact.id] }, context));
      await register.execute({ criterion: 'Observed mismatch', requirementIds: [], receiptIds: [exact.id], passed: false }, context);

      const navigation = await call({ action: 'click', selector: '#navigate' });
      const changed = await call({ action: 'assert_url', value: '/after?x=1#fragment' });
      assert.equal(changed.passed, true);
      assert.equal(changed.detail.previousReceiptId, navigation.id);
      assert.equal(changed.detail.browserSessionId, navigation.detail.browserSessionId);
      assert.equal((await call({ action: 'assert_not_visible', selector: '#field' })).passed, true);
      const visible = await call({ action: 'assert_not_visible', selector: '#result' });
      assert.equal(visible.passed, false);
      assert.equal(visible.detail.actual, true);
      const wrongUrl = await call({ action: 'assert_url', value: '/after?x=2#fragment' });
      assert.equal(wrongUrl.passed, false, 'URL assertions must include query and hash');
      assert.equal(wrongUrl.detail.actual, `${origin}/after?x=1#fragment`);
      const reopened = await call({ action: 'open', url: `${origin}/before` });
      assert.equal(reopened.detail.beforeUrl, `${origin}/after?x=1#fragment`);
      assert.equal((await call({ action: 'assert_url', value: '/before' })).passed, true);
      return { status: 'succeeded', output: JSON.stringify({ status: 'not-reproduced', channel: 'browser',
        notes: 'Tool contract only; no product acceptance claim.', checks: [] }),
        usage: null, backend: 'claude-code', warnings: [], retryable: false };
    };
    const result = await new VerifyBehaviorAgent(ctx, 'reproduce').run();
    assert.ok(result.receiptPath);
    const bytes = await fs.readFile(result.receiptPath, 'utf8');
    assert.ok(!bytes.includes('private-password'), 'Persisted receipts must redact passwords');
    const registry = JSON.parse(bytes);
    assert.equal(registry.runId, ctx.runId);
    assert.equal(result.executionCapabilities, VERIFICATION_CAPABILITY_HASH);
    assert.equal(registry.executionCapabilities, result.executionCapabilities);
    assert.equal(registry.receipts.length, 19, 'Invalid calls must not issue success receipts');
    registry.receipts.forEach((receipt: any, index: number) => {
      assert.equal(receipt.detail.sequence, index + 1);
      assert.equal(receipt.detail.browserSessionId, registry.receipts[0].detail.browserSessionId);
      assert.equal(receipt.detail.previousReceiptId, index ? registry.receipts[index - 1].id : undefined);
    });
  } finally {
    AgentRuntimeImpl.prototype.runStage = original;
    Object.keys(values).forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-browser-ci-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('verification owns a live service through browser assertions and cleans up even on generation failure', { timeout: 60_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-browser-service-ci-'));
  const original = AgentRuntimeImpl.prototype.runStage;
  const values = { FACTORY_TRUSTED_EXECUTION: '1', FACTORY_TYPESAFE_OFF: '1', FACTORY_VERIFY_COMMAND: '', FACTORY_VERIFY_URL: '' };
  const previous = Object.keys(values).map(key => process.env[key]);
  Object.assign(process.env, values);
  const html = '<!doctype html><p id="result">before</p><button id="update" onclick="document.getElementById(\'result\').textContent=\'after\'">Update</button>';
  const code = `require('node:http').createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end(${JSON.stringify(html)});}).listen(Number(process.argv[1]),'127.0.0.1');`;
  const ctx = { repo: { owner: 'local', name: 'browser-service-ci', defaultBranch: 'main', workdir: root },
    issue: { number: 1, title: 'Application lifecycle', body: 'Tool contract only.', labels: [], comments: [], author: 'fixture', url: '', createdAt: '' },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } }, skills: [], skillsRoot: root,
    runId: randomUUID(), artifactStateDir: path.join(root, 'state'), commandTimeoutMs: 30_000 } satisfies AgentContext;
  let origin = '';
  try {
    for (const failGeneration of [false, true]) {
      ctx.runId = randomUUID();
      AgentRuntimeImpl.prototype.runStage = async (request, context) => {
        const start = request.tools!.find(tool => tool.name === 'start_service')!;
        const register = request.tools!.find(tool => tool.name === 'record_acceptance_check')!;
        const failed = await start.execute({ program: 'node', args: ['-e', 'process.exit(17);', '{port}'], url: 'http://127.0.0.1:0' }, context) as any;
        assert.equal(failed.passed, false);
        for (const passed of [false, true]) {
          await assert.rejects(register.execute({ criterion: 'Startup cannot prove or disprove a business AC', requirementIds: [], passed, receiptIds: [failed.id] }, context));
        }
        const service = await start.execute({ program: 'node', args: ['-e', code, '{port}'], url: 'http://127.0.0.1:0' }, context) as any;
        assert.equal(service.passed, true, JSON.stringify(service.detail));
        origin = service.url;
        await assert.rejects(register.execute({ criterion: 'Startup alone', requirementIds: [], receiptIds: [service.id] }, context));
        if (failGeneration) throw new Error('generation-failed-after-owned-service-ready');
        const browser = request.tools!.find(tool => tool.name === 'browser')!;
        await browser.execute({ action: 'open', url: origin }, context);
        const clicked = await browser.execute({ action: 'click', selector: '#update' }, context) as any;
        const observed = await browser.execute({ action: 'assert_text', selector: '#result', value: 'after' }, context) as any;
        assert.equal(observed.passed, true);
        await register.execute({ criterion: 'Observed action outcome', requirementIds: [], receiptIds: [clicked.id, observed.id] }, context);
        return { status: 'succeeded', output: JSON.stringify({ status: 'not-reproduced', channel: 'browser', notes: 'Tool contract only.', checks: [] }),
          usage: null, backend: 'claude-code', warnings: [], retryable: false };
      };
      const agent = new VerifyBehaviorAgent(ctx, 'reproduce');
      if (failGeneration) await assert.rejects(agent.run(), /generation-failed-after-owned-service-ready/);
      else {
        const result = await agent.run();
        const registry = JSON.parse(await fs.readFile(result.receiptPath!, 'utf8'));
        assert.deepEqual(registry.receipts.filter((receipt: any) => receipt.kind === 'service-action')
          .map((receipt: any) => [receipt.detail.action, receipt.passed]), [['start', false], ['stop', true], ['start', true], ['stop', true]]);
      }
      let alive = false;
      try { alive = (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      assert.equal(alive, false, 'Finally must stop the owned service after success or error');
    }
  } finally {
    AgentRuntimeImpl.prototype.runStage = original;
    Object.keys(values).forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-browser-service-ci-'));
    // Windows can briefly retain cwd handles after process termination; listener cleanup is asserted above.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
