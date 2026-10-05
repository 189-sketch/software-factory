// Read-only replay of a real review artifact; never publishes workflow evidence.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { isFactoryComment } from '../../runtime/business-input.mjs';
import { ReviewPrAgent, setReviewPrFetchImpl } from '../../src/agents/review-pr.ts';
import { restoreAnnotatedDiff } from '../../src/orchestrator/review-artifacts.ts';

const [repository, numberText, stateDir, envFile, workdir, reviewDir] = process.argv.slice(2);
const issueNumber = Number(numberText);
assert.ok(repository && Number.isSafeInteger(issueNumber) && issueNumber > 0 && stateDir && envFile && workdir && reviewDir);
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const defaultBranch = execFileSync('gh', ['repo', 'view', repository, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { encoding: 'utf8' }).trim();
process.loadEnvFile(envFile);
const state = await new GitHubStateStore({ repository, token, stateDir }).load(issueNumber);
assert.ok(state?.implementation?.commitSha && state.review, 'Requires a trusted implemented and reviewed issue');
const review = JSON.parse(await readFile(path.join(reviewDir, 'review.json'), 'utf8'));
const diff = await readFile(path.join(reviewDir, 'pr_diff.txt'), 'utf8');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim(), state.implementation.commitSha);
assert.equal(review.body, state.review.body, 'Review artifact must match the trusted current review');
assert.equal(restoreAnnotatedDiff(diff), execFileSync('git', ['diff', '--unified=3', `origin/${defaultBranch}...${state.implementation.commitSha}`],
  { cwd: workdir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }), 'Diff projection must preserve the entire real candidate patch');
const logger = { warn(message) { console.error(message); }, info() {}, error() {}, child() { return this; } };
const [owner, name] = repository.split('/');
const context = { issue: state.issue, repo: { owner, name, defaultBranch, workdir }, runId: 'read-only-review-replay', logger };
setReviewPrFetchImpl(async (url, options) => {
  const request = JSON.parse(options.body);
  const body = JSON.stringify(request);
  console.log(JSON.stringify({ revision: state.revision, requestBytes: Buffer.byteLength(body),
    stateBytes: Buffer.byteLength(JSON.stringify(request.state)), diffBytes: Buffer.byteLength(diff),
    comments: request.state.issue.comments.length, factoryCommentBytes: request.state.issue.comments.filter(isFactoryComment)
      .reduce((sum, comment) => sum + Buffer.byteLength(comment.body), 0), questions: Object.keys(request.questions).length,
    remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
  const response = await fetch(url, { ...options, body, signal: AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) });
  if (!response.ok) {
    const error = await response.clone().json().catch(() => null);
    console.log(JSON.stringify({ upstreamErrorFields: Object.keys(error?.detail ?? error ?? {}),
      numericLimits: Object.fromEntries(Object.entries(error?.detail ?? {}).filter(([, value]) => typeof value === 'number')) }));
  }
  return response;
});
try {
  const judgment = await new ReviewPrAgent(context).tryTypesafeBatch(diff, review);
  console.log(JSON.stringify({ realJudgment: true, available: Boolean(judgment), verdict: judgment?.b4?.value,
    remoteStateWrites: 0, productAcceptance: 'not-claimed' }));
  assert.ok(judgment, 'Real review judgment unavailable; no independent approval proof');
} finally { setReviewPrFetchImpl(null); }
