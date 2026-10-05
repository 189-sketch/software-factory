import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntimeImpl } from '../core/agent-runtime.js';
import { VerifyBehaviorAgent } from '../agents/verify-behavior.js';
import type { AgentContext } from '../core/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCliToolBridge } from '../core/cli-tool-bridge.js';

test('acceptance tools execute confined structured and legacy requests and issue only observed receipts', async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-acceptance-process-'));
  await fs.mkdir(path.join(workdir, 'nested space'));
  const original = AgentRuntimeImpl.prototype.runStage;
  const keys = ['FACTORY_TYPESAFE_OFF', 'FACTORY_TRUSTED_EXECUTION', 'FACTORY_VERIFY_COMMAND'] as const;
  const previous = keys.map(key => process.env[key]);
  process.env.FACTORY_TYPESAFE_OFF = '1';
  process.env.FACTORY_TRUSTED_EXECUTION = '1';
  process.env.FACTORY_VERIFY_COMMAND = '';
  const ctx = { repo: { owner: 'local', name: 'probe', defaultBranch: 'main', workdir },
    issue: { number: 1, title: 'Executor contract', body: 'Tool diagnosis only', labels: [], comments: [], author: 'probe', url: '', createdAt: '' },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    skills: [], skillsRoot: workdir, runId: randomUUID(),
  } satisfies AgentContext;
  try {
    AgentRuntimeImpl.prototype.runStage = async (request, context) => {
      const tool = request.tools!.find(item => item.name === 'run_acceptance_test')!;
      const register = request.tools!.find(item => item.name === 'record_acceptance_check')!;
      const input = { program: 'node', args: ['-e', 'console.log(process.cwd());console.log(process.argv[1])', '$HOME'], cwd: 'nested space' };
      const bridge = await startCliToolBridge([tool], context);
      const client = new Client({ name: 'acceptance-probe', version: '1.0.0' });
      let receipt: any;
      try {
        const config = JSON.parse(await fs.readFile(bridge.config, 'utf8')).mcpServers.factory;
        await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
        assert.deepEqual((await client.listTools()).tools[0]!.inputSchema.oneOf, tool.inputSchema!.oneOf);
        const response = await client.callTool({ name: tool.name, arguments: input });
        assert.equal(response.isError, undefined);
        receipt = JSON.parse((response.content as { text: string }[])[0]!.text);
      } finally {
        await client.close();
        await bridge.close();
      }
      assert.equal(receipt.passed, true);
      assert.deepEqual(receipt.detail.args, input.args);
      assert.equal(receipt.detail.cwd, input.cwd);
      assert.ok(receipt.detail.stdout.includes(path.join(workdir, 'nested space')));
      assert.ok(receipt.detail.stdout.includes('$HOME'));
      await register.execute({ criterion: 'Literal argument and cwd', requirementIds: [], receiptIds: [receipt.id] }, context);
      const legacy = await tool.execute({ command: 'node -e "console.log(process.cwd())"', cwd: 'nested space' }, context) as any;
      assert.equal(legacy.passed, true);
      assert.ok(legacy.detail.stdout.includes(path.join(workdir, 'nested space')));
      const failed = await tool.execute({ program: 'node', args: ['-e', 'process.exit(7)'] }, context) as any;
      assert.equal(failed.passed, false);
      assert.equal(failed.detail.exitCode, 7);
      await assert.rejects(register.execute({ criterion: 'Cannot pass', requirementIds: [], receiptIds: [failed.id] }, context));
      for (const invalid of [
        { ...input, command: 'node --version' }, { ...input, cwd: '..' },
        { ...input, args: 'not an array' }, { ...input, unexpected: true },
        { program: 'git', args: ['push'] }, { command: 'node --version', cwd: 1 },
      ]) await assert.rejects(tool.execute(invalid, context));
      return { status: 'succeeded', output: JSON.stringify({ status: 'not-reproduced', channel: 'browser', notes: 'Tool contract only.', checks: [] }),
        usage: null, backend: 'claude-code', warnings: [], retryable: false };
    };
    await new VerifyBehaviorAgent(ctx, 'reproduce').run();
  } finally {
    AgentRuntimeImpl.prototype.runStage = original;
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await fs.rm(workdir, { recursive: true, force: true });
  }
});
