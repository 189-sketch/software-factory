// Real daemon CLI over a failing local inbox. Never touches a business issue.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, mkdirSync, rmdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(path.join(os.tmpdir(), 'factory-polling-backoff-'));
const inbox = path.join(root, 'inbox');
const daemon = fileURLToPath(new URL('../../scripts/factory-daemon.mjs', import.meta.url));
writeFileSync(inbox, 'Not a directory');
const failures = [], recoveryEvents = [];
const once = process.argv.includes('--once');
let healthyTicks = 0, workerStarts = 0;
try {
  const child = spawn(process.execPath, [daemon, '--no-env-file', '--local-dir', inbox, '--interval', '1', ...(once ? ['--once'] : [])], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FACTORY_LOCAL_DIR: inbox, FACTORY_STATE_DIR: path.join(root, 'state'),
      FACTORY_WORKDIR: path.join(root, 'work'), FACTORY_GH_REPO: '', GH_TOKEN: '', GITHUB_TOKEN: '',
      FACTORY_INFRA_RETRY_BASE_MS: '1000', FACTORY_INFRA_RETRY_MAX_MS: '4000',
      FACTORY_WEBHOOK_PORT: '0', FACTORY_AGENT_MODE: 'llm', FACTORY_STATE_BACKEND: 'fixture',
      ANTHROPIC_AUTH_TOKEN: 'probe-only', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_MODEL: 'probe-only',
      FACTORY_TYPESAFE_OFF: '1', TYPESAFE_API_KEY: '', FACTORY_DECISIONS_ENABLED: '1' },
  });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 25000);
  let pending = '';
  child.stderr.resume();
  child.stdout.on('data', data => {
    pending += data.toString();
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const match = line.match(/ (loop-error|loop-recovered|daemon-tick|process-issue-start) (\{.*\})$/);
      if (!match) continue;
      const details = JSON.parse(match[2]);
      if (match[1] === 'process-issue-start') workerStarts++;
      if (match[1] === 'loop-recovered') recoveryEvents.push(details);
      if (match[1] === 'loop-error') {
        failures.push({ retryInMs: details.retryInMs, consecutiveFailures: details.consecutiveFailures,
          nextRetryAt: details.nextRetryAt, observedAt: Date.now() });
        if (failures.length === 4) { unlinkSync(inbox); mkdirSync(inbox); }
        if (failures.length === 5) child.kill('SIGTERM');
      }
      if (match[1] === 'daemon-tick') {
        healthyTicks++;
        if (healthyTicks === 1) { rmdirSync(inbox); writeFileSync(inbox, 'Not a directory again'); }
      }
    }
  });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timeout);
  console.log(JSON.stringify({ failureDelays: failures.map(row => row.retryInMs), healthyTicks,
    recoveryEvents: recoveryEvents.length, workerStarts, remoteWrites: 0, exitCode }));
  if (process.argv.includes('--expect-backoff')) {
    assert.deepEqual(failures.map(row => row.retryInMs), [1000, 2000, 4000, 4000, 1000]);
    assert.deepEqual(failures.map(row => row.consecutiveFailures), [1, 2, 3, 4, 1]);
    assert.equal(recoveryEvents.length, 1, 'Only a completed healthy tick confirms loop recovery');
    assert.equal(recoveryEvents[0].consecutiveFailures, 4);
    assert.ok(failures.every(row => Number.isFinite(Date.parse(row.nextRetryAt))));
    for (let index = 1; index < 4; index++) {
      assert.ok(failures[index].observedAt - failures[index - 1].observedAt >= failures[index - 1].retryInMs - 100,
        'The CLI must actually delay subsequent failed ticks');
    }
  }
  assert.equal(failures.length, once ? 1 : 5);
  assert.equal(healthyTicks, once ? 0 : 1);
  if (once) assert.equal(exitCode, 1, 'One-shot failure must terminate without retrying');
  assert.equal(workerStarts, 0);
} finally {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('factory-polling-backoff-'));
  rmSync(root, { recursive: true, force: true });
}
