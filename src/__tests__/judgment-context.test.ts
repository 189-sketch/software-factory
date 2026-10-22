import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {AgentRuntimeImpl} from '../core/agent-runtime.js';
import {runAgentJudgment,summarizeJudgmentContext,validateJudgmentContext} from '../core/judgment-context.js';
import {resolveAgentConfig} from '../../runtime/agent-backends.mjs';
import type {AgentContext} from '../core/types.js';
import type {TypesafeRequest} from '../../runtime/typesafe-backend.d.mts';

test('command judgment always receives production fixture content and full output even when the summary cites only exit zero',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-assertion-source-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const original=AgentRuntimeImpl.prototype.runStage;
  t.after(()=>{AgentRuntimeImpl.prototype.runStage=original;});
  const ctx={repo:{owner:'local',name:'test',workdir:root},issue:{number:5},runId:'assertion-source',skills:[],skillsRoot:root,
    artifactStateDir:path.join(root,'state'),logger:{info(){},warn(){},error(){}}} as unknown as AgentContext;
  AgentRuntimeImpl.prototype.runStage=async(request,context)=>{
    const observed:any=await request.tools![0]!.execute({sourceId:'receipt:process',path:'/detail/exitCode'},context);
    return {status:'succeeded',output:JSON.stringify({background:'Current test',exceptions:[],observations:[{
      checkIndex:0,explanation:'The process exited zero',citations:[observed.excerpts[0].citationId]}]}),
      usage:null,backend:'claude-code',warnings:[],retryable:false};
  };
  const request:TypesafeRequest={model:'jev-latest',state:{requirements:[{id:'AC-1',text:'Persist rows'}],
    verificationChecks:[{criterion:'Persistence is demonstrated',receiptIds:['process']}],
    factory:{lastReceiptRegistry:{receipts:[{id:'process',kind:'test',passed:true,detail:{program:'node',args:['fixture.js'],exitCode:0,
      stdout:'irrelevant progress\n'.repeat(1000)+'OBSERVED_FULL_OUTPUT',
      fixtureSources:[{path:'fixture.js',content:'assert.equal(savedRows.length, 1); // ACTUAL_ASSERTION_SOURCE',sourceHash:'pinned-hash'}]}}]}}},
    questions:{B11:{type:'noul',instructions:{question:'Does execution prove persistence?',target:{requirementPath:'requirements[0]',checkPath:'verificationChecks[0]',receiptIds:['process']}}}}};
  let sent:any;
  const env={...process.env,TYPESAFE_API_KEY:'test',FACTORY_TYPESAFE_OFF:'0'};
  await runAgentJudgment('verify-behavior',ctx,resolveAgentConfig(env),'typesafe',request,{env,fetchImpl:async(_url:any,init:any)=>{
    sent=JSON.parse(init.body);return new Response(JSON.stringify({answers:{B11:{type:'noul',noul:0.9}}}));
  }});
  assert.ok(JSON.stringify(sent).includes('ACTUAL_ASSERTION_SOURCE'));
  assert.ok(JSON.stringify(sent).includes('OBSERVED_FULL_OUTPUT'));
  assert.ok(sent.state.questionContext.sourceExcerpts.some((excerpt:any)=>excerpt.field==='/detail/fixtureSources'));
});

test('static review sends actual source and approved constraints without a lossy model summary',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-review-authority-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const original=AgentRuntimeImpl.prototype.runStage;
  t.after(()=>{AgentRuntimeImpl.prototype.runStage=original;});
  const ctx={repo:{owner:'local',name:'test',workdir:root},issue:{number:4},runId:'source-authority',skills:[],skillsRoot:root,
    artifactStateDir:path.join(root,'state'),logger:{info(){},warn(){},error(){}}} as unknown as AgentContext;
  AgentRuntimeImpl.prototype.runStage=async()=>{throw new Error('Static source must not depend on a model summary');};
  const request:TypesafeRequest={model:'jev-latest',state:{decision:{headSha:'fixed-head'},prDiff:'ACTUAL_CHANGED_CODE',
    sourceExcerpts:[{path:'unchanged.ts',revision:'fixed-head',content:'ACTUAL_HELPER'}],
    specification:{product:{acceptanceCriteria:['Preserve failed writes']},technicalDesign:{approach:'Check durable result'}},
    issue:{body:'Original binding constraints'},reviewEvidence:{body:'Claim '.repeat(3000)},reviewFindings:[]},
    questions:{B7:{type:'choice',instructions:'Inspect static code',criteria:{APPROVE:'Supported',REJECT:'Defect'}}}};
  let sent:any;
  const env={...process.env,TYPESAFE_API_KEY:'test',FACTORY_TYPESAFE_OFF:'0'};
  const result=await runAgentJudgment('review-pr',ctx,resolveAgentConfig(env),'typesafe',request,{env,fetchImpl:async(_url:any,init:any)=>{
    sent=JSON.parse(init.body);
    return new Response(JSON.stringify({answers:{B7:{type:'choice',choice:'REJECT',confidence:0.99,probabilities:{APPROVE:0.01,REJECT:0.99}}}}));
  }});
  assert.equal(result.status,'succeeded');
  assert.equal(sent.state.prDiff,'ACTUAL_CHANGED_CODE');
  assert.equal(sent.state.sourceExcerpts[0].content,'ACTUAL_HELPER');
  assert.equal(sent.state.specification.technicalDesign.approach,'Check durable result');
  assert.equal(sent.state.issue.body,'Original binding constraints');
});

test('summary capacity scales with active checks without dropping source-bound observations', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-summary-capacity-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const original=AgentRuntimeImpl.prototype.runStage;
  t.after(()=>{AgentRuntimeImpl.prototype.runStage=original;});
  const ctx={repo:{owner:'local',name:'test',workdir:root},issue:{number:3},runId:'capacity',skills:[],skillsRoot:root,
    artifactStateDir:path.join(root,'state'),logger:{info(){},warn(){},error(){}}} as unknown as AgentContext;
  AgentRuntimeImpl.prototype.runStage=async request=>{
    const inventory=JSON.parse(request.inputManifest.messages[0]!.content.split('\n')[1]!);
    const output=JSON.stringify({background:'Current checks',exceptions:[],observations:inventory.checks.map((check:any)=>({
      checkIndex:check.checkIndex,explanation:'Observed relevant constraints. '.repeat(12),citations:[inventory.receipts[0].preview.citationId]}))});
    assert.ok(output.length>12000,'Reproduce the formerly rejected complete summary');
    return {status:'succeeded',output,usage:null,backend:'claude-code',warnings:[],retryable:false};
  };
  const summary=await summarizeJudgmentContext('spec',ctx,'capacity',{},[{id:'source',kind:'test',passed:true,detail:'actual evidence'}],
    Array.from({length:40},(_,i)=>({criterion:`Check ${i}`,receiptIds:['source']})));
  assert.equal(summary.observations.length,40);
});

test('agent prepares question-specific Jev context once and caches exact source-bound summaries',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-judgment-context-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const original=AgentRuntimeImpl.prototype.runStage;
  t.after(()=>{AgentRuntimeImpl.prototype.runStage=original;});
  const ctx={repo:{owner:'local',name:'test',workdir:root},issue:{number:1,title:'Current request',body:'Keep existing data',labels:[],comments:[]},
    runId:'current-run',resumeSessionId:'same-agent-session',skills:[],skillsRoot:root,artifactStateDir:path.join(root,'state'),
    logger:{info(){},warn(){},error(){}}} as unknown as AgentContext;
  let generations=0;
  let forged=false;
  let omitExecution=false;
  let omitChain=false;
  AgentRuntimeImpl.prototype.runStage=async(request,context)=>{
    generations++;
    const inputLine=request.inputManifest.messages[0]!.content.split('\n')[1];
    const incremental=inputLine?.startsWith('{')?JSON.parse(inputLine):undefined;
    if(generations>1&&incremental){
      assert.equal(incremental.checks.length,2,'Every continuation includes the complete active checks, even when no checks changed');
      assert.ok(incremental.receipts.some((source:any)=>source.id==='product'),'Current source previews remain available after session compaction');
      assert.ok(incremental.background,'Current background does not depend on retained model memory');
    }
    assert.equal(request.role,'spec-tech','The spec identity uses a registered execution role');
    assert.equal(request.resumeSessionId,'same-agent-session');
    assert.deepEqual(request.tools?.map(tool=>tool.name),['read_judgment_source']);
    const read=request.tools![0]!;
    const inspected:any=await read.execute({sourceId:'product',path:'/value'},context);
    const reread:any=await read.execute({sourceId:'product',path:'/value'},context);
    assert.equal(reread.excerpts[0].citationId,inspected.excerpts[0].citationId,'The same exact source excerpt has a stable identity across reads');
    const persistence:any=await read.execute({sourceId:'product',path:'/persistence'},context);
    const negative:any=await read.execute({sourceId:'counterevidence:bad',path:'/actual'},context);
    const actual:any=await read.execute({sourceId:'receipt:good',path:'/detail/actual'},context);
    const processResult:any=await read.execute({sourceId:'receipt:process',path:'/detail/actual'},context);
    const assertion:any=await read.execute({sourceId:'receipt:process',path:'/detail/fixtureSources/0/source'},context);
    const navigation:any=await read.execute({sourceId:'receipt:navigation',path:'/detail/actual'},context);
    const claims:any=await read.execute({sourceId:'verificationChecks',path:''},context);
    assert.equal(inspected.excerpts[0].text,'CURRENT-VALUE');
    return {status:'succeeded',output:JSON.stringify({background:'Judge the current request using current observations',
      observations:[{checkIndex:0,explanation:'First decision uses the current value',citations:[forged?'invented':inspected.excerpts[0].citationId,claims.excerpts[0].citationId]},
        {checkIndex:1,explanation:'Second decision checks persistence and its contrary observation',citations:[persistence.excerpts[0].citationId,claims.excerpts[0].citationId,...(omitExecution?[]:[processResult.excerpts[0].citationId,assertion.excerpts[0].citationId]),...(omitChain?[]:[actual.excerpts[0].citationId,navigation.excerpts[0].citationId])]}],
      exceptions:[{receiptId:'counterevidence:bad',explanation:'Persistence contradicts the second claim',relevantCheckIndexes:['Q2'],
        citations:[negative.excerpts[0].citationId]}]}),
      usage:null,backend:'claude-code',warnings:[],retryable:false,providerSessionId:'same-agent-session'};
  };
  const request:TypesafeRequest={model:'jev-latest',state:{decision:{runId:'current-run'},issue:ctx.issue,optionalRevision:undefined,
    requirements:[{id:'AC-1',text:'VALUE-REQUIREMENT'},{id:'AC-2',text:'PERSISTENCE-REQUIREMENT'}],
    verificationChecks:[{criterion:'VALUE-CHECK'},{criterion:'PERSISTENCE-CHECK'}],
    product:{value:'CURRENT-VALUE',persistence:'PERSISTED',irrelevantHistory:'UNRELATED-HISTORY'.repeat(2000)},
    factory:{lastReceiptRegistry:{receipts:[{id:'bad',kind:'test',passed:false,detail:{actual:'MISSING',stdout:'FULL-RAW-LOG'.repeat(2000)}},
      {id:'good',kind:'browser-assertion',passed:true,detail:{actual:'REAL-PERSISTENCE-OBSERVATION',browserSessionId:'current',previousReceiptId:'navigation'}},
      {id:'navigation',kind:'browser-action',passed:true,detail:{actual:'CURRENT-PAGE-NAVIGATION',browserSessionId:'current',previousReceiptId:'other'}},
      {id:'process',kind:'test',passed:true,detail:{actual:'REAL-COMMIT-ASSERTION',cwd:'/current/worktree',exitCode:0,
        fixtureSources:[{path:'acceptance.test.ts',source:'expect(await persistedRows()).toEqual([submittedContent])'}]}},
      {id:'other',kind:'test',passed:true,detail:{actual:'UNRELATED-EXECUTION-OBSERVATION'}}]}}},
    questions:{Q1:{type:'noul',instructions:{question:'Does the current value match?',target:{requirementPath:'requirements[0]'}}},
      Q2:{type:'noul',instructions:{question:'Is persistence demonstrated?',target:{authoritativeRequirementPaths:['requirements[1]'],checkPath:'verificationChecks[1]',receiptIds:['good','process']}}}}};
  const sent:any[]=[];
  const env={...process.env,TYPESAFE_API_KEY:'test',FACTORY_TYPESAFE_OFF:'0'};
  const options={env,fetchImpl:async(_url:any,init:any)=>{
    const body=JSON.parse(init.body);sent.push(body);
    return new Response(JSON.stringify({answers:Object.fromEntries(Object.keys(body.questions).map(id=>[id,{type:'noul',noul:0.9}]))}));
  }};
  const result=await runAgentJudgment('spec',ctx,resolveAgentConfig(env),'typesafe',request,options);
  assert.equal(result.status,'succeeded');
  assert.equal(generations,1);
  assert.equal(sent.length,2);
  assert.deepEqual(sent.map(body=>Object.keys(body.questions)),[['Q1'],['Q2']]);
  assert.deepEqual((result.structuredOutput as any[]).map(item=>item.id),['Q1','Q2']);
  assert.ok(JSON.stringify(sent[0]).includes('CURRENT-VALUE'));
  assert.ok(JSON.stringify(sent[0]).includes('VALUE-REQUIREMENT'));
  assert.ok(!JSON.stringify(sent[0]).includes('PERSISTENCE-REQUIREMENT'),'A targeted decision excludes unrelated authoritative requirements');
  assert.ok(JSON.stringify(sent[1]).includes('PERSISTENCE-REQUIREMENT'));
  assert.ok(!JSON.stringify(sent[1]).includes('VALUE-REQUIREMENT'));
  assert.deepEqual(sent[1].state.authority.verificationChecks,{'verificationChecks[1]':{criterion:'PERSISTENCE-CHECK'}});
  assert.ok(!JSON.stringify(sent[1]).includes('VALUE-CHECK'));
  assert.ok(!JSON.stringify(sent[0]).includes('PERSISTED'));
  assert.ok(!JSON.stringify(sent[0]).includes('MISSING'));
  assert.ok(JSON.stringify(sent[1]).includes('MISSING'));
  assert.ok(JSON.stringify(sent[1]).includes('REAL-PERSISTENCE-OBSERVATION'));
  assert.ok(!JSON.stringify(sent[0]).includes('REAL-PERSISTENCE-OBSERVATION'));
  assert.ok(JSON.stringify(sent[1]).includes('CURRENT-PAGE-NAVIGATION'),'The claimed browser state retains the action that caused it');
  assert.ok(!JSON.stringify(sent[0]).includes('CURRENT-PAGE-NAVIGATION'));
  assert.ok(!JSON.stringify(sent).includes('UNRELATED-EXECUTION-OBSERVATION'));
  assert.ok(!JSON.stringify(sent).includes('UNRELATED-HISTORY'));
  assert.ok(!JSON.stringify(sent).includes('FULL-RAW-LOG'));
  assert.ok(!JSON.stringify(sent).includes('optionalRevision'),'Absent optional fields are not evidence sources');
  await runAgentJudgment('spec',ctx,resolveAgentConfig(env),'typesafe',request,options);
  assert.equal(generations,1,'Service retry reuses the same source-bound summary');
  const changed=structuredClone(request) as any;changed.state.issue.body='Updated business constraint';
  await runAgentJudgment('spec',ctx,resolveAgentConfig(env),'typesafe',changed,options);
  assert.equal(generations,2,'A changed author constraint invalidates the context cache');
  forged=true;changed.state.issue.body='Another updated constraint';
  const calls=sent.length;
  await assert.rejects(runAgentJudgment('spec',ctx,resolveAgentConfig(env),'typesafe',changed,options),{code:'FACTORY_AGENT_CONTEXT_PREPARATION_FAILED'});
  assert.equal(sent.length,calls,'Invalid context cannot fall back to sending history or approve acceptance');
  assert.equal(generations,4,'Malformed context gets one targeted repair in the same session');
  forged=false;
  omitExecution=true;
  changed.state.issue.body='Current claim still needs actual execution evidence';
  await assert.rejects(runAgentJudgment('spec',ctx,resolveAgentConfig(env),'typesafe',changed,options),{code:'FACTORY_AGENT_CONTEXT_PREPARATION_FAILED'});
  assert.equal(sent.length,calls,'Command metadata without a selected observed assertion cannot support acceptance');
  assert.equal(generations,6,'Missing observations get one targeted repair without rerunning actions');
  omitExecution=false;
  omitChain=true;
  changed.state.issue.body='The browser assertion needs its current-session action chain';
  const beforeChainRepair=generations;
  await runAgentJudgment('spec',ctx,resolveAgentConfig(env),'typesafe',changed,options);
  assert.equal(generations,beforeChainRepair+1,'Factory-owned links do not need another model output repair');
  assert.ok(JSON.stringify(sent.at(-1)).includes('CURRENT-PAGE-NAVIGATION'),'The factory supplies the linked action even when the summary omits it');
  assert.ok(JSON.stringify(sent.at(-1)).includes('REAL-PERSISTENCE-OBSERVATION'),'Actual browser assertions do not depend on the model copying them');
  assert.ok(JSON.stringify(sent.at(-1)).includes('expect(await persistedRows()).toEqual([submittedContent])'),'Jev receives the selected assertion source, not the complete test file');
  assert.ok(!JSON.stringify(sent.at(-1)).includes('UNRELATED-EXECUTION-OBSERVATION'),'The factory cannot join different browser sessions');
  omitChain=false;
  const wholeDecision=structuredClone(request) as any;
  wholeDecision.questions.Q1.instructions={question:'Judge coverage of EVERY authoritative requirement',relatedQuestionIds:['Q2']};
  await runAgentJudgment('spec',ctx,resolveAgentConfig(env),'typesafe',wholeDecision,options);
  assert.deepEqual(Object.keys(sent.at(-2).questions),['Q2'],'Dependent evidence is judged before the overall decision');
  const overall=sent.at(-1);
  assert.deepEqual(overall.state.authority.requirements,wholeDecision.state.requirements,'Whole-decision judgments retain the complete authoritative baseline');
  assert.ok(!JSON.stringify(overall).includes('REAL-PERSISTENCE-OBSERVATION'),'Evidence already independently judged is not resent for the overall decision');
  assert.equal(overall.state.relatedJudgments[0].questionId,'Q2');
  assert.equal(overall.state.relatedJudgments[0].answers[0].id,'Q2');
  assert.ok(JSON.stringify(overall).includes('MISSING'),'The overall decision still receives dependent counterevidence');
  assert.equal(overall.state.relatedQuestionContexts[0].questionId,'Q2');
  assert.ok(!JSON.stringify(overall).includes('UNRELATED-EXECUTION-OBSERVATION'),'Other browser sessions cannot enter the causal chain');
});

test('context validation rejects missing counterevidence and fabricated source quotes',()=>{
  const sources=[{id:'source',kind:'test',passed:false,detail:{actual:'observed failure'}}];
  const checks=[{criterion:'Current behavior',receiptIds:['source']}];
  const summary={background:'Current problem',observations:[{checkIndex:0,explanation:'Observed failure',citations:[{receiptId:'source',field:'/actual',quote:'observed failure'}]}],
    exceptions:[{receiptId:'source',explanation:'Affects the current question',relevantCheckIndexes:[0],citations:[{receiptId:'source',field:'/actual',quote:'observed failure'}]}]};
  assert.equal(validateJudgmentContext(summary,sources,checks),summary);
  assert.throws(()=>validateJudgmentContext({background:{stage:'verify'},sourceFields:[],checks,receipts:sources},sources,checks),
    /background must be a short STRING.*observations must be an ARRAY.*exceptions must be an ARRAY/);
  assert.throws(()=>validateJudgmentContext({...summary,exceptions:[{...summary.exceptions[0],relevantCheckIndexes:['HISTORICAL-Q2']}]},sources,checks),
    /unknown question references.*HISTORICAL-Q2/);
  assert.throws(()=>validateJudgmentContext(summary,sources,[{...checks[0],requiredReceiptIds:['actual-execution']}]),
    /observations\[0\] must cite actual current execution sources: actual-execution/);
  const manySources=Array.from({length:13},(_,index)=>({id:`execution-${index}`,kind:'test',passed:true,detail:{actual:`observed-${index}`,expected:`expected-${index}`}}));
  const manySummary={background:'One check with thirteen real observations',observations:[{checkIndex:0,explanation:'All executed observations',
    citations:manySources.flatMap(source=>[{receiptId:source.id,field:'/actual',quote:source.detail.actual},
      {receiptId:source.id,field:'/expected',quote:source.detail.expected}])}],exceptions:[]};
  assert.equal(validateJudgmentContext(manySummary,manySources,[{criterion:'Complete scenario',receiptIds:manySources.map(source=>source.id),
    requiredReceiptIds:manySources.map(source=>source.id)}]),manySummary);
  assert.throws(()=>validateJudgmentContext({...summary,exceptions:[]},sources,checks));
  assert.throws(()=>validateJudgmentContext({...summary,exceptions:[{...summary.exceptions[0],receiptId:'bare-receipt-id'}]},sources,checks),
    /exceptions receiptId mismatch: missing \[source\], unknown \[bare-receipt-id\]/);
  const longerExplanation={...summary,
    observations:[{...summary.observations[0],explanation:'x'.repeat(801)}],
    exceptions:[{...summary.exceptions[0],explanation:'y'.repeat(1109)}]};
  assert.equal(validateJudgmentContext(longerExplanation,sources,checks),longerExplanation,'Explanation length alone cannot invalidate exact execution evidence');
  assert.equal(longerExplanation.exceptions[0].explanation.length,1109,'Explanations are not silently truncated');
  assert.throws(()=>validateJudgmentContext({...summary,observations:[{...summary.observations[0],citations:[{receiptId:'source',field:'/actual',quote:'passed'}]}]},sources,checks));
});

test('all worker Jev entry points go through the shared context preparation method',async()=>{
  const agents=path.resolve('src/agents');
  for(const name of await fs.readdir(agents)){
    if(!name.endsWith('.ts'))continue;
    const source=await fs.readFile(path.join(agents,name),'utf8');
    assert.doesNotMatch(source,/import\s*\{[^}]*runTypesafeStageFromConfig[^}]*\}\s*from/,`${name} bypasses context preparation`);
  }
});

test('an echoed source inventory gets a precise same-session repair using source-bound previews',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-context-preview-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const original=AgentRuntimeImpl.prototype.runStage;
  t.after(()=>{AgentRuntimeImpl.prototype.runStage=original;});
  const ctx={repo:{owner:'local',name:'preview',workdir:root},issue:{number:1,title:'Current request',body:'Current constraint',labels:[],comments:[]},
    runId:'preview-run',resumeSessionId:'existing-session',skills:[],skillsRoot:root,artifactStateDir:path.join(root,'state'),
    logger:{info(){},warn(){},error(){}}} as unknown as AgentContext;
  let calls=0;
  let inventory:any;
  AgentRuntimeImpl.prototype.runStage=async request=>{
    calls++;
    assert.equal(request.resumeSessionId,'existing-session');
    if(calls===1)inventory=JSON.parse(request.inputManifest.messages[0]!.content.split('\n')[1]!);
    const source=inventory.receipts[0];
    assert.equal(source.preview.text,'{"actual":"CURRENT-OBSERVATION"}');
    if(calls===2){
      assert.doesNotMatch(request.inputManifest.messages[0]!.content,/CURRENT SOURCE INVENTORY/,'The same session reuses its existing input');
      assert.match(request.inputManifest.messages.at(-1)!.content,/observations must be an ARRAY/);
      assert.match(request.inputManifest.messages.at(-1)!.content,/exceptions must be an ARRAY/);
    }
    return {status:'succeeded',output:JSON.stringify(calls===1?inventory:{background:'Current constraint',
      observations:[{checkIndex:0,explanation:'Observed current result',citations:[source.preview.citationId]}],exceptions:[]}),
      usage:null,backend:'claude-code',warnings:[],retryable:false,providerSessionId:'existing-session'};
  };
  const summary=await summarizeJudgmentContext('spec',ctx,'preview-run',{},
    [{id:'actual-source',kind:'test',passed:true,detail:{actual:'CURRENT-OBSERVATION'}}],
    [{criterion:'Current result',receiptIds:['actual-source']}]);
  assert.equal(calls,2);
  assert.deepEqual(summary.observations[0]!.citations,[{receiptId:'actual-source',field:'',quote:'{"actual":"CURRENT-OBSERVATION"}'}]);
});
