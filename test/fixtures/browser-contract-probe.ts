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
if (!url) throw new Error('Usage: browser-contract-probe <isolated-app-url> [reuse|navigation|all|causal]');
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
    const opened = await call({ action: 'open', url: login }) as any;
    if (mode === 'causal') {
      const register = request.tools!.find(tool => tool.name === 'record_acceptance_check')!;
      assert.equal(opened.kind, 'browser-action');
      await assert.rejects(register.execute({ criterion: 'An action alone is not an outcome', requirementIds: [], receiptIds: [opened.id] }, context));
      const location = await call({ action: 'assert_url', value: '/login' }) as any;
      assert.equal(location.passed, true, 'A live route needs an actual URL assertion receipt');
      assert.equal(location.detail.previousReceiptId, opened.id);
      await register.execute({ criterion: 'Observed requested route', requirementIds: [], receiptIds: [opened.id, location.id] }, context);
      const absent = await call({ action: 'assert_not_visible', selector: '[data-testid="auth-user"]' }) as { passed: boolean };
      assert.equal(absent.passed, true, 'Logged-out UI needs a real negative assertion');
      const wrongUrl = await call({ action: 'assert_url', value: '/unexpected-route' }) as any;
      assert.equal(wrongUrl.passed, false);
      assert.equal(new URL(wrongUrl.detail.actual).pathname, '/login', 'Assertions must not navigate to manufacture evidence');
      await assert.rejects(call({ action: 'assert_visible', url: new URL('/register', url).href, selector: '#register-username' }), /Only open may navigate/);
      const notAbsent = await call({ action: 'assert_not_visible', selector: '#login-username' }) as any;
      assert.equal(notAbsent.passed, false);
      console.log('Positive/negative route assertions, scene preservation and action-only rejection passed');
      const guarded = await call({ action: 'open', url: new URL('/kanban', url).href }) as any;
      assert.equal(guarded.detail.requestedUrl, new URL('/kanban', url).href);
      assert.equal((await call({ action: 'assert_url', value: '/login' }) as any).passed, true);
      await call({ action: 'fill', selector: '#login-username', value: 'demo' });
      const filled = await call({ action: 'fill', selector: '#login-password', value: '123456' }) as any;
      assert.equal(filled.detail.value, undefined, 'Fill values never enter public action receipts');
      const secret = await call({ action: 'assert_value', selector: '#login-password', value: '123456' }) as any;
      assert.equal(secret.passed, true);
      assert.equal(secret.detail.valueRedacted, true);
      assert.equal(secret.detail.actual, '[REDACTED]');
      const clicked = await call({ action: 'click', selector: '[data-testid="login-submit"]' }) as any;
      const returned = await call({ action: 'assert_url', value: '/kanban' }) as any;
      assert.equal(returned.passed, true);
      assert.equal(returned.detail.previousReceiptId, clicked.id);
      assert.equal(returned.detail.browserSessionId, guarded.detail.browserSessionId);
      assert.equal((await call({ action: 'assert_not_visible', selector: '#login-username' }) as any).passed, true);
      const signedOut = await call({ action: 'click', selector: '[data-testid="logout-button"]' }) as any;
      const loginAgain = await call({ action: 'assert_url', value: '/login' }) as any;
      assert.equal(loginAgain.passed, true);
      assert.equal(loginAgain.detail.previousReceiptId, signedOut.id);
      assert.equal((await call({ action: 'assert_not_visible', selector: '[data-testid="auth-user"]' }) as any).passed, true);
      await call({ action: 'open', url: new URL('/kanban', url).href });
      assert.equal((await call({ action: 'assert_url', value: '/login' }) as any).passed, true);
      console.log('Login return path, logout, session-ended guard and linked action/assertion receipts passed');
    }
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
  const result = await new VerifyBehaviorAgent(ctx, 'reproduce').run();
  if (mode === 'causal') {
    const bytes = await fs.readFile(result.receiptPath!, 'utf8');
    assert.ok(!bytes.includes('123456'), 'Public receipt registry must not persist password values');
    const registry = JSON.parse(bytes);
    registry.receipts.forEach((receipt: any, index: number) => {
      assert.equal(receipt.detail.sequence, index + 1);
      assert.equal(receipt.detail.previousReceiptId, index ? registry.receipts[index - 1].id : undefined);
    });
    console.log(JSON.stringify({ browserReceipts: registry.receipts.length, orderedChain: true, passwordRedacted: true,
      remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
  }
} finally {
  AgentRuntimeImpl.prototype.runStage = original;
  assert.equal(path.dirname(workdir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(workdir).startsWith('factory-browser-contract-'));
  await fs.rm(workdir, { recursive: true, force: true });
}
