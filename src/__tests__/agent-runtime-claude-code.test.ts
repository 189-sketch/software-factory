/**
 * Slice B.1 / Group 3 / Task 3.4 — Claude Code CLI adapter tests.
 *
 * The adapter spawns an external CLI binary, pipes the composed
 * prompt text over stdin, and parses JSON from stdout — accepting
 * both the native Claude Code CLI result envelope
 * (`{ type: "result", ... }`) and the legacy factory-stub envelope
 * (`{ status, output, ... }`). To exercise the contract without
 * requiring the real `claude` binary to be installed, every test in
 * this file points `FACTORY_CLAUDE_COMMAND` at a small Node.js
 * stub script (created in a temp dir by `writeStub`/`writeNativeStub`)
 * that echoes a canned response.
 *
 * Coverage:
 *   - happy path: stub returns succeeded → dispatcher returns succeeded
 *   - format-error: stub returns missing `output` → dispatcher
 *     surfaces format-error with logTail containing the bad JSON
 *   - non-zero exit: stub exits 1 with stderr → dispatcher returns
 *     failed with retryable classified from the exit reason
 *   - role allow-list: non-allowed role → dispatcher fails fast
 *     with no child process spawned
 *   - missing executable: FACTORY_CLAUDE_COMMAND points to nothing →
 *     dispatcher returns failed (retryable=false)
 *   - native envelope: result JSON → succeeded with translated usage;
 *     is_error → failed with subtype-based retryability
 *   - prompt composition: stdin carries system + user + context
 *     turns as text, in order
 *   - trusted execution: FACTORY_TRUSTED_EXECUTION=1 adds
 *     --dangerously-skip-permissions to the child argv
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildAgentRuntime, type StageRunRequest } from "../core/agent-runtime.js";
import type { AgentContext } from "../core/types.js";
import { dispatchAgentStage } from '../core/agent-runtime.js';
import { isFactoryRuntimeError } from '../core/failure-classifier.js';

test('required stage capabilities fail before a CLI or model can run', async () => {
    let calls = 0;
    const runtime = buildAgentRuntime({});
    runtime.runStage = async () => { calls++; throw new Error('Must not run'); };
    await assert.rejects(dispatchAgentStage('review-spec', makeContext(process.cwd()), {
        systemPrompt: 'Review', messages: [], tools: [], requiredTools: ['read_file', 'read_review_input'],
        outputContract: { requirements: [], example: {} }, parse: JSON.parse,
    }, runtime),
      { code: 'FACTORY_AGENT_CAPABILITY_UNAVAILABLE' });
    assert.equal(calls, 0);
});

test('an incomplete execution cannot become a product review or a parse failure', async () => {
    let parsed = false;
    const ctx = makeContext(process.cwd());
    const output = { runtimeFailure: { tool: 'read_file', message: 'MCP connection unavailable' } };
    const runtime = buildAgentRuntime({});
    runtime.runStage = async () => ({ status: 'succeeded', output: JSON.stringify(output), backend: 'claude-code',
      providerSessionId: 'same-reviewer', warnings: [], usage: null, retryable: false });
    await assert.rejects(dispatchAgentStage('review-spec', ctx, {
        systemPrompt: 'Review', messages: [], outputContract: { requirements: [], example: {} },
        parse: () => { parsed = true; return { verdict: 'REJECT' }; },
    }, runtime), { code: 'FACTORY_AGENT_EXECUTION_FAILED' });
    assert.equal(parsed, false);
    assert.equal(ctx.resumeSessionId, 'same-reviewer');
});

function freshWorkdir(): string {
    return mkdtempSync(path.join(tmpdir(), "factory-rt-claude-"));
}

function writeStreamStub(dir: string, body: string): string {
    const script = path.join(dir, 'stream-stub.mjs');
    writeFileSync(script, `#!${process.execPath}\nlet prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);\nprocess.stdin.on('end', () => {\n${body}\n});\n`);
    chmodSync(script, 0o755);
    if (process.platform !== 'win32') return script;
    const cmd = path.join(dir, 'stream-stub.cmd');
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
}

test('an explicit empty tool registry disables native tools and ambient MCP servers in the real CLI invocation', async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    const stub = writeStreamStub(workdir, `process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:JSON.stringify({args:process.argv.slice(2)})})+'\\n');`);
    const { value } = await dispatchAgentStage('verify-behavior', makeContext(workdir), {
        systemPrompt: 'Judge supplied evidence without tools', messages: [{ role: 'user', content: 'Current evidence' }],
        tools: [], outputContract: { requirements: [], example: { args: [] } }, parse: JSON.parse,
    }, buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: stub }));
    const position = value.args.indexOf('--tools');
    assert.ok(position >= 0, 'An empty registry must not restore the CLI default tools');
    assert.equal(value.args[position + 1], '');
    assert.ok(value.args.includes('--strict-mcp-config'));
});

test('native CLI resumes receive only new task inputs and changed file references across worker restarts', async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    mkdirSync(path.join(workdir, 'factory'));
    writeFileSync(path.join(workdir, 'AGENTS.md'), 'UNCHANGED-PROJECT-RULE');
    writeFileSync(path.join(workdir, 'CLAUDE.md'), 'UNCHANGED-CLAUDE-RULE');
    writeFileSync(path.join(workdir, 'factory', 'AGENTS.md'), 'INITIAL-SHARED-BACKGROUND');
    const journal = path.join(workdir, 'calls.jsonl');
    const stub = writeStreamStub(workdir, `import('node:fs').then(fs=>{
      const args=process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({args,prompt})+'\\n');
      const id=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
      if(fs.existsSync(${JSON.stringify(path.join(workdir, 'missing'))}) && args.includes('--resume')) {
        fs.unlinkSync(${JSON.stringify(path.join(workdir, 'missing'))});
        console.error('No conversation found with session ID: '+id);process.exitCode=1;
      } else process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'{"ok":true}',session_id:id})+'\\n');
    });`);
    let sessionId: string | undefined;
    const context = (agent = 'implementation', issue = 1) => ({...makeContext(workdir), agentId:agent,
      issue:{...makeContext(workdir).issue,number:issue}, runId:`input-${agent}-${issue}`,
      artifactStateDir:path.join(workdir,'runtime-state'),
      projectContextFiles:['AGENTS.md','CLAUDE.md','factory/AGENTS.md'], resumeSessionId:sessionId,
      persistProviderSession:async(id:string)=>{sessionId=id;}} as AgentContext);
    const parts = {systemPrompt:'UNCHANGED-STAGE-RULE Execute the current task',messages:[{role:'user' as const,content:'UNCHANGED-TASK-AND-AC'}],
      outputContract:{requirements:[],example:{ok:true}},parse:JSON.parse};
    const run = (ctx:AgentContext, messages = parts.messages) => dispatchAgentStage('implementation',ctx,{...parts,messages},
      buildAgentRuntime({FACTORY_CLAUDE_COMMAND:stub}));
    assert.deepEqual((await run(context())).value,{ok:true});
    const firstId=sessionId;
    // A new context/runtime models a restarted worker; no in-memory delivery cache survives.
    await run(context());
    writeFileSync(path.join(workdir,'factory','AGENTS.md'),'UPDATED-SHARED-BACKGROUND');
    await run(context(),[...parts.messages,{role:'user',content:'NEW-TARGETED-CORRECTION'}]);
    let calls=readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.match(calls[0].prompt,/UNCHANGED-TASK-AND-AC/);
    assert.match(calls[0].prompt,/UNCHANGED-PROJECT-RULE/);
    assert.match(calls[0].prompt,/INITIAL-SHARED-BACKGROUND/);
    assert.ok(calls[0].args.includes('--session-id'));
    for(const call of calls.slice(1)) {
      assert.equal(call.args[call.args.indexOf('--resume')+1],firstId);
      assert.doesNotMatch(call.prompt,/UNCHANGED-STAGE-RULE|UNCHANGED-TASK-AND-AC|UNCHANGED-PROJECT-RULE|UNCHANGED-CLAUDE-RULE|INITIAL-SHARED-BACKGROUND|UPDATED-SHARED-BACKGROUND/);
    }
    assert.doesNotMatch(calls[1].prompt,/NEW-TARGETED-CORRECTION/);
    assert.match(calls[2].prompt,/NEW-TARGETED-CORRECTION/);
    assert.match(calls[2].prompt,/factory\/AGENTS.md/);
    assert.match(calls[2].prompt,/Read the changed files/);
    // A provider-confirmed absent transcript requires the full current bootstrap, using the same reserved ID.
    writeFileSync(path.join(workdir,'missing'),'');
    await run(context());
    calls=readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(calls.length,5);
    assert.doesNotMatch(calls[3].prompt,/UNCHANGED-TASK-AND-AC/);
    assert.equal(calls[4].args[calls[4].args.indexOf('--session-id')+1],firstId);
    assert.match(calls[4].prompt,/UNCHANGED-TASK-AND-AC/);
    assert.match(calls[4].prompt,/UNCHANGED-STAGE-RULE/);
    assert.match(calls[4].prompt,/UPDATED-SHARED-BACKGROUND/);
    await run(context('review-pr'));
    await run(context('implementation',2));
    calls=readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    for(const call of calls.slice(5)) assert.match(call.prompt,/UNCHANGED-TASK-AND-AC|UNCHANGED-PROJECT-RULE/,
      'Delivery records must never hide background from another agent or issue');
});

test('streamed tool progress arrives before completion and heartbeats describe silent waits', async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ['setInterval'] });
    const events: Array<Record<string, unknown>> = [];
    let sawTool!: () => void;
    const toolFinished = new Promise<void>(resolve => { sawTool = resolve; });
    const stub = writeStreamStub(workdir, `
      const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
      if (!process.argv.includes('stream-json') || !process.argv.includes('--verbose')) process.exit(2);
      emit({type:'system', subtype:'init', apiKey:'DO-NOT-LOG'});
      emit({type:'assistant', message:{content:[{type:'tool_use',id:'tool1',name:'Read',input:{secret:'DO-NOT-LOG'}}]}});
      emit({type:'user', message:{content:[{type:'tool_result',tool_use_id:'tool1',content:'DO-NOT-LOG'}]}});
      setTimeout(() => emit({type:'result', subtype:'success', result:'{"ok":true}', session_id:'session1', usage:{input_tokens:4,output_tokens:2}}), 300);
    `);
    const ctx = makeContext(workdir);
    ctx.logger.info = (_message, event) => {
        events.push(event as Record<string, unknown>);
        if ((event as any).event === 'tool-finished') sawTool();
    };
    const runtime = buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: stub });
    let finished = false;
    const pending = runtime.runStage({ role: 'spec-tech', runId: 'stream', issue: { number: 1, repo: { workdir } },
        inputManifest: { systemPrompt: 'x', messages: [] } }, ctx).then(result => { finished = true; return result; });
    await toolFinished;
    assert.equal(finished, false);
    t.mock.timers.tick(30000);
    assert.ok(events.some(e => e.event === 'heartbeat' && e.phase === 'awaiting-response'));
    const result = await pending;
    assert.equal(result.output, '{"ok":true}');
    assert.equal(result.providerSessionId, 'session1');
    assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2 });
    assert.deepEqual(events.filter(e => e.event === 'tool-started' || e.event === 'tool-finished').map(e => e.tool), ['Read', 'Read']);
    assert.equal(events.at(-1)?.status, 'succeeded');
    assert.doesNotMatch(JSON.stringify(events), /DO-NOT-LOG/);
    const count = events.length;
    t.mock.timers.tick(60000);
    assert.equal(events.length, count, 'completion removes heartbeat');
});

test('stream events cannot hide a command still running from progress heartbeats', async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ['setInterval'] });
    const events: Array<Record<string, unknown>> = [];
    let sawStream!: () => void;
    const streaming = new Promise<void>(resolve => { sawStream = resolve; });
    const stub = writeStreamStub(workdir, `
      const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
      emit({type:'assistant', message:{content:[{type:'tool_use',id:'command',name:'run_process'}]}});
      emit({type:'stream_event',event:{type:'message_start'}});
      emit({type:'assistant',message:{content:[{type:'text',text:'Command in progress'}]}});
      setTimeout(() => {
        emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'command',content:'done'}]}});
        emit({type:'result',subtype:'success',result:'{}'});
      },300);
    `);
    const ctx = makeContext(workdir);
    ctx.logger.info = (_message, event) => {
        events.push(event as Record<string, unknown>);
        if ((event as any).event === 'response-started') sawStream();
    };
    const pending = buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: stub }).runStage({role:'spec-tech',runId:'command-progress',
        issue:{number:1,repo:{workdir}},inputManifest:{systemPrompt:'x',messages:[]}},ctx);
    await streaming;
    t.mock.timers.tick(30000);
    assert.equal(events.find(event => event.event === 'response-started')?.phase,'tool-running');
    assert.equal(events.find(event => event.event === 'heartbeat')?.phase,'tool-running');
    assert.equal((await pending).status,'succeeded');
    assert.equal(events.find(event => event.event === 'tool-finished')?.phase,'awaiting-response');
});

test('stream history larger than the output cap preserves the final result across split chunks', async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    const stub = writeStreamStub(workdir, `
      const delta = JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'x'.repeat(40000)}}})+'\\n';
      for(let n=0;n<40;n++) process.stdout.write(delta);
      process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private reasoning'}}})+'\\n');
      const result=JSON.stringify({type:'result',subtype:'success',result:'{"ok":true}'});
      process.stdout.write(result.slice(0,20));
      setTimeout(()=>process.stdout.write(result.slice(20)),20);
    `);
    const runtime = buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: stub });
    const events: Array<Record<string, unknown>> = [];
    const ctx = makeContext(workdir);
    ctx.logger.info = (_message, event) => { events.push(event as Record<string, unknown>); };
    const result = await runtime.runStage({ role: 'spec-tech', runId: 'large-stream', issue: { number: 1, repo: { workdir } },
        inputManifest: { systemPrompt: 'x', messages: [] } }, ctx);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, '{"ok":true}');
    const finished = events.find(event => event.event === 'finished')!;
    assert.equal(finished.textChars, 1_600_000);
    assert.equal(finished.thinkingChars, 'private reasoning'.length);
    assert.ok((finished.stdoutBytes as number) > 1_600_000);
    assert.ok(!JSON.stringify(events).includes('private reasoning'), 'Progress counters cannot expose model reasoning content');
});

test('single invocation timeout remains transient and a later invocation succeeds', { timeout: 10000 }, async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    const events: Array<Record<string, unknown>> = [];
    const ctx = makeContext(workdir);
    ctx.logger.info = (_message, event) => { events.push(event as Record<string, unknown>); };
    const stub = writeStreamStub(workdir, `
      if(process.argv.includes('--model')) console.log(JSON.stringify({type:'result',subtype:'success',result:'{"ok":true}'}));
      else setInterval(()=>{},1000);
    `);
    const runtime = buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: stub, FACTORY_AGENT_TIMEOUT_MS: '400' });
    await assert.rejects(dispatchAgentStage('spec-tech', ctx, { systemPrompt: 'x', messages: [],
        outputContract: { requirements: [], example: {} }, parse: JSON.parse }, runtime), (error: any) => {
        assert.equal(error.code, 'FACTORY_AGENT_REQUEST_TIMEOUT');
        assert.ok(isFactoryRuntimeError(error));
        return true;
    });
    assert.ok(events.some(e => e.event === 'timeout' && e.retryable === true));
    const recovered = buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: stub, FACTORY_CLAUDE_MODEL: 'recovered' });
    const result = await recovered.runStage({ role: 'spec-tech', runId: 'recovered', issue: { number: 1, repo: { workdir } },
        inputManifest: { systemPrompt: 'x', messages: [] } }, ctx);
    assert.equal(result.status, 'succeeded');
});

test('backend exceptions and interrupted requests cannot enter product failure routing', async () => {
    const parts = {systemPrompt:'Review',messages:[],outputContract:{requirements:[],example:{}},parse:JSON.parse};
    for (const status of ['cancelled','interrupted','throw'] as const) {
        const runtime = buildAgentRuntime({});
        const cause = Object.assign(new Error('Provider connection lost'),{code:'ECONNRESET'});
        runtime.runStage = async () => {
            if (status === 'throw') throw cause;
            return {status,output:'',backend:'claude-code',warnings:[],usage:null,retryable:false};
        };
        await assert.rejects(dispatchAgentStage('review-spec',makeContext(process.cwd()),parts,runtime), (error:any) => {
            assert.ok(isFactoryRuntimeError(error));
            if (status === 'throw') assert.equal(error.cause,cause);
            else assert.match(error.code,new RegExp(status.toUpperCase()));
            return true;
        });
    }
});

for (const recovery of ['success', 'unconfirmed', 'still-too-long']) {
test(`real CLI dispatch preserves its session and handles context recovery: ${recovery}`, async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    const journal = path.join(workdir, 'calls.json');
    const stub = writeStreamStub(workdir, `
      const fs=process.getBuiltinModule('node:fs');
      const file=${JSON.stringify(journal)};
      const calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
      calls.push({prompt,args:process.argv.slice(2)});fs.writeFileSync(file,JSON.stringify(calls));
      const emit=value=>console.log(JSON.stringify(value));
      if(calls.length===1 || (calls.length===3 && ${JSON.stringify(recovery)}==='still-too-long')) {
        emit({type:'result',subtype:'error_during_execution',is_error:true,errors:['Prompt is too long'],session_id:'11111111-1111-4111-8111-111111111111'});process.exitCode=1;
      } else if(calls.length===2) {
        if(${JSON.stringify(recovery)}!=='unconfirmed') emit({type:'system',subtype:'compact_boundary'});
        emit({type:'result',subtype:'success',result:'',session_id:'11111111-1111-4111-8111-111111111111'});
      } else emit({type:'result',subtype:'success',result:'{"ok":true}',session_id:'11111111-1111-4111-8111-111111111111'});
    `);
    const ctx = makeContext(workdir);
    ctx.resumeSessionId = '11111111-1111-4111-8111-111111111111';
    const runtime = buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: stub });
    const operation = dispatchAgentStage('review-spec', ctx, { systemPrompt: 'Review actual current code', messages: [{role:'user', content:'Continue the unresolved evidence checks'}],
      outputContract: {requirements: [], example: {ok:true}}, parse: JSON.parse }, runtime);
    if (recovery === 'success') assert.deepEqual((await operation).value, {ok:true});
    else await assert.rejects(operation, { code: recovery === 'unconfirmed' ? 'FACTORY_AGENT_CONTEXT_RECOVERY_FAILED' : 'FACTORY_AGENT_CONTEXT_EXHAUSTED' });
    const calls = JSON.parse(readFileSync(journal, 'utf8'));
    assert.equal(calls.length, recovery === 'unconfirmed' ? 2 : 3, 'At most one compaction and one continuation per invocation');
    for (const call of calls) {
      assert.ok(call.args.includes('--resume'));
      assert.ok(call.args.includes(ctx.resumeSessionId));
      assert.ok(!call.args.includes('--session-id') && !call.args.includes('--fork-session'));
    }
    assert.match(calls[1].prompt, /^\/compact /);
    assert.ok(!calls[1].args.includes('--agents') && !calls[1].args.includes('--mcp-config'));
    assert.equal(calls[1].args[calls[1].args.indexOf('--tools') + 1], '');
});
}

test('nonzero CLI errors retain safe diagnostics and bypass product failure classification', async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    const stub = writeStreamStub(workdir, `console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:['Prompt is too long']}));process.exitCode=1;`);
    const runtime = buildAgentRuntime({FACTORY_CLAUDE_COMMAND:stub});
    await assert.rejects(dispatchAgentStage('review-spec', makeContext(workdir), {systemPrompt:'Review',messages:[],outputContract:{requirements:[],example:{}},parse:JSON.parse}, runtime), (error:any) => {
      assert.equal(error.code, 'FACTORY_AGENT_CONTEXT_EXHAUSTED');
      assert.match(error.message, /Prompt is too long/);
      assert.match(error.message, /exit=1/);
      return true;
    });
});

test('reported context pressure triggers compaction before the next request in the same session', async t => {
    const workdir=freshWorkdir();
    t.after(()=>rmSync(workdir,{recursive:true,force:true}));
    const journal=path.join(workdir,'calls.json');
    const stub=writeStreamStub(workdir,`
      const fs=process.getBuiltinModule('node:fs'),file=${JSON.stringify(journal)};
      const calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
      calls.push({prompt,args:process.argv.slice(2)});fs.writeFileSync(file,JSON.stringify(calls));
      const emit=value=>console.log(JSON.stringify(value));
      if(prompt.startsWith('/compact ')) emit({type:'system',subtype:'compact_boundary'});
      else emit({type:'assistant',message:{usage:{input_tokens:calls.length===1?100:20,cache_read_input_tokens:calls.length===1?800:0},content:[]}});
      emit({type:'result',subtype:'success',result:'{"ok":true}',session_id:'same-session',modelUsage:{main:{contextWindow:1000}}});
    `);
    const ctx=makeContext(workdir);ctx.resumeSessionId='same-session';
    const runtime=buildAgentRuntime({FACTORY_CLAUDE_COMMAND:stub});
    const parts={systemPrompt:'Review',messages:[],outputContract:{requirements:[],example:{ok:true}},parse:JSON.parse};
    const first=await dispatchAgentStage('review-spec',ctx,parts,runtime);
    assert.deepEqual(first.result.contextUsage,{tokens:900,window:1000});
    await dispatchAgentStage('review-spec',ctx,parts,runtime);
    const calls=JSON.parse(readFileSync(journal,'utf8'));
    assert.equal(calls.length,3);
    assert.match(calls[1].prompt,/^\/compact /);
    assert.ok(calls.every((call:any)=>call.args[call.args.indexOf('--resume')+1]==='same-session'));
    assert.deepEqual(ctx.sessionContext,{tokens:20,window:1000});
});

test('context exhaustion, compaction and resumed tool execution use the actual MCP bridge', async t => {
    const workdir=freshWorkdir();
    t.after(()=>rmSync(workdir,{recursive:true,force:true}));
    const journal=path.join(workdir,'calls.json');
    const stub=writeStreamStub(workdir,`
      (async()=>{
        const fs=process.getBuiltinModule('node:fs'),file=${JSON.stringify(journal)};
        const calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
        calls.push(prompt.startsWith('/compact ')?'compact':'stage');fs.writeFileSync(file,JSON.stringify(calls));
        const emit=value=>console.log(JSON.stringify(value));
        if(prompt.startsWith('/compact ')) {
          emit({type:'system',subtype:'compact_boundary'});
          emit({type:'result',subtype:'success',result:''});return;
        }
        const {Client}=await import(${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))});
        const {StreamableHTTPClientTransport}=await import(${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))});
        const config=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config')+1],'utf8')).mcpServers.factory;
        const client=new Client({name:'resumed-cli',version:'1'});
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));
          const observed=await client.callTool({name:'probe',arguments:{}});
          if(observed.isError) throw new Error(JSON.stringify(observed));
          if(calls.length===1) {
            emit({type:'result',subtype:'error_during_execution',is_error:true,errors:['Prompt is too long']});process.exitCode=1;
          } else emit({type:'result',subtype:'success',result:observed.content[0].text,session_id:'same-session'});
        } finally {await client.close();}
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `);
    const ctx=makeContext(workdir);ctx.resumeSessionId='same-session';
    let probes=0;
    const runtime=buildAgentRuntime({FACTORY_CLAUDE_COMMAND:stub});
    const result=await dispatchAgentStage('review-spec',ctx,{systemPrompt:'Use current tools',messages:[],
      tools:[{name:'probe',description:'Read-only diagnostic',execute:async()=>({probes:++probes})}],requiredTools:['probe'],
      outputContract:{requirements:[],example:{probes:2}},parse:JSON.parse},runtime);
    assert.deepEqual(result.value,{probes:2});
    assert.deepEqual(JSON.parse(readFileSync(journal,'utf8')),['stage','compact','stage']);
    assert.equal(ctx.resumeSessionId,'same-session');
});

function makeContext(workdir: string): AgentContext {
    const logger = {
        info() {}, warn() {}, error() {}, debug() {},
        child() { return this; },
    };
    return {
        issue: { number: 1, title: "x", body: "", labels: [], comments: [] },
        repo: { workdir },
        logger: logger as unknown as AgentContext["logger"],
        skills: [],
        skillsRoot: "/tmp/skills",
        runId: "claude-test-run",
        correction: undefined,
    } as unknown as AgentContext;
}

/**
 * Write a tiny Node script that reads one JSON object from stdin and
 * writes a canned response. Used to substitute for the real Claude
 * Code CLI in tests.
 *
 * On POSIX a `.mjs` script with `chmod +x` is enough — `node:child_process`
 * can `execve` it directly. On Windows the spawn layer refuses to
 * execute a file without a recognised executable extension, so we
 * also write a `.cmd` wrapper that calls `node` with the script path.
 */
function writeStub(
    dir: string,
    behavior:
        | { kind: "ok"; output: string; usage?: { inputTokens: number | null; outputTokens: number | null } | null }
        | { kind: "format-error" }
        | { kind: "exit-non-zero"; code: number; stderr?: string },
): string {
    const script = path.join(dir, "claude-stub.mjs");
    let body = "let input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', c => input += c);\nprocess.stdin.on('end', () => {\n";
    if (behavior.kind === "ok") {
        const payload = {
            status: "succeeded",
            output: behavior.output,
            usage: behavior.usage ?? { inputTokens: 12, outputTokens: 7 },
            warnings: [],
        };
        body += `  process.stdout.write(JSON.stringify(${JSON.stringify(payload)}));\n`;
    } else if (behavior.kind === "format-error") {
        body += `  process.stdout.write("this is not valid JSON: {");\n`;
    } else {
        const stderr = behavior.stderr ?? "";
        body += `  process.stderr.write(${JSON.stringify(stderr)});\n  process.exit(${behavior.code});\n`;
    }
    body += "});\n";
    writeFileSync(script, `#!${process.execPath}\n${body}`, "utf8");
    chmodSync(script, 0o755);

    if (process.platform === "win32") {
        // Windows: spawn refuses files without an executable extension,
        // so we hand back a `.cmd` wrapper that invokes the script via node.
        const cmd = path.join(dir, "claude-stub.cmd");
        const scriptWindowsPath = script.replace(/\//g, "\\");
        writeFileSync(
            cmd,
            `@echo off\r\nnode "${scriptWindowsPath}"\r\n`,
            "utf8",
        );
        return cmd;
    }
    return script;
}

test("happy path: claude-code returns succeeded with structured output", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, {
            kind: "ok",
            output: "claude-code says APPROVE",
            usage: { inputTokens: 12, outputTokens: 7 },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "happy",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "Review.", messages: [{ role: "user" as const, content: "PR #1" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        if (result.status !== "succeeded") {
            // eslint-disable-next-line no-console
            console.error("DEBUG happy-path result:", JSON.stringify(result, null, 2));
        }
        assert.equal(result.status, "succeeded");
        assert.equal(result.backend, "claude-code");
        assert.equal(result.output, "claude-code says APPROVE");
        assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 });
        assert.equal(result.retryable, false);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("format-error: malformed stdout surfaces as format-error with retryable=false", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, { kind: "format-error" });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "fmt",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "format-error");
        assert.equal(result.backend, "claude-code");
        assert.equal(result.retryable, false);
        assert.ok(result.warnings.some((w) => /stdout/i.test(w)));
        assert.ok((result.logTail ?? "").includes("not valid JSON"));
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("non-zero exit: stub exits 1 → failed with retryable hint from exit code", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, {
            kind: "exit-non-zero",
            code: 1,
            stderr: "upstream rate limit",
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "exit1",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "failed");
        assert.equal(result.backend, "claude-code");
        // exit code 1 is classified retryable=true in claude-code-backend
        assert.equal(result.retryable, true);
        assert.ok((result.logTail ?? "").includes("upstream rate limit"));
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("role allow-list: unknown role fails fast without spawning", async () => {
    const workdir = freshWorkdir();
    try {
        // Stub exists but must not be invoked.
        const stubPath = writeStub(workdir, { kind: "ok", output: "should not see this" });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "unknown-future-role", // not in READ_ONLY_ROLES
            runId: "unknown-role",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "failed");
        assert.equal(result.backend, "claude-code");
        assert.ok(result.warnings.some((w) => /refuses role/.test(w)));
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("missing executable: dispatcher returns failed", async () => {
    const workdir = freshWorkdir();
    try {
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            // Point at a path that does not exist.
            FACTORY_CLAUDE_COMMAND: path.join(workdir, "does-not-exist.mjs"),
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "missing",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        // Windows reports a missing executable as cmd.exe exit 1
        // (retryable=true) or a synchronous spawn ENOENT (retryable=false);
        // both are acceptable failure modes for a missing binary.
        assert.equal(result.status, "failed");
        assert.equal(result.backend, "claude-code");
        assert.ok(typeof result.retryable === "boolean");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("FACTORY_AGENT_OVERRIDES permits claude-code for a role", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, { kind: "ok", output: "override works" });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_AGENT_OVERRIDES: JSON.stringify({ "review-pr": "claude-code" }),
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "override",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.backend, "claude-code");
        assert.equal(result.output, "override works");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* Native Claude Code CLI envelope (real-CLI integration)                      */
/* -------------------------------------------------------------------------- */

/**
 * Stub that emits the NATIVE Claude Code CLI result envelope
 * (`{ type: "result", ... }`) and optionally captures the stdin
 * prompt text and argv to files so tests can assert on what the
 * adapter actually piped / flagged.
 */
function writeNativeStub(
    dir: string,
    envelope: Record<string, unknown>,
    capture?: { stdinFile?: string; argvFile?: string; cwdFile?: string },
): string {
    const script = path.join(dir, "claude-native-stub.mjs");
    const body =
        "import { writeFileSync } from 'node:fs';\n"
        + "let input = '';\n"
        + "process.stdin.setEncoding('utf8');\n"
        + "process.stdin.on('data', c => input += c);\n"
        + "process.stdin.on('end', () => {\n"
        + (capture?.stdinFile
            ? `  writeFileSync(${JSON.stringify(capture.stdinFile)}, input);\n`
            : "")
        + (capture?.argvFile
            ? `  writeFileSync(${JSON.stringify(capture.argvFile)}, JSON.stringify(process.argv.slice(2)));\n`
            : "")
        + (capture?.cwdFile ? `  writeFileSync(${JSON.stringify(capture.cwdFile)}, process.cwd());\n` : '')
        + `  process.stdout.write(JSON.stringify(${JSON.stringify(envelope)}));\n`
        + "  process.exit(0);\n"
        + "});\n";
    writeFileSync(script, `#!${process.execPath}\n${body}`, "utf8");
    chmodSync(script, 0o755);
    if (process.platform === "win32") {
        const cmd = path.join(dir, "claude-native-stub.cmd");
        const scriptWindowsPath = script.replace(/\//g, "\\");
        writeFileSync(cmd, `@echo off\r\nnode "${scriptWindowsPath}" %*\r\n`, "utf8");
        return cmd;
    }
    return script;
}

test("native envelope: claude result JSON maps to succeeded with translated usage", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeNativeStub(workdir, {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 1234,
            result: '{"verdict":"APPROVE","body":"ok"}',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7 },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "native-happy",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        assert.equal(result.output, '{"verdict":"APPROVE","body":"ok"}');
        assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50 });
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test('Claude tool execution uses the issue checkout rather than the factory launcher directory', async () => {
    const workdir = freshWorkdir();
    try {
        const cwdFile = path.join(workdir, 'actual-cwd.txt');
        const executable = writeNativeStub(workdir, { type: 'result', subtype: 'success', result: 'ok' }, { cwdFile });
        const rt = buildAgentRuntime({ FACTORY_AGENT_BACKEND: 'claude-code', FACTORY_CLAUDE_COMMAND: executable });
        const result = await rt.runStage({ role: 'spec-product', runId: 'cwd-regression', issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: 'x', messages: [{ role: 'user', content: 'y' }] } }, makeContext(workdir));
        assert.equal(result.status, 'succeeded');
        assert.equal(path.resolve(readFileSync(cwdFile, 'utf8')), path.resolve(workdir));
        assert.notEqual(path.resolve(workdir), path.resolve(process.cwd()));
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("native envelope: is_error result maps to failed with subtype-based retryability", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeNativeStub(workdir, {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "partial text before the error",
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "native-err",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "failed");
        assert.equal(result.retryable, true);
        assert.ok(result.warnings.some((w) => /error_during_execution/.test(w)));
        assert.ok((result.logTail ?? "").includes("partial text before the error"));
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("prompt composition: stdin carries system + user + context turns as text", async () => {
    const workdir = freshWorkdir();
    try {
        const stdinFile = path.join(workdir, "stdin.txt");
        const stubPath = writeNativeStub(
            workdir,
            { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} },
            { stdinFile },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "compose",
            issue: { number: 1, repo: { workdir } },
            inputManifest: {
                systemPrompt: "SYSTEM-SECTION-MARKER",
                messages: [
                    { role: "user" as const, content: "USER-SECTION-MARKER" },
                    ...["CONTEXT-TURN-MARKER"].map((t) => ({ role: "user" as const, content: t })),
                ],
            },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        const piped = readFileSync(stdinFile, "utf8");
        // The child receives prompt TEXT, not the raw request JSON.
        assert.ok(!piped.trimStart().startsWith("{"), "stdin must not be the raw JSON request");
        const sysIdx = piped.indexOf("SYSTEM-SECTION-MARKER");
        const userIdx = piped.indexOf("USER-SECTION-MARKER");
        const ctxIdx = piped.indexOf("CONTEXT-TURN-MARKER");
        assert.ok(sysIdx >= 0 && userIdx >= 0 && ctxIdx >= 0, "all sections must be present");
        assert.ok(sysIdx < userIdx, "system prompt precedes user prompt");
        assert.ok(userIdx < ctxIdx, "context turns follow the user prompt");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("trusted execution: child argv carries --dangerously-skip-permissions", async () => {
    const workdir = freshWorkdir();
    const previous = process.env.FACTORY_TRUSTED_EXECUTION;
    process.env.FACTORY_TRUSTED_EXECUTION = "1";
    try {
        const argvFile = path.join(workdir, "argv.json");
        const stubPath = writeNativeStub(
            workdir,
            { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} },
            { argvFile },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation",
            runId: "trusted",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
        assert.ok(argv.includes("--print"), `expected --print in argv: ${JSON.stringify(argv)}`);
        assert.ok(argv.includes("--output-format"), `expected --output-format in argv: ${JSON.stringify(argv)}`);
        assert.ok(
            argv.includes("--dangerously-skip-permissions"),
            `expected permission flag in argv: ${JSON.stringify(argv)}`,
        );
    } finally {
        if (previous === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION;
        else process.env.FACTORY_TRUSTED_EXECUTION = previous;
        rmSync(workdir, { recursive: true, force: true });
    }
});

// --- M6 multi-turn session --------------------------------------------------

test("M6: resumeSessionId in StageRunRequest injects --resume <id> into argv", async () => {
    const workdir = freshWorkdir();
    try {
        const argvFile = path.join(workdir, "argv.json");
        const stubPath = writeNativeStub(
            workdir,
            {
                type: "result",
                subtype: "success",
                is_error: false,
                session_id: "stubbed-uuid-1",
                result: "ok",
                usage: { input_tokens: 10, output_tokens: 5 },
            },
            { argvFile },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation",
            runId: "resume-1",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
            resumeSessionId: "f26a7dd7-d516-4167-bb86-1da452ded518",
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        // session_id must surface on the result envelope so the
        // orchestrator can persist it on state.providerSessions.
        assert.equal(result.providerSessionId, "stubbed-uuid-1");
        const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
        const resumeIdx = argv.indexOf("--resume");
        assert.ok(resumeIdx >= 0, `expected --resume in argv: ${JSON.stringify(argv)}`);
        assert.equal(argv[resumeIdx + 1], "f26a7dd7-d516-4167-bb86-1da452ded518");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("M6: absence of resumeSessionId keeps argv free of --resume", async () => {
    const workdir = freshWorkdir();
    try {
        const argvFile = path.join(workdir, "argv.json");
        const stubPath = writeNativeStub(
            workdir,
            {
                type: "result",
                subtype: "success",
                is_error: false,
                session_id: "stubbed-uuid-2",
                result: "ok",
                usage: { input_tokens: 10, output_tokens: 5 },
            },
            { argvFile },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation",
            runId: "cold",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        await rt.runStage(req, makeContext(workdir));
        const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
        assert.ok(!argv.includes("--resume"), `did not expect --resume in argv: ${JSON.stringify(argv)}`);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("M6: envelope without session_id leaves providerSessionId null on result", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeNativeStub(
            workdir,
            { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation",
            runId: "no-sid",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        assert.equal(result.providerSessionId, null);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("M6: composeCliPrompt emits only system + incremental messages (no concatenated history)", async () => {
    const workdir = freshWorkdir();
    try {
        const stdinFile = path.join(workdir, "stdin.txt");
        const stubPath = writeNativeStub(
            workdir,
            { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} },
            { stdinFile },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation",
            runId: "incr",
            issue: { number: 1, repo: { workdir } },
            inputManifest: {
                systemPrompt: "SYSTEM-MARKER",
                messages: [
                    { role: "user", content: "TURN-ONE-MARKER" },
                    { role: "user", content: "TURN-TWO-INCREMENT-MARKER" },
                ],
            },
        };
        await rt.runStage(req, makeContext(workdir));
        const stdin = readFileSync(stdinFile, "utf8");
        // Pre-M6 the adapter concatenated userPrompt + contextTurns into
        // a wall of text. M6 keeps the system prompt separate (rendered
        // by composeSystemPrompt upstream) and writes only the
        // incremental user turns to stdin.
        assert.ok(stdin.includes("SYSTEM-MARKER"), "system prompt must reach the CLI");
        assert.ok(stdin.includes("TURN-ONE-MARKER"), "first user turn must reach the CLI");
        assert.ok(stdin.includes("TURN-TWO-INCREMENT-MARKER"), "second user turn must reach the CLI");
        // No double-system, no explicit role label like "user:".
        assert.ok(!stdin.includes("SYSTEM-MARKER\nSYSTEM-MARKER"), "system prompt must not be duplicated");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test('the agent content stream reaches the operator transcript while progress stays metadata-only', async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    // The state directory lives OUTSIDE the checkout: a transcript
    // inside the product worktree would be staged and pushed as
    // product data.
    const stateDir = mkdtempSync(path.join(tmpdir(), 'factory-stream-state-'));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const stub = writeStreamStub(workdir, `
      const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
      emit({type:'system', subtype:'init', session_id:'session1'});
      emit({type:'assistant', message:{content:[{type:'text', text:'OBSERVED-AGENT-TEXT'}]}});
      emit({type:'assistant', message:{content:[{type:'tool_use', id:'tool1', name:'Read', input:{file_path:'src/a.ts'}}]}});
      emit({type:'user', message:{content:[{type:'tool_result', tool_use_id:'tool1', content:'OBSERVED-TOOL-OUTPUT'}]}});
      emit({type:'result', subtype:'success', result:'{"ok":true}', session_id:'session1'});
    `);
    const events: Array<Record<string, unknown>> = [];
    const ctx = makeContext(workdir);
    ctx.artifactStateDir = stateDir;
    ctx.logger.info = (_message, event) => { events.push(event as Record<string, unknown>); };
    const summaries: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => {
        summaries.push(String(chunk));
        return true;
    };
    try {
        const result = await buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: stub, FACTORY_AGENT_STREAM: 'on' })
            .runStage({ role: 'spec-tech', runId: 'stream-run', issue: { number: 1, repo: { workdir } },
                inputManifest: { systemPrompt: 'x', messages: [] } }, ctx);
        assert.equal(result.status, 'succeeded');
    } finally {
        (process.stderr as unknown as { write: unknown }).write = originalWrite;
    }

    const transcriptPath = path.join(stateDir, 'streams', 'issue-1-spec-tech-stream-run.ndjson');
    assert.ok(existsSync(transcriptPath), 'the operator transcript must exist');
    const transcript = readFileSync(transcriptPath, 'utf8');
    assert.match(transcript, /OBSERVED-AGENT-TEXT/, 'the agent text must be observable');
    assert.match(transcript, /OBSERVED-TOOL-OUTPUT/, 'the tool output must be observable');
    assert.match(transcript, /"kind":"tool-call"/);

    // The metadata-only progress contract is untouched: content never
    // rides on the progress channel that reaches the panel and state.
    assert.ok(events.some(event => event.event === 'tool-started'));
    assert.ok(events.some(event => event.event === 'tool-finished'));
    assert.doesNotMatch(JSON.stringify(events), /OBSERVED-AGENT-TEXT|OBSERVED-TOOL-OUTPUT/);

    // The operator sees one bounded console line per event.
    assert.ok(summaries.some(line => line.includes('OBSERVED-AGENT-TEXT')), 'the console summary carries a preview');
    assert.ok(summaries.every(line => line.length < 600), 'console summaries stay bounded');
});

test('the agent content stream can be turned off without touching the run', async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    const stateDir = path.join(workdir, 'factory-state');
    const stub = writeStreamStub(workdir, `process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'{"ok":true}'})+'\\n');`);
    const ctx = makeContext(workdir);
    ctx.artifactStateDir = stateDir;
    const result = await buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: stub, FACTORY_AGENT_STREAM: 'off' })
        .runStage({ role: 'spec-tech', runId: 'stream-off', issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: 'x', messages: [] } }, ctx);
    assert.equal(result.status, 'succeeded');
    assert.equal(existsSync(path.join(stateDir, 'streams')), false, 'no transcript directory is created when the stream is off');
});

test('a transcript directory inside the product checkout is redirected outside it', async t => {
    const workdir = freshWorkdir();
    t.after(() => rmSync(workdir, { recursive: true, force: true }));
    // The state directory is INSIDE the checkout here. The runtime must
    // refuse to write the transcript there: the implementation stage
    // stages the worktree with `git add -A -- :!factory/`, which
    // excludes only `factory/`.
    const stateDir = path.join(workdir, 'factory-state');
    const stub = writeStreamStub(workdir, `process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'{"ok":true}'})+'\\n');`);
    const ctx = makeContext(workdir);
    ctx.artifactStateDir = stateDir;
    const warnings: Array<Record<string, unknown>> = [];
    ctx.logger.warn = (_message, event) => { warnings.push(event as Record<string, unknown>); };
    const result = await buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: stub, FACTORY_AGENT_STREAM: 'on' })
        .runStage({ role: 'spec-tech', runId: 'stream-inside', issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: 'x', messages: [] } }, ctx);
    assert.equal(result.status, 'succeeded');
    assert.equal(existsSync(path.join(stateDir, 'streams')), false, 'no transcript may be written inside the checkout');
    assert.ok(warnings.some(warning => warning.reason !== undefined), 'the redirect must be reported');
});
