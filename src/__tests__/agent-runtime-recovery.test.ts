import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRuntimeRecoveryStage } from '../../runtime/agent-recovery.mjs';
import { FactoryOrchestrator } from '../orchestrator/index.js';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';
import { dispatchAgentStage, type AgentRuntime } from '../core/agent-runtime.js';
import type { AgentContext } from '../core/types.js';

for (const repaired of [true, false]) {
test(`final output repair keeps the same session and completed work (${repaired ? 'repaired' : 'still invalid'})`, async () => {
  let calls = 0;
  const ctx = { issue: { number: 1 }, repo: { workdir: process.cwd() }, runId: 'output-repair', skills: [],
    logger: { info() {}, warn() {}, error() {} } } as unknown as AgentContext;
  const runtime = { runStage: async (request: any) => {
    calls++;
    if (calls === 2) {
      assert.equal(request.resumeSessionId, 'own-agent-session');
      assert.deepEqual(request.tools.map((tool: any) => tool.name), ['read_file']);
      assert.match(request.inputManifest.messages[0].content, /validationCommands/);
      assert.match(request.inputManifest.messages[0].content, /FINAL_REQUIRED_FIELD/);
      assert.match(request.inputManifest.messages[0].content, /## Output format/,'Repairs repeat the current schema after session compaction or role changes');
      assert.match(request.inputManifest.messages[0].content, /Do not edit product files, rerun commands/);
      assert.doesNotMatch(request.inputManifest.messages[0].content,/Previous response|completed\.ts/,'A resumed session receives only the correction, not its previous output again');
    }
    return { status: 'succeeded', providerSessionId: 'own-agent-session', warnings: [],
      output: JSON.stringify(calls === 2 && repaired ? { validationCommands: ['npm test'] } : { filesChanged: ['completed.ts'] }) };
  } } as unknown as AgentRuntime;
  const task = dispatchAgentStage('implementation', ctx, { systemPrompt: 'Complete implementation', messages: [],
    tools: ['read_file', 'write_file', 'run_process'].map(name => ({ name, description: name, execute: async () => assert.fail('Do not execute again during output repair') })),
    outputContract: { requirements: ['validationCommands must be non-empty'], example: { validationCommands: ['npm test'] } },
    parse: text => {
      const result = JSON.parse(text);
      if (!result.validationCommands?.length) throw new Error(`Missing validationCommands ${'x'.repeat(1200)} FINAL_REQUIRED_FIELD`);
      return result;
    } }, runtime);
  if (repaired) assert.deepEqual((await task).value, { validationCommands: ['npm test'] });
  else await assert.rejects(task, error => (error as { code: string }).code === 'FACTORY_AGENT_OUTPUT_CONTRACT_INVALID');
  assert.equal(calls, 2);
  assert.equal(ctx.resumeSessionId, 'own-agent-session');
});
}

test('legacy missing validation commands recover as an output contract fault without resetting product history', () => {
  const state = { status: 'waiting', issue: { state: 'open' }, lastFailure: { stage: 'implementation', class: 'AGENT_REASONING',
    message: 'Implementation supplied no validation commands; refusing to publish' }, failureCounts: { implementation: 4 } };
  const original = structuredClone(state);
  assert.equal(agentRuntimeRecoveryStage(state), 'implementation');
  assert.deepEqual(state, original);
  assert.equal(agentRuntimeRecoveryStage({ ...state, lastFailure: { ...state.lastFailure, message: 'Product requirements are ambiguous' } }), null);
});

test('exhausted backend JSON repair remains an execution fault and preserves the provider session', async () => {
  const ctx = { issue: { number: 1 }, repo: { workdir: process.cwd() }, runId: 'invalid-json', skills: [],
    logger: { info() {}, warn() {}, error() {} } } as unknown as AgentContext;
  const runtime = { runStage: async () => ({ status: 'format-error', providerSessionId: 'completed-work-session',
    warnings: ['JSON repair exhausted'], output: 'invalid JSON' }) } as unknown as AgentRuntime;
  await assert.rejects(dispatchAgentStage('implementation', ctx, { systemPrompt: 'Complete implementation', messages: [],
    outputContract: { requirements: [], example: {} }, parse: () => assert.fail('No product result exists') }, runtime),
    { code: 'FACTORY_AGENT_OUTPUT_CONTRACT_INVALID' });
  assert.equal(ctx.resumeSessionId, 'completed-work-session');
});

const legacy = { issue: { number: 77, state: 'open', labels: ['needs-info'], comments: [] }, status: 'failed', nextLabel: 'needs-info',
  error: '[failure-classifier] EXECUTOR_CRASH: LLM CLI crashed or exited non-zero',
  lastFailure: { stage: 'verify', class: 'EXECUTOR_CRASH', message: 'verify-behavior dispatcher run failed: claude-code exited with code 1', at: '2026-10-09T06:18:27Z' } };

test('legacy CLI faults recover their original stage without admitting product questions or operator blocks', () => {
  assert.equal(agentRuntimeRecoveryStage(legacy), 'verify');
  for (const state of [ {...legacy,status:'completed'}, {...legacy,issue:{state:'closed'}},
    {...legacy,wait:{reason:'blocked-operator'}}, {...legacy,error:'Please clarify the product requirements'},
    {...legacy,lastFailure:{...legacy.lastFailure,message:'Cannot start unrelated external service'}} ]) assert.equal(agentRuntimeRecoveryStage(state), null);
  const waiting = {...legacy, status:'waiting', error:undefined, agentRuntimeFailure:{stage:'verify',code:'FACTORY_AGENT_CONTEXT_EXHAUSTED'}};
  assert.equal(agentRuntimeRecoveryStage(waiting), 'verify');
});

test('real stage executor failures persist recovery ownership and leave business counters untouched', async () => {
  const state:any = {issue:legacy.issue,status:'waiting',nextLabel:'ready-to-merge', events:[],
    failureCounts:{verify:{AGENT_REASONING:2}}, providerSessions:{'verify-behavior':{providerSessionId:'same-session'}},
    implementation:{commitSha:'reviewed-sha'},review:{verdict:'APPROVE'},reviewedSha:'reviewed-sha'};
  const orchestrator:any = Object.create(FactoryOrchestrator.prototype);
  orchestrator.repo = {owner:'local',name:'test',workdir:process.cwd()};
  orchestrator.config = {...resolveFactoryConfig({env:{}}),syncLabels:false,syncProjects:false};
  orchestrator.logger = {info(){},warn(){},error(){}};
  orchestrator.emit = () => {};
  let durable:any;
  orchestrator.store = {save:async()=>{durable=structuredClone(state);}};
  const before = structuredClone(state.failureCounts);
  const error = Object.assign(new Error('Prompt is too long'),{code:'FACTORY_AGENT_CONTEXT_EXHAUSTED'});
  await assert.rejects(orchestrator.stage(state,'verify',async()=>{throw error;}),error);
  await assert.rejects(orchestrator.handleStageFailure(state,state.issue,()=>{throw new Error('Must not run product supervisor');},error),error);
  assert.equal(durable.agentRuntimeFailure.code, error.code);
  assert.match(durable.agentRuntimeFailure.message,/Prompt is too long/);
  assert.deepEqual(state.failureCounts,before);
  assert.equal(agentRuntimeRecoveryStage(durable),'verify');
  assert.notEqual(state.nextLabel,'needs-info');
  await orchestrator.stage(state,'verify',async()=>({status:'not-verified'}));
  assert.equal(state.agentRuntimeFailure,undefined,'Only actual successful execution clears executor recovery ownership');
  assert.equal(state.reviewedSha,'reviewed-sha');
  assert.equal(state.providerSessions['verify-behavior'].providerSessionId,'same-session');
  assert.deepEqual(state.failureCounts,before);
});

for(const [stage,label] of [['spec','writing-spec'],['implementation','implementing'],['review','reviewing'],['verify','verifying'],['merge','merging']]){
  test(`runtime recovery retains the active ${stage} label without a ready-label round trip`,async()=>{
    const state:any={issue:{number:77,state:'open',title:'Recovery',body:'Existing request',labels:[label],comments:[]},
      status:'waiting',nextLabel:label,events:[],agentRuntimeFailure:{stage,code:'FACTORY_AGENT_EXECUTION_FAILED'}};
    const orchestrator:any=Object.create(FactoryOrchestrator.prototype);
    orchestrator.config={...resolveFactoryConfig({env:{}}),syncLabels:false,syncProjects:false};
    orchestrator.repo={owner:'local',name:'test',workdir:process.cwd()};
    orchestrator.emit=()=>{};
    orchestrator.store={save:async()=>{}};
    orchestrator.confirmMergedImplementation=async()=>false;
    const labels:string[]=[];
    const stopped=new Error('Recovery label observed before dispatch');
    orchestrator.logger={warn(){},error(){},info(message:string){
      if(message.includes('workflow label=')) labels.push(message.match(/workflow label=(\S+)/)![1]!);
      if(message.includes('agent runtime recovery stage='))throw stopped;
    }};
    await assert.rejects(orchestrator.runForIssueState(state.issue,state),stopped);
    assert.deepEqual(labels,[label]);
    assert.equal(state.nextLabel,label);
  });
}
