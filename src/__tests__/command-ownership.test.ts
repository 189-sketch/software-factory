import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { executeCommand } from '../core/command-execution.js';

for (const stdio of ['ignore', 'inherit'] as const) {
test(`a completed command ends ${stdio} background descendants and releases executable locks`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-command-owner-'));
  const heartbeat = path.join(root, 'heartbeat');
  const pidFile = path.join(root, 'pid');
  const executable = process.platform === 'win32' ? path.join(root, 'owned-node.exe') : process.execPath;
  if (process.platform === 'win32') await fs.copyFile(process.execPath, executable);
  t.after(async () => {
    const pid = await fs.readFile(pidFile, 'utf8').then(Number, () => 0);
    if (pid) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else process.kill(pid, 'SIGKILL');
      } catch { /* It should already be gone. */ }
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('factory-command-owner-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = `const fs=require('node:fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20)`;
  const launcher = `const fs=require('node:fs');const child=require('node:child_process').spawn(${JSON.stringify(executable)},['-e',${JSON.stringify(source)}],{detached:process.platform==='win32',stdio:${JSON.stringify(stdio)}});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();setTimeout(()=>{process.stdout.write('launcher completed');process.stderr.write('exact stderr');process.exit(7)},500)`;
  await assert.rejects(executeCommand(process.execPath, ['-e', launcher], { cwd: root, env: process.env, timeoutMs: 10000 }),
    (error: any) => { assert.equal(error.code, 7); assert.equal(error.killed, false); assert.equal(error.stdout, 'launcher completed'); assert.equal(error.stderr, 'exact stderr'); return true; });
  const before = await fs.readFile(heartbeat, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await fs.readFile(heartbeat, 'utf8'), before, 'A surviving descendant can lock dependencies during npm ci');
  if (process.platform === 'win32') await fs.unlink(executable);
});
}
