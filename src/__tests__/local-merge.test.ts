import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mergePullRequest, openPullRequest, prepareMergeCandidate } from '../github/git.js';

const exec = promisify(execFile);

async function repoWithPullRequest(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-local-merge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workdir = path.join(root, 'work');
  const remote = path.join(root, 'origin.git');
  await fs.mkdir(workdir);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: workdir })).stdout.trim();
  await exec('git', ['init', '--bare', '-b', 'main', remote]);
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.com');
  await git('remote', 'add', 'origin', remote);
  await fs.writeFile(path.join(workdir, 'a.txt'), 'base\n');
  await git('add', '-A');
  await git('commit', '-m', 'base');
  await git('push', 'origin', 'main');
  await git('checkout', '-b', 'feature');
  await fs.writeFile(path.join(workdir, 'b.txt'), 'feature\n');
  await git('add', '-A');
  await git('commit', '-m', 'feature');
  await git('push', 'origin', 'feature');
  const pr = await openPullRequest({ workdir, remotePath: remote, branch: 'feature', baseBranch: 'main', title: 'Feature', body: '' });
  return { workdir, remote, git, pr };
}

test('offline fixture mode merges a local pull request into the bare remote', async t => {
  const { workdir, remote, git, pr } = await repoWithPullRequest(t);
  const baseSha = (await exec('git', ['rev-parse', 'main'], { cwd: remote })).stdout.trim();
  const candidate = await prepareMergeCandidate({ workdir, baseSha, headSha: pr.headSha });
  const merged = await mergePullRequest({ workdir, remotePath: remote, prUrl: pr.prUrl, expectedHeadSha: pr.headSha,
    candidate, expectedBaseBranch: 'main' });
  assert.equal(merged.merged, true);
  const mainSha = (await exec('git', ['rev-parse', 'main'], { cwd: remote })).stdout.trim();
  assert.equal(mainSha, merged.mergeCommitSha);
  assert.equal((await exec('git', ['rev-parse', `${mainSha}^{tree}`], { cwd: remote })).stdout.trim(), candidate.treeSha);
  assert.deepEqual((await exec('git', ['rev-list', '--parents', '-n', '1', mainSha], { cwd: remote })).stdout.trim().split(' ').slice(1),
    [baseSha, pr.headSha]);
  // The caller's checkout is untouched and the head branch is cleaned up.
  assert.equal(await git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  assert.equal((await exec('git', ['branch', '--list', 'feature'], { cwd: remote })).stdout.trim(), '');
  // A retry after a lost response returns the recorded merge instead of merging twice.
  const again = await mergePullRequest({ workdir, remotePath: remote, prUrl: pr.prUrl, expectedHeadSha: pr.headSha });
  assert.equal(again.mergeCommitSha, merged.mergeCommitSha);
});

test('offline fixture merge refuses a head that moved after validation', async t => {
  const { workdir, remote, pr } = await repoWithPullRequest(t);
  await assert.rejects(
    mergePullRequest({ workdir, remotePath: remote, prUrl: pr.prUrl, expectedHeadSha: '0'.repeat(40) }),
    (error: Error & { code?: string }) => error.code === 'FACTORY_MERGE_CANDIDATE_MISMATCH',
  );
  const mainLog = (await exec('git', ['log', '--oneline', 'main'], { cwd: remote })).stdout.trim().split('\n');
  assert.equal(mainLog.length, 1);
});

test('a local pull request without an explicit remote path records metadata beside origin, not in the checkout', async t => {
  const { workdir, remote, git } = await repoWithPullRequest(t);
  await git('checkout', '-b', 'second');
  await fs.writeFile(path.join(workdir, 'c.txt'), 'second\n');
  await git('add', '-A');
  await git('commit', '-m', 'second');
  await git('push', 'origin', 'second');
  const pr = await openPullRequest({ workdir, remotePath: '', branch: 'second', baseBranch: 'main', title: 'Second', body: '' });
  assert.equal(pr.prUrl, `file://${remote.replace(/\.git$/, '')}/pull/${pr.prNumber}`);
  await fs.access(path.join(remote, 'prs', `${pr.prNumber}.json`));
  await assert.rejects(fs.access(path.join(workdir, 'prs')));
});

test('a forced branch push recovers from a stale tracking ref after the remote branch was deleted', async t => {
  const { commitAndPush } = await import('../github/git.js');
  const { workdir, git, remote } = await repoWithPullRequest(t);
  await git('fetch', 'origin');
  // The remote deletes the branch (e.g. merged with branch cleanup); the local tracking ref stays.
  await exec('git', ['branch', '-D', 'feature'], { cwd: remote });
  await fs.writeFile(path.join(workdir, 'b.txt'), 'revised\n');
  const pushed = await commitAndPush({ workdir, branch: 'feature', message: 'revise', force: true });
  assert.equal((await exec('git', ['rev-parse', 'feature'], { cwd: remote })).stdout.trim(), pushed.commitSha);
});
