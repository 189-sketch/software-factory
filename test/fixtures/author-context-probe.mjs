// Read-only replay of the actual author replies passed to generation agents.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fetchIssue, listIssueComments, closeSharedAgent } from '../../runtime/github-rest.mjs';
import { isFactoryComment } from '../../src/core/factory-comments.ts';
import { buildTriageEvidenceBlock } from '../../src/agents/triage.ts';
import { formatIssueEvidence } from '../../src/agents/spec.ts';

const [repository, numberText, mode = 'diagnose'] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && Number.isSafeInteger(number) && number > 0);
assert.ok(['diagnose', 'verify'].includes(mode));
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
try {
  const issue = await fetchIssue({ repository, token, number });
  issue.comments = await listIssueComments({ repository, token, number });
  const before = structuredClone(issue);
  const authors = issue.comments.filter(comment => !isFactoryComment(comment));
  const longReplies = authors.filter(comment => comment.body.length > 800);
  assert.ok(longReplies.length, 'Requires a real author reply longer than the old cutoff');
  const triage = buildTriageEvidenceBlock(issue, undefined, false);
  const spec = formatIssueEvidence(issue);
  const missing = longReplies.filter(comment => !triage.includes(comment.body)).length;
  const missingSpec = longReplies.filter(comment => !spec.includes(comment.body)).length;
  console.log(JSON.stringify({ issue: number, humanReplies: authors.length,
    longReplyLengths: longReplies.map(comment => comment.body.length), missingTriageReplies: missing, missingSpecReplies: missingSpec,
    remoteWrites: 0, workerStarts: 0, approval: 'not-claimed' }));
  assert.deepEqual(issue, before);
  if (mode === 'diagnose') {
    assert.equal(missing, longReplies.length);
    assert.equal(missingSpec, longReplies.length);
  } else {
    assert.equal(missing, 0);
    assert.equal(missingSpec, 0);
  }
} finally {
  closeSharedAgent();
}
