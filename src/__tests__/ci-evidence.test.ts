import test from 'node:test';
import assert from 'node:assert/strict';
import { ciEvidenceTool } from '../core/ci-evidence.js';
import { receiptCheckSupported } from '../agents/verify-behavior.js';
import { setGitHubFetchImplForTest, closeSharedAgent } from '../../runtime/github-rest.mjs';
import type { AgentContext } from '../core/types.js';

test('CI evidence reads the fixed commit, preserves every execution and never claims pending or mismatched checks passed',async t=>{
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'private-ci-test-token';
  t.after(()=>{if(token===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=token;setGitHubFetchImplForTest(null);closeSharedAgent();});
  const sha='a'.repeat(40);
  const ctx={repo:{owner:'fixed-owner',name:'fixed-repo'}} as AgentContext;
  const receipts:any[]=[];
  const tool=ciEvidenceTool(ctx,sha,receipt=>receipts.push(receipt));
  let calls=0, pending=false, wrongHead=false;
  setGitHubFetchImplForTest(async(url,options)=>{
    calls++;
    assert.equal(options?.method,'GET');
    assert.match(String(url),new RegExp(`/repos/fixed-owner/fixed-repo/commits/${sha}/check-runs`));
    const page=new URL(String(url)).searchParams.get('page');
    const rows=page==='1'?Array.from({length:100},(_,i)=>({id:i+1,name:i===0?'validate (ubuntu-latest)':`job-${i}`,
      head_sha:sha,status:'completed',conclusion:'success',html_url:`https://github.com/fixed-owner/fixed-repo/actions/runs/1/job/${i+1}`}))
      :[{id:101,name:'validate (windows-latest)',head_sha:wrongHead?'b'.repeat(40):sha,
        status:pending?'in_progress':'completed',conclusion:pending?null:'success',html_url:'https://github.com/fixed-owner/fixed-repo/actions/runs/1/job/101'}];
    return new Response(JSON.stringify({total_count:101,check_runs:rows}));
  });
  await assert.rejects(tool.execute({repository:'other/repo'},ctx),/no overrides/);
  assert.equal(calls,0);
  const good:any=await tool.execute({},ctx);
  assert.equal(good.passed,true);
  assert.equal(good.detail.headSha,sha);
  assert.equal(good.detail.checks.length,101,'Pagination cannot silently omit a required runner');
  assert.equal(good.detail.checks.at(-1).name,'validate (windows-latest)');
  assert.ok(!JSON.stringify(good).includes('private-ci-test-token'));
  assert.equal(receiptCheckSupported({criterion:'Both runners passed',requirementIds:['AC-9'],receiptIds:[good.id],passed:true},receipts),true);
  pending=true;
  const unfinished:any=await tool.execute({},ctx);
  assert.equal(unfinished.passed,false);
  assert.equal(unfinished.detail.checks.at(-1).status,'in_progress');
  assert.equal(receiptCheckSupported({criterion:'Both runners passed',requirementIds:['AC-9'],receiptIds:[unfinished.id],passed:true},receipts),false);
  pending=false;wrongHead=true;
  await assert.rejects(tool.execute({},ctx),/does not match the requested commit/);
  assert.equal(receipts.length,2,'Malformed or different-commit responses cannot mint an execution receipt');
});
