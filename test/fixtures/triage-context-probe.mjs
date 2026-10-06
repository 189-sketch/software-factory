// Capture the actual production triage request over trusted GitHub data without running a worker.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { closeSharedAgent } from '../../runtime/github-rest.mjs';
import { buildJudgmentState, stateHashFor } from '../../src/core/judgment-state.ts';
import { TriageAgent } from '../../src/agents/triage.ts';
import { isFactoryComment } from '../../src/core/factory-comments.ts';
import { hasSpecificationApproval } from '../../runtime/completion-contract.mjs';

const [repository, numberText, stateDir, mode = 'verify', envFile] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && stateDir && Number.isSafeInteger(number) && number > 0);
assert.ok(['diagnose', 'verify', 'judge'].includes(mode));
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
try {
  const current = await new GitHubStateStore({ repository, token, stateDir }).load(number);
  assert.ok(current?.specs);
  const reviewContext = { hasSpec: Boolean(current.specs), approved: hasSpecificationApproval(current),
    commitSha: current.specs.commitSha, findings: current.specReview?.findings ?? [] };
  const state = buildJudgmentState(current.issue, { factory: { failureCounts: {} } }, {
    repoSignals: { primaryLanguage: 'unknown', hasOpenSpec: reviewContext.hasSpec, hasOpenPRs: 0 },
    reviewFindings: reviewContext.findings,
  });
  const before = structuredClone(state);
  const agent = new TriageAgent({ issue: current.issue }, undefined, undefined, undefined, reviewContext);
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.TYPESAFE_API_KEY;
  const savedOff = process.env.FACTORY_TYPESAFE_OFF;
  process.env.TYPESAFE_API_KEY = 'read-only-request-capture-not-a-credential';
  delete process.env.FACTORY_TYPESAFE_OFF;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response('{}', { status: 503 });
  };
  try {
    await assert.rejects(agent.runTypesafeBatch(state, stateHashFor(state)));
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
    if (savedOff === undefined) delete process.env.FACTORY_TYPESAFE_OFF; else process.env.FACTORY_TYPESAFE_OFF = savedOff;
  }
  assert.ok(request);
  const factoryComments = request.state.issue.comments.filter(isFactoryComment).length;
  console.log(JSON.stringify({ issue: number, revision: current.revision,
    packetBytes: Buffer.byteLength(JSON.stringify(request.state)), factoryComments,
    unknownRepositoryFacts: Boolean(request.state.repoSignals),
    questions: Object.keys(request.questions).length, remoteWrites: 0, workerStarts: 0,
    providerCalls: 0, approval: 'not-claimed' }));
  assert.deepEqual(state, before);
  if (mode === 'diagnose') assert.ok(factoryComments > 0 && request.state.repoSignals?.hasOpenPRs === 0);
  else {
    assert.equal(factoryComments, 0);
    assert.equal(request.state.repoSignals, undefined);
    assert.deepEqual(request.state.issue.comments.map(comment => comment.body), current.issue.comments.filter(comment => !isFactoryComment(comment)).map(comment => comment.body));
    assert.deepEqual(request.state.specification.findings, reviewContext.findings);
    assert.equal(request.state.specification.approved, reviewContext.approved);
    assert.equal(request.state.specification.commitSha, current.specs.commitSha);
    assert.equal(stateHashFor(state), stateHashFor(before));
  }
  if (mode === 'judge') {
    assert.ok(envFile);
    process.loadEnvFile(envFile);
    assert.ok(process.env.TYPESAFE_API_KEY);
    request.model = process.env.FACTORY_TYPESAFE_MODEL || request.model;
    const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
      body: JSON.stringify(request), signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200);
    const result = await response.json();
    const ids = Object.keys(request.questions);
    assert.equal(Object.keys(result.answers).length, ids.length);
    for (const id of ids) assert.equal(result.answers[id]?.type, request.questions[id].type);
    console.log(JSON.stringify({ model: result.model, requestBytes: Buffer.byteLength(JSON.stringify(request)),
      answers: ids.length, usage: result.usage, providerCalls: 1,
      remoteWrites: 0, workerStarts: 0, approval: 'not-claimed' }));
  }
} finally {
  closeSharedAgent();
}
