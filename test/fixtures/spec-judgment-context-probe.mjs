// Opt-in read-only replay of current candidates and real historical review obligations.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { closeSharedAgent } from '../../runtime/github-rest.mjs';
import { buildSpecJudgmentState, buildSpecTypesafeRequest } from '../../src/agents/spec.ts';
import { isFactoryComment } from '../../src/core/factory-comments.ts';
import { buildJudgmentState } from '../../src/core/judgment-state.ts';

const [repository, numberText, stateDir, mode = 'verify', envFile] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && stateDir && Number.isSafeInteger(number) && number > 0);
assert.ok(['verify', 'judge'].includes(mode));
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
try {
  const store = new GitHubStateStore({ repository, token, stateDir });
  const current = await store.load(number);
  const history = await store.history(number);
  const rejected = history.toReversed().find(record => record.envelope.snapshot.specReview?.verdict === 'REJECT'
    && record.envelope.snapshot.specReview.findings?.length && record.envelope.snapshot.specs);
  assert.ok(current?.specs && rejected, 'Requires a real candidate and a trusted rejected specification');
  const prior = rejected.envelope.snapshot;
  const revision = { feedback: prior.specReview.body, previousProductBody: prior.specs.product.body,
    previousTechBody: prior.specs.tech.body, previousCommitSha: prior.specs.commitSha,
    previousVerdict: prior.specReview.verdict, specReviewFindings: prior.specReview.findings };
  const before = structuredClone({ current, revision });
  const packet = buildSpecJudgmentState({ issue: current.issue, runId: 'read-only-projection' }, revision, current.specs);
  const legacy = buildJudgmentState(current.issue, { factory: { failureCounts: {} } }, { specBody: current.specs.product.body });
  const factoryComments = packet.issue.comments.filter(isFactoryComment).length;
  const findings = packet.revision?.findings ?? [];
  const missingFindings = revision.specReviewFindings.filter(finding => !findings.some(item => item.id === finding.id)).length;
  console.log(JSON.stringify({ issue: number, revision: current.revision, rejectedRevision: rejected.envelope.revision,
    packetBytes: Buffer.byteLength(JSON.stringify(packet)), factoryComments, findings: revision.specReviewFindings.length,
    legacyPacketBytes: Buffer.byteLength(JSON.stringify(legacy)),
    legacyFactoryComments: legacy.issue.comments.filter(isFactoryComment).length,
    packetFieldBytes: Object.fromEntries(Object.entries(packet).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value) ?? '')])),
    technicalFieldBytes: Object.fromEntries(Object.entries(current.specs.tech).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value) ?? '')])),
    repeatedTechnicalFields: Object.fromEntries(Object.entries(current.specs.tech).filter(([key, value]) =>
      key !== 'body' && typeof value === 'string' && value && current.specs.tech.body.includes(value))
      .map(([key, value]) => [key, Buffer.byteLength(value)])),
    missingFindings, candidateBodyCurrent: packet.specBody === current.specs.product.body,
    remoteWrites: 0, workerStarts: 0, approval: 'not-claimed' }));
  assert.deepEqual({ current, revision }, before);
  {
    assert.equal(factoryComments, 0);
    assert.equal(missingFindings, 0);
    assert.deepEqual(packet.issue.comments.map(comment => comment.body), current.issue.comments.filter(comment => !isFactoryComment(comment)).map(comment => comment.body));
    assert.deepEqual(findings, revision.specReviewFindings);
    assert.deepEqual(packet.requirements.map(requirement => requirement.criterion), current.specs.product.acceptanceCriteria);
    assert.equal(packet.specBody, current.specs.product.body);
    assert.deepEqual(packet.technicalDesign.validationPlan, current.specs.tech.validationPlan);
    assert.deepEqual(packet.technicalDesign.openQuestions, current.specs.tech.openQuestions);
    assert.ok(!('body' in packet.technicalDesign));
  }
  if (mode === 'judge') {
    assert.ok(envFile, 'Live judgment requires an explicit credential file');
    process.loadEnvFile(envFile);
    assert.ok(process.env.TYPESAFE_API_KEY);
    const request = buildSpecTypesafeRequest(packet);
    request.model = process.env.FACTORY_TYPESAFE_MODEL || request.model;
    const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
      body: JSON.stringify(request), signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200, 'Live judgment must return a successful response');
    const result = await response.json();
    const questionIds = Object.keys(request.questions);
    assert.equal(Object.keys(result.answers).length, questionIds.length);
    for (const id of questionIds) assert.equal(result.answers[id]?.type, request.questions[id].type);
    console.log(JSON.stringify({ model: result.model, requestBytes: Buffer.byteLength(JSON.stringify(request)),
      questions: questionIds.length, answers: Object.keys(result.answers).length, usage: result.usage,
      remoteWrites: 0, workerStarts: 0, approval: 'not-claimed' }));
  }
} finally {
  closeSharedAgent();
}
