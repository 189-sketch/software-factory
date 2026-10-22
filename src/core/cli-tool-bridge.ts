import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AgentTool } from './agent-runtime.js';
import type { AgentContext } from './types.js';
import { isFactoryRuntimeError } from './failure-classifier.js';
import { evidenceDirectory } from '../../runtime/evidence-store.mjs';
import { readOptionalJson, writeDurableJson } from '../../runtime/durable-json.mjs';

/** Per-run loopback bridge: only factory tools can issue verification receipts. */
export async function startCliToolBridge(tools: AgentTool[], ctx: AgentContext, instructions = '') {
  const token = randomUUID();
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  let runtimeFailure: unknown;
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const outputDirectory = async () => ctx.repo?.workdir && ctx.issue
    ? evidenceDirectory({ workdir: ctx.repo.workdir, stateDir: ctx.artifactStateDir ?? process.env.FACTORY_STATE_DIR,
      repository: `${ctx.repo.owner}/${ctx.repo.name}`, issueNumber: ctx.issue.number, runId: 'tool-outputs' })
    : path.join(directory, 'outputs');
  const outputReader: AgentTool = {
    name: 'read_tool_output',
    description: 'Read a factory-archived large tool result without rerunning its command. Args: {outputId:string,jsonPointer?:string,offset?:number,limit?:number,search?:string}. Use the exact returned outputId. jsonPointer selects JSON fields such as /stdout, /stderr or /content. Offset is a zero-based character position; limit defaults to 3000 and cannot exceed 3000. Optional search finds literal text at or after offset and returns surrounding context. Follow nextOffset to read more. The same issue can read its archived result after session or worker restart; no arbitrary file paths are accepted.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['outputId'], properties: {
      outputId: { type: 'string' }, jsonPointer: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 3000 }, search: { type: 'string', minLength: 1 },
    } },
    async execute(args) {
      const offset = args.offset ?? 0, limit = args.limit ?? 3000;
      if (typeof args.outputId !== 'string' || !/^[a-f0-9]{64}$/.test(args.outputId)
        || !Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 3000
        || (args.jsonPointer !== undefined && (typeof args.jsonPointer !== 'string' || (args.jsonPointer !== '' && !args.jsonPointer.startsWith('/'))))
        || (args.search !== undefined && (typeof args.search !== 'string' || !args.search))) throw new Error('Invalid tool output handle or page');
      const saved = await readOptionalJson(path.join(await outputDirectory(), `${args.outputId}.json`));
      if (!saved || saved.version !== 1 || typeof saved.content !== 'string' || digest(saved.content) !== args.outputId) throw new Error('Tool output unavailable or invalid for this issue');
      let value = JSON.parse(saved.content);
      for (const key of String(args.jsonPointer ?? '').split('/').slice(1).map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('Tool output JSON pointer not found');
        value = value[key];
      }
      const body = typeof value === 'string' ? value : JSON.stringify(value);
      const match = typeof args.search === 'string' ? body.indexOf(args.search, Number(offset)) : undefined;
      if (match === -1) return { outputId: args.outputId, found: false, totalLength: body.length };
      const start = match === undefined ? Number(offset) : Math.max(0, match - 300);
      const next = Math.min(body.length, start + Number(limit));
      return { outputId: args.outputId, content: body.slice(start, next), offset: start, totalLength: body.length,
        truncated: next < body.length, ...(next < body.length ? { nextOffset: next } : {}),
        ...(match === undefined ? {} : { found: true, matchOffset: match }) };
    },
  };
  tools = [...tools, outputReader];
  const registry = new Map(tools.map((tool) => [tool.name, tool]));
  if (registry.size !== tools.length) throw new Error('Duplicate CLI stage tool name');
  const servers = new Set<Server>();
  const sessions = new Map<string,StreamableHTTPServerTransport>();
  const closeServers = () => Promise.allSettled([...servers].map(server=>server.close()));
  const callTool = async (request: CallToolRequest) => {
    const tool = registry.get(request.params.name);
    if (!tool) throw new Error('Unknown factory stage tool');
    const started = Date.now();
    const log = (event: string, detail = {}) => ctx.logger?.info(event,
      { issue: ctx.issue?.number, agent: ctx.agentId, runId: ctx.runId, tool: tool.name, ...detail });
    log('agent-tool-started');
    const execution = Promise.resolve().then(() => tool.execute(request.params.arguments ?? {}, ctx));
    pending.add(execution);
    try {
      const result = await execution;
      log('agent-tool-finished', { elapsedMs: Date.now() - started, isError: false });
      let text = JSON.stringify(result) ?? 'null';
      const bytes = Buffer.byteLength(text);
      if (bytes > 24_000) {
        const outputId = digest(text);
        try { await writeDurableJson(path.join(await outputDirectory(), `${outputId}.json`), { version: 1, content: text }); }
        catch (cause) { throw Object.assign(new Error('Cannot archive large tool output', { cause }), { code: 'FACTORY_STATE_TOOL_OUTPUT_UNAVAILABLE' }); }
        const metadata = Object.fromEntries(Object.entries(result && typeof result === 'object' ? result : {}).filter(([key, value]) =>
          ['exitCode', 'timedOut', 'passed', 'id', 'status', 'durationMs'].includes(key) && ['number', 'boolean', 'string'].includes(typeof value)
          && (typeof value !== 'string' || value.length <= 200)));
        text = JSON.stringify({ ...metadata, outputId, truncated: true, bytes,
          previewHead: text.slice(0, 1000), previewTail: text.slice(-2000),
          nextStep: 'Use read_tool_output with this outputId and jsonPointer/search/offset to inspect the full result. Do not rerun the command just to retrieve its output. Previews are incomplete, not complete evidence.' });
        log('agent-tool-output-paged', { outputId, bytes });
      }
      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      if (isFactoryRuntimeError(error)) runtimeFailure = error;
      log('agent-tool-finished', { elapsedMs: Date.now() - started, isError: true });
      return { isError: true, content: [{ type: 'text' as const, text: String((error as Error).message) }] };
    } finally {
      pending.delete(execution);
    }
  };
  const connect = async () => {
    const server = new Server({name:'factory',version:'1.0.0'},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:tools.map(tool=>({
      name:tool.name,description:tool.description,
      inputSchema:{...(tool.inputSchema ?? {additionalProperties:true}),type:'object' as const},
    }))}));
    server.setRequestHandler(CallToolRequestSchema,callTool);
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:true,
      onsessioninitialized:id=>{sessions.set(id,transport);} });
    transport.onclose=()=>{
      if(transport.sessionId) sessions.delete(transport.sessionId);
      servers.delete(server);
    };
    servers.add(server);
    try { await server.connect(transport); }
    catch(error) { await server.close();throw error; }
    return {server,transport};
  };
  const http = createServer((request, response) => {
    if (closing || request.url !== '/mcp' || request.headers.authorization !== `Bearer ${token}`
      || (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) {
      response.writeHead(403).end();
      return;
    }
    void (async()=>{
      const id=request.headers['mcp-session-id'];
      if(id !== undefined) {
        const transport=typeof id === 'string' ? sessions.get(id) : undefined;
        if(!transport) {response.writeHead(404).end();return;}
        await transport.handleRequest(request,response);
      } else if(request.method==='POST') {
        // Each CLI invocation and foreground subagent initializes its own MCP session.
        const {server,transport}=await connect();
        try {await transport.handleRequest(request,response);}
        finally {if(!transport.sessionId) await server.close();}
      } else response.writeHead(400).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    await closeServers();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('CLI tool bridge has no loopback address');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-cli-tools-')).catch(async (error) => {
    await closeServers();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    throw error;
  });
  const config = path.join(directory, 'mcp.json');
  const agents = path.join(directory, 'agents.json');
  const close = async () => {
    closing = true;
    await closeServers();
    await Promise.allSettled(pending);
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await fs.rm(config, { force: true });
    await fs.rm(agents, { force: true });
    await fs.rm(path.join(directory, 'outputs'), { recursive: true, force: true });
    await fs.rmdir(directory);
  };
  try {
    await fs.writeFile(agents, JSON.stringify({ 'factory-task': {
      description: 'Complete one bounded subtask assigned by the parent factory agent.',
      prompt: `Follow the parent task and project AGENTS.md, CLAUDE.md and factory/AGENTS.md. Follow the preloaded assigned skills below. Use only the supplied factory MCP tools. Return concrete observations and file or receipt references to the parent. Only the parent may publish commits, PRs, issue comments or workflow labels. Do not report pipeline completion or create another pipeline session. Run in the foreground; the parent must await your result.\n\n${instructions}`,
      tools: tools.filter(tool => !['commit_and_push', 'open_pull_request', 'post_issue_comment', 'update_issue_labels'].includes(tool.name)).map(tool => `mcp__factory__${tool.name}`),
      model: 'inherit',
    } }), { mode: 0o600 });
    await fs.writeFile(config, JSON.stringify({ mcpServers: { factory: {
      type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${token}` },
      timeout: Math.max(ctx.commandTimeoutMs ?? 120_000, ctx.validationTimeoutMs ?? 1_200_000) + 10_000,
    } } }), { mode: 0o600 });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    config,
    agents,
    close,
    assertExecutionAvailable() { if (runtimeFailure) throw runtimeFailure; },
  };
}
