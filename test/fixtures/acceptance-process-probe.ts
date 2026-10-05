// Opt-in probe against a dedicated real project checkout; no acceptance claim.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntimeImpl } from '../../src/core/agent-runtime.js';
import { VerifyBehaviorAgent } from '../../src/agents/verify-behavior.js';
import type { AgentContext } from '../../src/core/types.js';

const [workdir] = process.argv.slice(2);
if (!workdir) throw new Error('Usage: acceptance-process-probe <dedicated-project-checkout>');
process.env.FACTORY_TYPESAFE_OFF = '1';
process.env.FACTORY_TRUSTED_EXECUTION = '1';
process.env.FACTORY_VERIFY_COMMAND = '';
const original = AgentRuntimeImpl.prototype.runStage;
const ctx = { repo: { owner: 'local', name: 'process-probe', defaultBranch: 'main', workdir: path.resolve(workdir) },
  issue: { number: 1, title: 'Acceptance executor diagnosis', body: 'Tool contract probe, not product acceptance.',
    labels: [], comments: [], author: 'probe', url: '', createdAt: '' },
  logger: { info() {}, warn() {}, error() {}, child() { return this; } },
  skills: [], skillsRoot: workdir, runId: randomUUID(),
} satisfies AgentContext;
try {
  AgentRuntimeImpl.prototype.runStage = async (request, context) => {
    const tool = request.tools!.find(item => item.name === 'run_acceptance_test')!;
    const result = await tool.execute({ program: 'npm', args: ['test'], cwd: 'template' }, context) as { passed: boolean; detail: { exitCode: number; stdout: string; stderr: string } };
    console.log(JSON.stringify({ passed: result.passed, exitCode: result.detail.exitCode, output: result.detail.stdout.slice(-1800) }));
    assert.equal(result.passed, true);
    const failure = await tool.execute({ program: 'node', args: ['-e', 'process.exit(7)'], cwd: 'template' }, context) as { passed: boolean; detail: { exitCode: number } };
    assert.equal(failure.passed, false);
    assert.equal(failure.detail.exitCode, 7);
    await assert.rejects(tool.execute({ program: 'node', args: ['-e', 'process.exit(0)'], cwd: '..' }, context));
    console.log('Nonzero exit receipt and escaping cwd rejection passed');
    return { status: 'succeeded', output: JSON.stringify({ status: 'not-reproduced', channel: 'browser',
      notes: 'Local executor probe only; no product acceptance claim.', checks: [] }),
      usage: null, backend: 'claude-code', warnings: [], retryable: false };
  };
  await new VerifyBehaviorAgent(ctx, 'reproduce').run();
} finally {
  AgentRuntimeImpl.prototype.runStage = original;
}
