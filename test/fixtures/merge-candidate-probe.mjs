// Read-only completion replay; counterfactual remote observations are not real merges or approvals.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { fetchPullRequest, fetchGitCommit, closeSharedAgent } from '../../runtime/github-rest.mjs';
import { canConfirmMergedImplementation, hasImplementationApproval, hasSpecificationApproval,
  hasAcceptanceCoverage, hasVerificationJudgment } from '../../runtime/completion-contract.mjs';
import { prepareMergeCandidate } from '../../src/github/git.ts';
import { publicSnapshot, encodeState, decodeStateComment } from '../../runtime/state-codec.mjs';

const [repository, numberText, stateDir, workdir, mode = 'diagnose'] = process.argv.slice(2);
const number = Number(numberText);
assert.ok(repository && stateDir && workdir && Number.isSafeInteger(number) && number > 0);
assert.ok(['diagnose', 'verify', 'merged-verify', 'serialization-diagnose', 'serialization-verify'].includes(mode));
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
try {
  const state = await new GitHubStateStore({ repository, token, stateDir }).load(number);
  if (!state || !hasImplementationApproval(state)) {
    console.log(JSON.stringify({ issue: number, statePresent: Boolean(state), revision: state?.revision,
      status: state?.status, implementationApproval: false,
      specificationApproval: state ? hasSpecificationApproval(state) : false,
      reviewApproved: state?.review?.verdict === 'APPROVE', reviewedHeadMatches: state?.reviewedSha === state?.implementation?.commitSha,
      verifiedHeadMatches: state?.verifiedSha === state?.implementation?.commitSha,
      semanticJudgment: hasVerificationJudgment(state?.implementation?.behaviorVerification),
      acceptanceCoverage: state ? hasAcceptanceCoverage(state.specs, state.implementation?.commitSha, state.implementation?.behaviorVerification) : false,
      remoteWrites: 0, workerStarts: 0, approval: 'not-claimed' }));
  }
  assert.ok(state && hasImplementationApproval(state), 'Requires actual current implementation approval');
  const prNumber = Number(/\/pull\/(\d+)$/.exec(state.implementation.prUrl)?.[1]);
  const pr = await fetchPullRequest({ repository, token, number: prNumber });
  const head = state.implementation.commitSha;
  const base = pr.base.sha;
  assert.equal(pr.head.sha, head);
  if (mode.startsWith('serialization-')) {
    const before = structuredClone(state);
    const candidate = await prepareMergeCandidate({ workdir, baseSha: base, headSha: head });
    const snapshot = publicSnapshot({ ...state, revision: 1, mergeCandidate: candidate });
    const encoded = encodeState({ version: 1, repository, issueNumber: number, revision: 1, parentHash: null, snapshot });
    const writer = 'read-only-serialization-probe';
    const comments = [...(encoded.chunks ?? []), encoded.body].map(body => ({ author: writer, body }));
    const decoded = decodeStateComment(comments.at(-1), { repository, issueNumber: number, writers: [writer], comments });
    const preserved = JSON.stringify(decoded.envelope.snapshot.mergeCandidate) === JSON.stringify(candidate);
    console.log(JSON.stringify({ issue: number, revision: state.revision, persistedCandidatePresent: Boolean(state.mergeCandidate),
      candidatePreservedByRecoveryCodec: preserved, mergeRouteMode: state.review.mergeRoute?.mode,
      recoveryBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      localRoundTripOnly: true, remoteWrites: 0, workerStarts: 0, approval: 'not-claimed' }));
    assert.equal(preserved, mode === 'serialization-verify');
    assert.deepEqual(state, before);
  } else if (mode === 'merged-verify') {
    assert.equal(pr.merged, true, 'Requires an actual already-merged PR');
    const commit = await fetchGitCommit({ repository, token, sha: pr.merge_commit_sha });
    const headCommit = await fetchGitCommit({ repository, token, sha: head });
    const before = structuredClone(state);
    const confirmsActualMergedCandidate = canConfirmMergedImplementation(state, pr, pr.base.ref, commit, headCommit);
    console.log(JSON.stringify({ issue: number, revision: state.revision, actualMerged: pr.merged,
      confirmsActualMergedCandidate, actualTreeEqualsVerifiedHead: commit.tree?.sha === headCommit.tree?.sha,
      actualParentsMatchReviewedCandidate: commit.parents?.length === 2 && commit.parents[0]?.sha === state.reviewedBaseSha
        && commit.parents[1]?.sha === head,
      legacyProofMigration: !state.mergeCandidate, remoteWrites: 0, workerStarts: 0, approval: 'not-claimed' }));
    assert.deepEqual(state, before);
    assert.equal(confirmsActualMergedCandidate, true);
    process.exitCode = 0;
  } else {
  const git = (...args) => execFileSync('git', args, { cwd: workdir, encoding: 'utf8' }).trim();
  const implementationTree = git('rev-parse', `${head}^{tree}`);
  const candidateTree = git('merge-tree', '--write-tree', base, head);
  const before = structuredClone(state);
  const projected = { ...pr, merged: true, merge_commit_sha: 'counterfactual-merge' };
  const changedBase = { ...projected, base: { ...pr.base, sha: head } };
  let acceptsChangedBase, acceptsValidatedCandidate;
  if (mode === 'diagnose') {
    acceptsChangedBase = canConfirmMergedImplementation(state, changedBase, pr.base.ref);
  } else {
    const candidate = await prepareMergeCandidate({ workdir, baseSha: base, headSha: head });
    const scoped = { ...state, mergeCandidate: candidate };
    const commit = { sha: projected.merge_commit_sha, tree: { sha: candidate.treeSha }, parents: [{ sha: base }, { sha: head }] };
    acceptsValidatedCandidate = canConfirmMergedImplementation(scoped, projected, pr.base.ref, commit);
    acceptsChangedBase = canConfirmMergedImplementation(scoped, changedBase, pr.base.ref,
      { ...commit, parents: [{ sha: head }, { sha: head }] });
    assert.equal(acceptsValidatedCandidate, true, 'Must admit the actual validated candidate, not reject everything');
    assert.equal(canConfirmMergedImplementation(scoped, projected, pr.base.ref, { ...commit, tree: { sha: base } }), false);
    assert.equal(canConfirmMergedImplementation(scoped, projected, pr.base.ref), false);
  }
  console.log(JSON.stringify({ issue: number, revision: state.revision,
    mergeRouteMode: state.review.mergeRoute?.mode, reviewedBaseMatchesRemote: state.reviewedBaseSha === base,
    candidateTree, implementationTree, candidateEqualsVerifiedImplementation: candidateTree === implementationTree,
    acceptsChangedBase, acceptsValidatedCandidate, reviewConfidence: state.review.confidence,
    blockingFindings: state.review.findings?.filter(f => ['blocking', 'important'].includes(f.severity) && f.status === 'open').length,
    counterfactualOnly: true, remoteWrites: 0, workerStarts: 0, approval: 'not-claimed' }));
  assert.deepEqual(state, before);
  assert.equal(acceptsChangedBase, mode === 'diagnose');
  }
} finally {
  closeSharedAgent();
}
