import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCliToolBridge } from '../core/cli-tool-bridge.js';
import type { AgentContext } from '../core/types.js';

test('CLI tool bridge executes the real registry with authenticated MCP and cleans up', async () => {
  const calls: unknown[] = [];
  const ctx = { runId: 'bridge-test' } as AgentContext;
  const bridge = await startCliToolBridge([{ name: 'run_acceptance_test', description: 'Run assertions',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    execute: async (args, actualCtx) => {
      assert.equal(actualCtx, ctx);
      calls.push(args);
      return { id: 'issued-by-factory', passed: args.command === 'npm test' };
    },
  }], ctx);
  const config = JSON.parse(await fs.readFile(bridge.config, 'utf8')).mcpServers.factory;
  const client = new Client({ name: 'factory-test', version: '1.0.0' });
  try {
    assert.equal((await fetch(config.url)).status, 403);
    assert.equal((await fetch(config.url, { headers: { ...config.headers, Origin: 'https://untrusted.example' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['run_acceptance_test']);
    assert.deepEqual((await client.listTools()).tools[0].inputSchema.required, ['command']);
    assert.deepEqual((await client.listTools()).tools[0].inputSchema.properties, { command: { type: 'string' } });
    const result = await client.callTool({ name: 'run_acceptance_test', arguments: { command: 'npm test' } });
    assert.deepEqual(calls, [{ command: 'npm test' }]);
    assert.match(JSON.stringify(result.content), /issued-by-factory/);
    await assert.rejects(client.callTool({ name: 'unregistered', arguments: {} }), /Unknown factory/);
  } finally {
    await client.close();
    await bridge.close();
  }
  await assert.rejects(fs.stat(bridge.config), { code: 'ENOENT' });
  await assert.rejects(fetch(config.url));
});
