// Opt-in real-browser probe. Only the model driver is replaced; tools and UI are real.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntimeImpl } from '../../src/core/agent-runtime.js';
import { VerifyBehaviorAgent } from '../../src/agents/verify-behavior.js';
import type { AgentContext } from '../../src/core/types.js';

const [url, mode = 'reuse'] = process.argv.slice(2);
if (!url) throw new Error('Usage: browser-contract-probe <isolated-app-url> [reuse|navigation|all]');
const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-browser-contract-'));
const original = AgentRuntimeImpl.prototype.runStage;
process.env.FACTORY_TYPESAFE_OFF = '1';
process.env.FACTORY_VERIFY_COMMAND = '';
process.env.FACTORY_VERIFY_URL = '';
const ctx = {
  repo: { owner: 'local', name: 'browser-probe', defaultBranch: 'main', workdir },
  issue: { number: 48, title: 'Browser tool contract probe', body: 'Local tool diagnosis, not issue acceptance.',
    labels: [], comments: [], author: 'probe', url: '', createdAt: '' },
  logger: { info() {}, warn() {}, error() {}, child() { return this; } },
  skills: [], skillsRoot: workdir, runId: randomUUID(),
} satisfies AgentContext;
try {
  AgentRuntimeImpl.prototype.runStage = async (request, context) => {
    const browser = request.tools!.find(tool => tool.name === 'browser')!;
    const call = (args: Record<string, unknown>) => browser.execute(args, context);
    const eventual = async (args: Record<string, unknown>) => {
      const deadline = Date.now() + 5000;
      let receipt: { passed: boolean; detail: { url: string } };
      do {
        receipt = await call(args) as typeof receipt;
        if (receipt.passed) return receipt;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.fail(`Application assertion did not settle: ${JSON.stringify(receipt)}`);
    };
    const login = new URL('/login', url).href;
    await call({ action: 'open', url: login });
    if (mode === 'navigation' || mode === 'all') {
      await call({ action: 'click', url: login, selector: '[data-testid="login-to-register"]' });
      await call({ action: 'open', url: login });
      const receipt = await call({ action: 'assert_text', url: login, selector: 'h1', value: '登录' }) as { passed: boolean };
      assert.equal(receipt.passed, true, 'Explicit open must navigate back after a link changes the page');
      console.log('Explicit reopen passed');
    }
    if (mode === 'reuse' || mode === 'all') {
      await call({ action: 'fill', selector: '#login-username', value: 'demo' });
      console.log('Omitted URL reuse passed');
    }
    if (mode === 'all') {
      const value = await call({ action: 'assert_value', selector: '#login-username', value: 'demo' }) as { passed: boolean };
      assert.equal(value.passed, true);
      const wrong = await call({ action: 'assert_value', selector: '#login-username', value: 'wrong' }) as { passed: boolean };
      assert.equal(wrong.passed, false);
      const contains = await call({ action: 'assert_text_contains', selector: 'body', value: '登录' }) as { passed: boolean };
      assert.equal(contains.passed, true);
      const exact = await call({ action: 'assert_text', selector: 'body', value: '登录' }) as { passed: boolean };
      assert.equal(exact.passed, false, 'Exact text must not silently become substring matching');
      console.log('Explicit value/substring assertions and exact-match rejection passed');
      await call({ action: 'open', url: new URL('/kanban', url).href });
      await call({ action: 'fill', selector: '#login-username', value: 'demo' });
      await call({ action: 'fill', selector: '#login-password', value: '123456' });
      await call({ action: 'click', selector: '[data-testid="login-submit"]' });
      const kanban = await eventual({ action: 'assert_text', selector: 'h1', value: 'Kanban' });
      assert.equal(kanban.passed, true);
      assert.equal(new URL(kanban.detail.url).pathname, '/kanban');
      await call({ action: 'open', url: login });
      const session = await eventual({ action: 'assert_text', selector: '[data-testid="auth-user"]', value: 'demo' });
      assert.equal(session.passed, true);
      assert.equal(new URL(session.detail.url).pathname, '/', 'Application guest guard must retain its own redirect');
      console.log('Login return path, application redirect and actual receipt URL passed');
    }
    return { status: 'succeeded', output: JSON.stringify({ status: 'not-reproduced', channel: 'browser',
      notes: 'Local browser tool contract probe only; no product acceptance claim.', checks: [] }),
    usage: null, backend: 'claude-code', warnings: [], retryable: false };
  };
  await new VerifyBehaviorAgent(ctx, 'reproduce').run();
} finally {
  AgentRuntimeImpl.prototype.runStage = original;
  assert.equal(path.dirname(workdir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(workdir).startsWith('factory-browser-contract-'));
  await fs.rm(workdir, { recursive: true, force: true });
}
