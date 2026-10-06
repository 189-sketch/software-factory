// Opt-in: trusted real history, real completion contract, no product acceptance claim.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { relocateLegacyEvidence } from '../../runtime/evidence-store.mjs';
import { createLeaseManager } from '../../runtime/lease-manager.mjs';
import { assertImplementationContract } from '../../src/orchestrator/contracts.ts';
import { resolveFactoryConfig } from '../../runtime/factory-config.mjs';

const [repository, numberText, sourceWorkdir, stateDir, mode] = process.argv.slice(2);
const issueNumber = Number(numberText);
if (!repository || !Number.isSafeInteger(issueNumber) || issueNumber < 1 || !sourceWorkdir || !stateDir
  || (mode && mode !== 'apply')) throw new Error('Usage: legacy-evidence-probe <repository> <issue> <checkout> <state-dir> [apply]');
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const store = new GitHubStateStore({ repository, token, stateDir });
const history = await store.history(issueNumber);
const verifications = history.map(record => record.envelope.snapshot.implementation?.behaviorVerification).filter(Boolean).reverse();
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let root;
let lease;
const manager = createLeaseManager({ repository, token, stateDir });
try {
  let workdir = await fs.realpath(sourceWorkdir);
  let destinationState = stateDir;
  if (mode === 'apply') {
    lease = await manager.acquire(issueNumber, `legacy-evidence-probe:${process.pid}`);
    if (!lease) throw new Error('Issue lease is busy; never migrate a live worker checkout');
  } else {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-real-evidence-'));
    const clone = path.join(root, 'project');
    const branch = git(workdir, 'branch', '--show-current');
    git(root, 'clone', '--no-hardlinks', '--branch', branch, workdir, clone);
    const untracked = git(workdir, 'ls-files', '--others', '--exclude-standard', '-z', '--', 'evidence').split('\0').filter(Boolean);
    for (const file of untracked) {
      assert.ok(file.startsWith('evidence/') && !file.split('/').includes('..'));
      const target = path.join(clone, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(workdir, file), target, 1); // COPYFILE_EXCL: preserve the cloned product files.
    }
    workdir = clone;
    destinationState = path.join(root, 'runtime');
  }
  const implementation = { branch: git(workdir, 'branch', '--show-current'), commitSha: git(workdir, 'rev-parse', 'HEAD') };
  const repo = { owner: repository.split('/')[0], name: repository.split('/')[1], defaultBranch: 'main', workdir };
  const config = resolveFactoryConfig({ cwd: workdir, env: {} });
  await assert.rejects(assertImplementationContract(implementation, repo, issueNumber, config), /dirty working tree/);
  const moved = await relocateLegacyEvidence({ workdir, stateDir: destinationState, repository, issueNumber }, verifications);
  assert.ok(moved.length > 0, 'No trusted legacy evidence was relocated');
  await assertImplementationContract(implementation, repo, issueNumber, config);
  console.log(JSON.stringify({ mode: mode ?? 'isolated-clone', trustedRevision: history.at(-1)?.envelope.revision,
    completionContract: 'passed', productAcceptance: 'not-claimed', moved, remoteStateWrites: 0 }));
} finally {
  if (lease) await manager.release(lease);
  if (root) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-real-evidence-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}
