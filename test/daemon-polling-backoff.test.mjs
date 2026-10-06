import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const probe = fileURLToPath(new URL('./fixtures/daemon-polling-backoff-probe.mjs', import.meta.url));
for (const args of [['--expect-backoff'], ['--once']]) {
  test(`real daemon polling ${args[0]} preserves execution boundaries`, { timeout: 35000 }, async () => {
    const { stdout } = await exec(process.execPath, [probe, ...args], { timeout: 30000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.remoteWrites, 0);
    assert.equal(result.workerStarts, 0);
  });
}
