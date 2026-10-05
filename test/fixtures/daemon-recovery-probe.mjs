// Real daemon admission probe. No model, GitHub write, or product acceptance is simulated.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RecoveryScheduler } from '../../runtime/recovery-scheduler.mjs';

const exec = promisify(execFile);
const factoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function daemonRecoveryProbe(projectRoot) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-daemon-recovery-'));
  const repo = path.join(root, 'repository');
  const stateDir = path.join(root, 'runtime');
  const inbox = path.join(root, 'inbox');
  const workdir = path.join(root, 'workdir');
  let child;
  let output = '';
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(FACTORY_|ANTHROPIC_|GH_|GITHUB_|NODE_OPTIONS$)/i.test(key)) delete env[key];
  Object.assign(env, { FACTORY_STATE_DIR: stateDir, FACTORY_WORKDIR: workdir, FACTORY_DEFAULT_BRANCH: 'main',
    FACTORY_DECISIONS_ENABLED: '0', FACTORY_TRUSTED_EXECUTION: '0',
    FACTORY_INFRA_RETRY_BASE_MS: '60000', FACTORY_INFRA_RETRY_MAX_MS: '180000',
    ANTHROPIC_AUTH_TOKEN: 'probe-not-used', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_MODEL: 'probe-not-used' });
  const scheduler = new RecoveryScheduler({ stateDir, repository: `fixture:${inbox}`, baseDelayMs: 60000, maxDelayMs: 180000 });
  const waitUntil = async predicate => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      if (child?.exitCode !== null || Date.now() > deadline) throw new Error(`Daemon probe failed: ${output.slice(-4000)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const start = () => {
    child = spawn(process.execPath, [path.join(factoryRoot, 'scripts/factory-daemon.mjs'), '--local-dir', inbox,
      '--interval', '0.2', '--no-env-file', '--no-fallback-env'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM');
    await closed;
  };
  try {
    await fs.mkdir(inbox);
    if (projectRoot) await exec('git', ['clone', '--no-hardlinks', '--branch', 'main', path.resolve(projectRoot), repo]);
    else {
      await fs.mkdir(repo);
      await exec('git', ['init', '-b', 'main'], { cwd: repo });
      await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '--allow-empty', '-m', 'Fixture'], { cwd: repo });
    }
    const issue = number => ({ number, title: 'Runtime admission diagnostic', body: 'Not a product acceptance run', labels: [] });
    await fs.writeFile(path.join(inbox, '1.json'), JSON.stringify(issue(1)));
    start();
    await waitUntil(async () => Boolean(await scheduler.read(1)));
    await new Promise(resolve => setTimeout(resolve, 900));
    process.kill(child.pid, 0); // Confirm the actual daemon remains live during repeated polling.
    const first = await scheduler.read(1);
    assert.equal(first.attempts, 1);
    assert.match(first.failure.code, /FACTORY_WORKER_UNCAUGHT/);
    await stop();
    start();
    await waitUntil(() => (output.match(/daemon-start/g) ?? []).length >= 2);
    await new Promise(resolve => setTimeout(resolve, 900));
    process.kill(child.pid, 0);
    assert.equal((await scheduler.read(1)).attempts, 1, 'restart must not bypass quarantine');
    assert.equal((output.match(/starting-pipeline \{"issue":1,/g) ?? []).length, 1, 'unchanged input did not repeatedly start a worker');
    assert.equal((await scheduler.read(0)).attempts, 1, 'maintenance failure did not starve ordinary dispatch');
    await fs.writeFile(path.join(inbox, '2.json'), JSON.stringify(issue(2)));
    await waitUntil(async () => Boolean(await scheduler.read(2)));
    assert.equal((await scheduler.read(2)).attempts, 1, 'another issue can reach execution independently');
    assert.equal((output.match(/starting-pipeline \{"issue":2,/g) ?? []).length, 1);
    assert.equal((await scheduler.read(1)).attempts, 1);
    await fs.writeFile(path.join(inbox, '1.json'), JSON.stringify({ ...issue(1), body: 'New diagnostic input' }));
    await waitUntil(async () => (await scheduler.read(1))?.context !== first.context);
    assert.equal((await scheduler.read(1)).attempts, 1, 'changed input starts a new recovery context');
    assert.equal((output.match(/starting-pipeline \{"issue":1,/g) ?? []).length, 2);
    await stop();
    assert.ok(!await fs.stat(path.join(stateDir, 'issues')).catch(() => null), 'scheduler did not fabricate business state');
    const result = { source: projectRoot ? path.resolve(projectRoot) : 'isolated-git-fixture',
      unchangedStarts: 1, restartPreserved: true, maintenanceIsolated: true, otherIssueAdmitted: true,
      changedInputAdmitted: true, workflowWrites: 0, githubWrites: 0 };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await stop();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-daemon-recovery-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await daemonRecoveryProbe(process.argv[2]);
}
