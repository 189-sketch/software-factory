// Opt-in real target application probe, not formal issue acceptance or a GitHub write.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntimeImpl } from '../../src/core/agent-runtime.js';
import { VerifyBehaviorAgent } from '../../src/agents/verify-behavior.js';
import type { AgentContext } from '../../src/core/types.js';

const [workdir] = process.argv.slice(2);
if (!workdir) throw new Error('Usage: service-browser-probe <isolated-target-checkout>');
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-service-browser-'));
const original = AgentRuntimeImpl.prototype.runStage;
Object.assign(process.env, { FACTORY_TRUSTED_EXECUTION: '1', FACTORY_TYPESAFE_OFF: '1', FACTORY_VERIFY_COMMAND: '', FACTORY_VERIFY_URL: '' });
const context = { repo: { owner: 'local', name: 'service-browser-probe', defaultBranch: 'main', workdir: path.resolve(workdir) },
  issue: { number: 1, title: 'Managed application tool probe', body: 'Local diagnosis, not formal acceptance.',
    labels: [], comments: [], author: 'probe', url: '', createdAt: '' },
  skills: [], skillsRoot: workdir, runId: randomUUID(), artifactStateDir: stateDir, commandTimeoutMs: 30_000,
  logger: { info() {}, warn() {}, error() {}, child() { return this; } } } satisfies AgentContext;
let applicationUrl = '';
try {
  AgentRuntimeImpl.prototype.runStage = async (request, ctx) => {
    const tools = request.tools!;
    const service = await tools.find(tool => tool.name === 'start_service')!.execute({ program: 'npm',
      args: ['run', 'start', '--', '--host', '127.0.0.1', '--port', '{port}', '--strictPort'],
      cwd: 'template', url: 'http://127.0.0.1:0' }, ctx) as any;
    assert.equal(service.passed, true, JSON.stringify(service.detail));
    applicationUrl = service.url;
    const register = tools.find(tool => tool.name === 'record_acceptance_check')!;
    await assert.rejects(register.execute({ criterion: 'Startup is not business proof', requirementIds: [], receiptIds: [service.id] }, ctx));
    const browser = tools.find(tool => tool.name === 'browser')!;
    const call = (args: Record<string, unknown>) => browser.execute(args, ctx) as Promise<any>;
    await call({ action: 'open', url: new URL('/kanban', applicationUrl).href });
    assert.equal((await call({ action: 'assert_url', value: '/login' })).passed, true);
    assert.equal((await call({ action: 'assert_visible', selector: '#login-username' })).passed, true);
    await call({ action: 'click', selector: '[data-testid="login-to-register"]' });
    assert.equal((await call({ action: 'assert_url', value: '/register' })).passed, true);
    assert.equal((await call({ action: 'assert_visible', selector: '#register-username' })).passed, true);
    return { status: 'succeeded', output: JSON.stringify({ status: 'not-reproduced', channel: 'browser',
      notes: 'Managed service and actual UI probe, not acceptance approval.', checks: [] }),
      usage: null, backend: 'claude-code', warnings: [], retryable: false };
  };
  const result = await new VerifyBehaviorAgent(context, 'reproduce').run();
  const registry = JSON.parse(await fs.readFile(result.receiptPath!, 'utf8'));
  assert.deepEqual(registry.receipts.filter((receipt: any) => receipt.kind === 'service-action')
    .map((receipt: any) => [receipt.detail.action, receipt.passed]), [['start', true], ['stop', true]]);
  let alive = false;
  try { alive = (await fetch(applicationUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
  assert.equal(alive, false, 'The npm launcher and Vite application must both be cleaned up');
  console.log(JSON.stringify({ actualTargetApplication: true, dynamicPort: true, browserAssertions: 4,
    ownedStartup: true, serviceStoppedAfterVerification: true, remoteWrites: 0, productAcceptance: 'not-claimed' }));
} finally {
  AgentRuntimeImpl.prototype.runStage = original;
  assert.equal(path.dirname(stateDir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(stateDir).startsWith('factory-service-browser-'));
  await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
