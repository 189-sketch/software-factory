import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentTool } from './agent-runtime.js';
import type { AgentContext } from './types.js';

/** Per-run loopback bridge: only factory tools can issue verification receipts. */
export async function startCliToolBridge(tools: AgentTool[], ctx: AgentContext) {
  const token = randomUUID();
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  const registry = new Map(tools.map((tool) => [tool.name, tool]));
  if (registry.size !== tools.length) throw new Error('Duplicate CLI stage tool name');
  const mcp = new Server({ name: 'factory', version: '1.0.0' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((tool) => ({
    name: tool.name, description: tool.description,
    inputSchema: { ...(tool.inputSchema ?? { additionalProperties: true }), type: 'object' as const },
  })) }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = registry.get(request.params.name);
    if (!tool) throw new Error('Unknown factory stage tool');
    const execution = tool.execute(request.params.arguments ?? {}, ctx);
    pending.add(execution);
    try {
      const result = await execution;
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) ?? 'null' }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: String((error as Error).message) }] };
    } finally {
      pending.delete(execution);
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  await mcp.connect(transport);
  const http = createServer((request, response) => {
    if (closing || request.url !== '/mcp' || request.headers.authorization !== `Bearer ${token}`
      || (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) {
      response.writeHead(403).end();
      return;
    }
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    await mcp.close();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('CLI tool bridge has no loopback address');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-cli-tools-')).catch(async (error) => {
    await mcp.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    throw error;
  });
  const config = path.join(directory, 'mcp.json');
  const close = async () => {
    closing = true;
    await mcp.close();
    await Promise.allSettled(pending);
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await fs.rm(config, { force: true });
    await fs.rmdir(directory);
  };
  try {
    await fs.writeFile(config, JSON.stringify({ mcpServers: { factory: {
      type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${token}` },
    } } }), { mode: 0o600 });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    config,
    close,
  };
}
