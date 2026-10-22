import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntimeImpl } from '../core/agent-runtime.js';
import { VerifyBehaviorAgent, operatorRegressionCheck, consumeReceiptRegistry, setVerifyBehaviorFetchImpl } from '../agents/verify-behavior.js';
import type { AgentContext, BehaviorVerificationResult, SpecPair } from '../core/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCliToolBridge } from '../core/cli-tool-bridge.js';

test('acceptance method follows semantic judgment instead of words in the issue, including evidence recovery', async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-cli-method-'));
  const original = AgentRuntimeImpl.prototype.runStage;
  const values = { FACTORY_TYPESAFE_OFF: '0', TYPESAFE_API_KEY: 'local-test', FACTORY_TRUSTED_EXECUTION: '1',
    FACTORY_VERIFY_COMMAND: '', FACTORY_VERIFY_URL: '' };
  const previous = Object.keys(values).map(key => process.env[key]);
  Object.assign(process.env, values);
  const criterion = 'The CLI prints valid with one newline when invoked with --validate-name good-app.';
  const cli = path.join(workdir, 'cli.cjs');
  await fs.writeFile(cli, `require('node:assert/strict').deepEqual(process.argv.slice(2), ['--validate-name', 'good-app']); process.stdout.write('valid\\n');`);
  const spec = { commitSha: 'approved', product: { body: criterion, acceptanceCriteria: [criterion] } } as SpecPair;
  let generationCalls = 0;
  let judgmentCalls = 0;
  const fixtureWrites: Array<{path:string;archive:string;content:string}> = [];
  try {
    AgentRuntimeImpl.prototype.runStage = async (request, context) => {
      generationCalls += 1;
      const tools = request.tools!.filter(tool => ['write_acceptance_fixture', 'run_acceptance_test', 'record_acceptance_check'].includes(tool.name));
      const bridge = await startCliToolBridge(tools, context);
      const client = new Client({ name: 'acceptance-method-test', version: '1.0.0' });
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client.callTool({ name, arguments: args });
        assert.equal(response.isError, undefined);
        return JSON.parse((response.content as { text: string }[])[0]!.text);
      };
      try {
        const config = JSON.parse(await fs.readFile(bridge.config, 'utf8')).mcpServers.factory;
        await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
        const content = `// Literal source: 中文, quotes, \`backticks\`, no shell escaping.\nconst r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(cli)},'--validate-name','good-app'],{encoding:'utf8'});\nconst a=require('node:assert/strict');a.equal(r.status,0);a.equal(r.stdout,'valid\\n');a.equal(r.stderr,'');console.log('PASS actual CLI assertions');\n`;
        const fixture = await call('write_acceptance_fixture', {directory:'.',name:'cli-assertion.cjs',content});
        fixtureWrites.push({...fixture,content});
        assert.equal(fixture.acceptanceEvidence,false,'Writing source must never create a passing AC receipt');
        const receipt = await call('run_acceptance_test', { program: 'node', args: [fixture.path] });
        assert.equal(receipt.passed, true);
        assert.equal(receipt.detail.fixtureSources[0].content,content,'Independent judgment must see the actual temporary assertion source');
        await call('record_acceptance_check', { criterion, requirementIds: ['AC-1'], receiptIds: [receipt.id] });
      } finally {
        await client.close();
        await bridge.close();
      }
      return { status: 'succeeded', output: JSON.stringify({ status: 'verified', channel: 'desktop', notes: 'CLI assertion passed', checks: [] }),
        usage: null, backend: 'claude-code', warnings: [], retryable: false };
    };
    for (const body of [
      'The supported standalone form is --validate-name <project-name>.',
      'Print the result on screen and document this CLI help page.',
      'CLI 校验表单数据文件，不启动浏览器或页面。',
    ]) {
      setVerifyBehaviorFetchImpl(async (_url, options) => {
        judgmentCalls += 1;
        const request = JSON.parse(options!.body as string);
        assert.equal(request.state.issue.body, body);
        assert.equal(request.state.decision.claimedStatus, 'verified', 'Code must not preempt the semantic judge');
        assert.equal(request.state.factory.lastReceiptRegistry.receipts[0].kind, 'test');
        return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {
          B9: { type: 'choice', choice: 'verified', probabilities: { verified: 0.99 }, confidence: 0.99 },
          'B11-0': { type: 'noul', noul: 0.99 },
        }, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      const ctx = { repo: { owner: 'local', name: 'cli-method', defaultBranch: 'main', workdir },
        issue: { number: 1, title: 'Validate CLI names', body, labels: [], comments: [], author: 'fixture', url: '', createdAt: '' },
        logger: { info() {}, warn() {}, error() {}, child() { return this; } }, skills: [], skillsRoot: workdir,
        runId: randomUUID(), artifactStateDir: path.join(workdir, 'state'),
      } satisfies AgentContext;
      const agent = new VerifyBehaviorAgent(ctx, 'verify', { spec, implementationSha: 'implementation' });
      const result = await agent.run();
      for(const fixture of fixtureWrites) {
        await assert.rejects(fs.access(path.join(workdir,fixture.path)),{code:'ENOENT'});
        assert.equal(await fs.readFile(fixture.archive,'utf8'),fixture.content,'Full source is retained outside product files');
      }
      assert.equal(result.status, 'verified', result.notes);
      assert.equal(consumeReceiptRegistry()!.receipts.length, 1);
      const callsBeforeRecovery = generationCalls;
      const recovered = await agent.rejudge({ ...result, status: 'blocked' });
      assert.equal(recovered?.status, 'verified', recovered?.notes ?? 'Evidence recovery returned no result');
      assert.equal(generationCalls, callsBeforeRecovery, 'Rejudgment must reuse actual execution evidence');
    }
    assert.equal(generationCalls, 3);
    assert.equal(judgmentCalls, 6);

    const prototype = VerifyBehaviorAgent.prototype as any;
    const originalJudgment = prototype.tryTypesafeBatch;
    let savedExecution: BehaviorVerificationResult | undefined;
    const interruptedContext: AgentContext = { repo: { owner: 'local', name: 'cli-method', defaultBranch: 'main', workdir },
      issue: { number: 3, title: 'Validate CLI names', body: 'CLI 校验表单数据文件，不启动浏览器或页面。', labels: [], comments: [], author: 'fixture', url: '', createdAt: '' },
      logger: { info() {}, warn() {}, error() {}, child() { return this; } }, skills: [], skillsRoot: workdir,
      runId: randomUUID(), artifactStateDir: path.join(workdir, 'state'),
      persistVerificationExecution: async execution => {
        savedExecution = structuredClone(execution);
        const registry = JSON.parse(await fs.readFile(execution.receiptPath!, 'utf8'));
        assert.equal(registry.runId, execution.coverage!.runId, 'Execution records must be durable before the checkpoint');
        assert.equal(execution.status, 'blocked', 'Saving execution cannot approve it');
        assert.equal(execution.judgment, undefined);
      },
    };
    prototype.tryTypesafeBatch = async () => {
      assert.ok(savedExecution, 'The completed execution must survive a background preparation failure');
      throw Object.assign(new Error('Background exceeds its output contract'), { code: 'FACTORY_AGENT_CONTEXT_PREPARATION_FAILED' });
    };
    try {
      await assert.rejects(new VerifyBehaviorAgent(interruptedContext, 'verify', { spec, implementationSha: 'implementation' }).run(),
        { code: 'FACTORY_AGENT_CONTEXT_PREPARATION_FAILED' });
    } finally { prototype.tryTypesafeBatch = originalJudgment; }
    assert.ok(savedExecution);
    const callsAfterInterruption = generationCalls;
    const recoveredContext = { ...interruptedContext, runId: randomUUID() };
    const recoveredExecution = await new VerifyBehaviorAgent(recoveredContext, 'verify', { spec, implementationSha: 'implementation' }).rejudge(savedExecution);
    assert.equal(recoveredExecution?.status, 'verified');
    assert.equal(generationCalls, callsAfterInterruption, 'A new worker must not rerun completed actions after a judgment preparation fault');
    assert.equal(recoveredExecution?.coverage?.runId, interruptedContext.runId, 'Rejudgment retains the actual execution identity');

    // A real UI obligation still needs suitable evidence, as judged by
    // Jev. Passing command assertions cannot replace that judgment.
    const uiCriterion = 'Submitting a name in the running website displays its validation result.';
    setVerifyBehaviorFetchImpl(async (_url, options) => {
      const request = JSON.parse(options!.body as string);
      assert.equal(request.state.decision.claimedStatus, 'verified');
      assert.equal(request.state.requirements[0].criterion, uiCriterion);
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {
        B9: { type: 'choice', choice: 'blocked', probabilities: { blocked: 0.99 }, confidence: 0.99 },
        'B11-0': { type: 'noul', noul: 0.01 },
      }, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const uiCtx = { repo: { owner: 'local', name: 'cli-method', defaultBranch: 'main', workdir },
      issue: { number: 2, title: 'Validate a submitted name', body: uiCriterion, labels: [], comments: [], author: 'fixture', url: '', createdAt: '' },
      logger: { info() {}, warn() {}, error() {}, child() { return this; } }, skills: [], skillsRoot: workdir,
      runId: randomUUID(), artifactStateDir: path.join(workdir, 'state'),
    } satisfies AgentContext;
    const uiSpec = { commitSha: 'approved-ui', product: { body: uiCriterion, acceptanceCriteria: [uiCriterion] } } as SpecPair;
    const uiResult = await new VerifyBehaviorAgent(uiCtx, 'verify', { spec: uiSpec, implementationSha: 'implementation' }).run();
    assert.equal(uiResult.status, 'blocked');
    assert.equal(uiResult.checks![0]!.passed, false);
  } finally {
    AgentRuntimeImpl.prototype.runStage = original;
    setVerifyBehaviorFetchImpl(null);
    Object.keys(values).forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await fs.rm(workdir, { recursive: true, force: true });
  }
});

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
        const schema = (await client.listTools()).tools[0]!.inputSchema;
        assert.equal(schema.oneOf, undefined, 'The configured CLI provider cannot consume top-level oneOf tool schemas');
        assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['args', 'command', 'cwd', 'program', 'timeoutMs']);
        assert.equal(schema.additionalProperties, false);
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
        { program: 'node' }, { args: ['--version'] }, {}, { command: '' },
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

test('real registration bridge returns current-run gaps without inventing citations or semantic approval', async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-registration-feedback-'));
  const original = AgentRuntimeImpl.prototype.runStage;
  const values = { FACTORY_TYPESAFE_OFF: '1', FACTORY_TRUSTED_EXECUTION: '1', FACTORY_VERIFY_COMMAND: 'node --version' };
  const previous = Object.keys(values).map(key => process.env[key]);
  Object.assign(process.env, values);
  const ctx = { repo: { owner: 'local', name: 'registration', defaultBranch: 'main', workdir },
    issue: { number: 1, title: 'Registration contract', body: 'Actual command assertions', labels: [], comments: [], author: 'fixture', url: '', createdAt: '' },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } }, skills: [], skillsRoot: workdir, runId: randomUUID(),
  } satisfies AgentContext;
  const spec = { commitSha: 'approved-spec', product: { body: 'Two command assertions',
    acceptanceCriteria: ['First assertion', 'Second assertion'] } } as SpecPair;
  try {
    AgentRuntimeImpl.prototype.runStage = async (request, context) => {
      const operatorId = /Operator regression command receipt: ([a-f0-9-]{36})/.exec(JSON.stringify(request.inputManifest))?.[1];
      assert.ok(operatorId, 'The actual pre-execution receipt must be visible to the model');
      const tools = request.tools!.filter(tool => ['run_acceptance_test', 'record_acceptance_check'].includes(tool.name));
      const bridge = await startCliToolBridge(tools, context);
      const client = new Client({ name: 'registration-probe', version: '1.0.0' });
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client.callTool({ name, arguments: args });
        assert.equal(response.isError, undefined);
        return JSON.parse((response.content as { text: string }[])[0]!.text);
      };
      try {
        const config = JSON.parse(await fs.readFile(bridge.config, 'utf8')).mcpServers.factory;
        await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
        const receipt = await call('run_acceptance_test', { program: 'node', args: ['-e', 'require("node:assert/strict").equal(1, 1)'] });
        const first = await call('record_acceptance_check', { criterion: 'First assertion', requirementIds: ['AC-1'], receiptIds: [receipt.id] });
        assert.deepEqual(first.registrationGaps, { unregisteredRequirementIds: ['AC-2'], unregisteredReviewConcernIds: [], uncitedOperatorReceiptIds: [] });
        assert.deepEqual(first.receiptIds, [receipt.id], 'Feedback cannot add a citation for the model');
        const second = await call('record_acceptance_check', { criterion: 'Second assertion', requirementIds: ['AC-2'], receiptIds: [receipt.id] });
        assert.deepEqual(second.registrationGaps, { unregisteredRequirementIds: [], unregisteredReviewConcernIds: [], uncitedOperatorReceiptIds: [] });
        assert.deepEqual(second.receiptIds, [receipt.id], 'Business checks do not need an unrelated operator citation');
      } finally {
        await client.close();
        await bridge.close();
      }
      return { status: 'succeeded', output: JSON.stringify({ status: 'verified', channel: 'desktop', notes: 'Registered actual assertions', checks: [] }),
        usage: null, backend: 'claude-code', warnings: [], retryable: false };
    };
    const result = await new VerifyBehaviorAgent(ctx, 'verify', { spec, implementationSha: 'implementation' }).run();
    assert.notEqual(result.status, 'verified', 'Empty registration gaps cannot replace independent judgment');
    assert.equal(result.checks!.length, 3);
    assert.deepEqual(result.checks!.at(-1)!.requirementIds, []);
    assert.ok(result.checks!.slice(0, 2).every(check => check.receiptIds.length === 1));
    assert.ok(result.checks!.every(check => !('registrationGaps' in check)), 'Feedback cannot change stored check/proof hashes');
  } finally {
    AgentRuntimeImpl.prototype.runStage = original;
    Object.keys(values).forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await fs.rm(workdir, { recursive: true, force: true });
  }
});

test('operator execution checks require an observed zero exit and never claim AC coverage', () => {
  for (const [passed, exitCode, expected] of [[true, 0, true], [true, 5, false], [false, 0, false], [true, undefined, false]] as const) {
    const check = operatorRegressionCheck({ id: 'observed-receipt', passed, detail: { exitCode } });
    assert.equal(check.passed, expected);
    assert.deepEqual(check.requirementIds, []);
    assert.deepEqual(check.receiptIds, ['observed-receipt']);
  }
});

test('real failed operator execution blocks a positive claim despite a passing business assertion', async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-operator-failure-'));
  const original = AgentRuntimeImpl.prototype.runStage;
  const values = { FACTORY_TYPESAFE_OFF: '1', FACTORY_TRUSTED_EXECUTION: '1',
    FACTORY_VERIFY_COMMAND: 'node -e "process.exit(5)"' };
  const previous = Object.keys(values).map(key => process.env[key]);
  Object.assign(process.env, values);
  const ctx = { repo: { owner: 'local', name: 'regression', defaultBranch: 'main', workdir },
    issue: { number: 1, title: 'Business assertion', body: 'Verify the command assertion', labels: [], comments: [], author: 'fixture', url: '', createdAt: '' },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } }, skills: [], skillsRoot: workdir, runId: randomUUID(),
  } satisfies AgentContext;
  const spec = { commitSha: 'approved', product: { body: 'Observed assertion', acceptanceCriteria: ['One assertion'] } } as SpecPair;
  try {
    AgentRuntimeImpl.prototype.runStage = async (request, context) => {
      const receipt = await request.tools!.find(tool => tool.name === 'run_acceptance_test')!.execute({
        program: 'node', args: ['-e', 'require("node:assert/strict").equal(2 + 2, 4)'],
      }, context) as { id: string };
      await request.tools!.find(tool => tool.name === 'record_acceptance_check')!.execute({
        criterion: 'Arithmetic assertion', requirementIds: ['AC-1'], receiptIds: [receipt.id],
      }, context);
      return { status: 'succeeded', output: JSON.stringify({ status: 'verified', channel: 'desktop', notes: 'Business assertion passed', checks: [] }),
        usage: null, backend: 'claude-code', warnings: [], retryable: false };
    };
    const result = await new VerifyBehaviorAgent(ctx, 'verify', { spec, implementationSha: 'implementation' }).run();
    assert.equal(result.status, 'blocked');
    assert.match(result.notes, /operator regression receipt .* failed/);
    assert.equal(result.checks!.length, 2);
    assert.equal(result.checks![0]!.passed, true);
    assert.equal(result.checks![1]!.passed, false);
    assert.deepEqual(result.checks![1]!.requirementIds, []);
    const registry = consumeReceiptRegistry()!;
    assert.equal((registry.receipts.find(receipt => receipt.kind === 'operator-test')!.detail as { exitCode: number }).exitCode, 5);
  } finally {
    AgentRuntimeImpl.prototype.runStage = original;
    Object.keys(values).forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await fs.rm(workdir, { recursive: true, force: true });
  }
});
