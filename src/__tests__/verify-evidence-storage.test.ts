import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AgentRuntimeImpl } from '../core/agent-runtime.js';
import { VerifyBehaviorAgent } from '../agents/verify-behavior.js';
import type { AgentContext } from '../core/types.js';

test('real verification tool writes receipt registry without dirtying the product checkout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-verify-storage-'));
  const exec = promisify(execFile);
  const workdir = path.join(root, 'project');
  await fs.mkdir(workdir);
  await exec('git', ['init', '-b', 'main'], { cwd: workdir });
  const original = AgentRuntimeImpl.prototype.runStage;
  const keys = ['FACTORY_TYPESAFE_OFF', 'FACTORY_TRUSTED_EXECUTION', 'FACTORY_VERIFY_COMMAND'] as const;
  const previous = keys.map(key => process.env[key]);
  process.env.FACTORY_TYPESAFE_OFF = '1';
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  process.env.FACTORY_VERIFY_COMMAND = '';
  const ctx = { repo: { owner: 'local', name: 'probe', defaultBranch: 'main', workdir },
    issue: { number: 1, title: 'Storage diagnostic', body: '', labels: [], comments: [], author: 'probe', url: '', createdAt: '' },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    skills: [], skillsRoot: workdir, runId: randomUUID(), artifactStateDir: path.join(root, 'runtime'),
  } satisfies AgentContext;
  try {
    AgentRuntimeImpl.prototype.runStage = async (request, context) => {
      const tool = request.tools!.find(item => item.name === 'run_acceptance_test')!;
      const receipt = await tool.execute({ program: 'node', args: ['-e', 'console.log("actual execution")'] }, context) as any;
      assert.equal(receipt.passed, true);
      return { status: 'succeeded', output: JSON.stringify({ status: 'not-reproduced', channel: 'browser', notes: 'Storage only.', checks: [] }),
        usage: null, backend: 'claude-code', warnings: [], retryable: false };
    };
    const result = await new VerifyBehaviorAgent(ctx, 'reproduce').run();
    assert.ok(result.receiptPath!.startsWith(path.join(root, 'runtime') + path.sep));
    const stored = JSON.parse(await fs.readFile(result.receiptPath!, 'utf8'));
    assert.equal(stored.runId, ctx.runId);
    assert.equal(stored.issue, 1);
    assert.equal(stored.receipts.length, 1);
    assert.equal(stored.receipts[0].detail.stdout.trim(), 'actual execution');
    assert.equal((await exec('git', ['status', '--porcelain'], { cwd: workdir })).stdout.trim(), '');
  } finally {
    AgentRuntimeImpl.prototype.runStage = original;
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
