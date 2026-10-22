import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCliToolBridge } from '../core/cli-tool-bridge.js';
import type { AgentContext } from '../core/types.js';

test('large real MCP results remain readable without rerunning a failed command, including after bridge restart', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-tool-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'worktree');
  await fs.mkdir(workdir);
  const ctx = { runId: 'large-output', repo: { workdir, owner: 'local', name: 'probe' }, issue: { number: 17 },
    artifactStateDir: path.join(root, 'runtime') } as AgentContext;
  const stdout = 'progress\n'.repeat(8000) + 'FAIL durability: commit aborted\n' + 'details\n'.repeat(8000);
  let executions = 0;
  const tools = [{ name: 'run_process', description: 'Fail with long diagnostics', execute: async () => {
    executions++; return { stdout, stderr: 'Test failed', exitCode: 1 };
  } }];
  let bridge = await startCliToolBridge(tools, ctx);
  let client = new Client({ name: 'output-test', version: '1' });
  const connect = async () => {
    const config = JSON.parse(await fs.readFile(bridge.config, 'utf8')).mcpServers.factory;
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  };
  try {
    await connect();
    const response = await client.callTool({ name: 'run_process', arguments: {} });
    const text = (response.content as Array<{ text: string }>)[0].text;
    assert.ok(Buffer.byteLength(text) < 24_000, 'Never hand the CLI an oversized result that it replaces with an unreadable cache path');
    const preview = JSON.parse(text);
    assert.equal(preview.exitCode, 1);
    assert.equal(preview.truncated, true);
    await client.close();
    await bridge.close();
    bridge = await startCliToolBridge(tools, { ...ctx, runId: 'resumed-output' });
    client = new Client({ name: 'resumed-output-test', version: '1' });
    await connect();
    const read = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'read_tool_output', arguments: { outputId: preview.outputId, jsonPointer: '/stdout', ...args } });
      assert.notEqual(result.isError, true);
      return JSON.parse((result.content as Array<{ text: string }>)[0].text);
    };
    const failure = await read({ search: 'FAIL durability' });
    assert.equal(failure.found, true);
    assert.match(failure.content, /commit aborted/);
    let restored = '', offset = 0;
    for (;;) {
      const page = await read({ offset, limit: 3000 });
      restored += page.content;
      if (!page.truncated) break;
      offset = page.nextOffset;
    }
    assert.equal(restored, stdout);
    assert.equal(executions, 1);
    assert.equal((await client.callTool({ name: 'read_tool_output', arguments: { outputId: '../secrets' } })).isError, true);
  } finally { await client.close(); await bridge.close(); }
});

test('CLI tool bridge executes the real registry with authenticated MCP and cleans up', async () => {
  const calls: unknown[] = [];
  const ctx = { runId: 'bridge-test', commandTimeoutMs: 120_000, validationTimeoutMs: 600_000 } as AgentContext;
  const bridge = await startCliToolBridge([{ name: 'run_acceptance_test', description: 'Run assertions',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    execute: async (args, actualCtx) => {
      assert.equal(actualCtx, ctx);
      calls.push(args);
      return { id: 'issued-by-factory', passed: args.command === 'npm test' };
    },
  }, { name: 'commit_and_push', description: 'Parent-only publication', execute: async () => ({}) }], ctx, 'Assigned skill: use current evidence.');
  const config = JSON.parse(await fs.readFile(bridge.config, 'utf8')).mcpServers.factory;
  const agents = JSON.parse(await fs.readFile(bridge.agents, 'utf8'));
  assert.deepEqual(agents['factory-task'].tools, ['mcp__factory__run_acceptance_test', 'mcp__factory__read_tool_output']);
  assert.equal(agents['factory-task'].model, 'inherit');
  assert.match(agents['factory-task'].prompt, /Assigned skill: use current evidence/);
  const client = new Client({ name: 'factory-test', version: '1.0.0' });
  try {
    assert.equal(config.timeout, 610_000);
    assert.equal((await fetch(config.url)).status, 403);
    assert.equal((await fetch(config.url, { headers: { ...config.headers, Origin: 'https://untrusted.example' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['run_acceptance_test', 'commit_and_push', 'read_tool_output']);
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
  await assert.rejects(fs.stat(bridge.agents), { code: 'ENOENT' });
  await assert.rejects(fetch(config.url));
});

test('CLI tool bridge leaves room for the longer validation ceiling when no timeout is configured', async () => {
  const bridge = await startCliToolBridge([], { runId: 'bridge-default-timeout' } as AgentContext);
  try {
    const config = JSON.parse(await fs.readFile(bridge.config, 'utf8')).mcpServers.factory;
    assert.equal(config.timeout, 1_210_000);
  } finally {
    await bridge.close();
  }
});

test('resumed CLI processes and foreground subagents can independently reconnect to the same stage tools', async () => {
  const bridge=await startCliToolBridge([{name:'read_file',description:'Read snapshot',execute:async()=>({content:'same immutable source'})}],
    {runId:'bridge-reconnect'} as AgentContext);
  const config=JSON.parse(await fs.readFile(bridge.config,'utf8')).mcpServers.factory;
  const clients=Array.from({length:3},(_,n)=>new Client({name:`cli-process-${n}`,version:'1.0.0'}));
  try {
    for(const client of clients) {
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));
      assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['read_file','read_tool_output']);
      assert.match(JSON.stringify((await client.callTool({name:'read_file',arguments:{}})).content),/same immutable source/);
    }
    await clients[0].close();
    assert.match(JSON.stringify((await clients[2].callTool({name:'read_file',arguments:{}})).content),/same immutable source/);
  } finally {
    await Promise.allSettled(clients.map(client=>client.close()));
    await bridge.close();
  }
  await assert.rejects(fetch(config.url));
});

test('typed factory tool faults survive the MCP error response and cannot be parsed as product findings', async () => {
  const error = Object.assign(new Error('Review snapshot unavailable'), { code: 'FACTORY_AGENT_EXECUTION_FAILED' });
  const bridge = await startCliToolBridge([{ name: 'read_review_input', description: 'Read snapshot',
    execute: async () => { throw error; } }], { runId: 'bridge-runtime-fault' } as AgentContext);
  const client = new Client({ name: 'factory-test', version: '1.0.0' });
  try {
    const config = JSON.parse(await fs.readFile(bridge.config, 'utf8')).mcpServers.factory;
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    assert.equal((await client.callTool({ name: 'read_review_input', arguments: {} })).isError, true);
    assert.throws(() => bridge.assertExecutionAvailable(), error);
  } finally {
    await client.close();
    await bridge.close();
  }
});
