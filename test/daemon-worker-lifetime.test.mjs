import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

for (const mode of ['completed', 'interrupted', 'audit-wait', 'audit-failure', 'scan-wait', 'lease-cooldown', 'merged']) {
const interrupted = mode === 'interrupted';
const audit = mode.startsWith('audit-') ? mode.slice(6) : '';
test(mode === 'merged' ? 'real daemon completes merge cleanup before exiting without an unhandled rejection'
  : mode === 'lease-cooldown' ? 'real daemon releases undispatched work during lease cooldown so the next poll can recover'
  : mode === 'scan-wait' ? 'real daemon starts ready work before the rest of the inbox scan completes'
  : audit ? `real daemon dispatches ready work independently of historical audit ${audit}`
  : interrupted ? 'real daemon settles interrupted worker progress before releasing its lease'
  : 'real daemon lets a worker finish beyond the retired pipeline deadline', { timeout: 30000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-worker-lifetime-'));
  const inbox = path.join(root, 'inbox');
  const stateDir = path.join(root, 'state');
  let child;
  try {
    mkdirSync(inbox);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '--allow-empty', '-m', 'Fixture'], { cwd: root, stdio: 'ignore' });
    writeFileSync(path.join(inbox, '1.json'), JSON.stringify({ number: 1, title: 'Worker lifetime', body: 'Diagnostic fixture', labels: [] }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(FACTORY_|ANTHROPIC_|GH_|GITHUB_|NODE_OPTIONS$)/i.test(key)) delete env[key];
    Object.assign(env, {
      FACTORY_STATE_DIR: stateDir, FACTORY_WORKDIR: path.join(root, 'work'),
      FACTORY_RUN_TIMEOUT_MS: '10000', FACTORY_DECISIONS_ENABLED: '0', FACTORY_TRUSTED_EXECUTION: '1',
      FACTORY_SYNC_LABELS: '0', FACTORY_SYNC_PROJECTS: '0', FACTORY_DEFAULT_BRANCH: 'main',
      ANTHROPIC_AUTH_TOKEN: 'fixture-unused', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_MODEL: 'fixture-unused',
      FACTORY_TEST_WORKER_EXIT: interrupted ? '1' : '0',
      FACTORY_TEST_WORKER_MERGED: mode === 'merged' ? '1' : '0',
      FACTORY_TEST_AUDIT: audit,
      ...(mode === 'lease-cooldown' ? { FACTORY_TEST_LEASE_COOLDOWN: '1' } : {}),
      ...(mode === 'scan-wait' ? { FACTORY_TEST_SCAN_INBOX: inbox, FACTORY_WORKER_POOL_SIZE: '2' } : {}),
    });
    child = spawn(process.execPath, [
      '--import', pathToFileURL(fileURLToPath(new URL('./fixtures/daemon-worker-lifetime-preload.mjs', import.meta.url))).href,
      fileURLToPath(new URL('../scripts/factory-daemon.mjs', import.meta.url)),
      '--local-dir', inbox, ...(mode === 'lease-cooldown' ? ['--interval', '1'] : ['--once']), '--no-env-file', '--no-fallback-env',
    ], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (mode !== 'lease-cooldown') return;
      if (output.includes('process-issue-end')) child.kill();
    });
    child.stderr.on('data', chunk => { output += chunk; });
    const deadline = setTimeout(() => child.kill(), 25000);
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    clearTimeout(deadline);
    if (mode === 'lease-cooldown') {
      assert.match(output, /lease-wait-skip/);
      assert.match(output, /process-issue-end/, 'The same daemon must dispatch the item after the lease clears');
      assert.equal((output.match(/recovery-audit-started/g) ?? []).length, 1,
        'Completed historical audits must not repeat on every polling tick');
    }
    const state = JSON.parse(readFileSync(path.join(stateDir, 'state-1.json'), 'utf8'));
    assert.equal(state.exitCode, interrupted ? 1 : 0, output);
    assert.equal(state.outcome, interrupted ? 'failed' : mode === 'merged' ? 'completed' : 'waiting', output);
    if (mode !== 'lease-cooldown') assert.equal(code, interrupted ? 1 : 0, output);
    assert.doesNotMatch(output, /FACTORY_WORKER_TIMEOUT|pipeline exceeded/);
    if (mode === 'merged') {
      assert.match(output, /worktree-cleaned/);
      assert.doesNotMatch(output, /worktree-cleanup-failed|unhandledRejection/);
      assert.equal(existsSync(path.join(root, 'work', 'issue-1')), false);
    }
    if (audit) {
      assert.match(output, /fixture worker dispatched before audit settled/);
      assert.match(output, /recovery-audit-finished/);
      assert.ok(output.indexOf('fixture worker dispatched') < output.indexOf('recovery-audit-finished'), output);
      assert.doesNotMatch(output, /loop-error|unhandledRejection/);
      if (audit === 'failure') assert.match(output, /recovery-audit-failed/);
    }
    if (interrupted) {
      const progress = JSON.parse(readFileSync(path.join(stateDir, 'issues', '1.json'), 'utf8'));
      assert.equal(progress.stages.implementation.status, 'interrupted', output);
      assert.equal(progress.nextLabel, 'ready-to-implement', output);
      assert.equal(progress.wait.reason, 'runtime-retry', output);
      assert.match(output, /worker-progress-settled/);
    }
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-worker-lifetime-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
}
