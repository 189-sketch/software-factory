import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { promises as fs } from 'node:fs';

if (process.env.FACTORY_TEST_LEASE_COOLDOWN) registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/runtime/github-leases.mjs')) return { format: 'module', shortCircuit: true, source: `
      let observations = 0;
      export async function listGitHubLeases() { return ++observations === 1 ? [{ issueNumber: 1, dead: false }] : []; }
    ` };
    return nextLoad(url, context);
  },
});

if (process.env.FACTORY_TEST_SCAN_INBOX) {
  const readdir = fs.readdir;
  let scans = 0;
  fs.readdir = async function (directory, ...args) {
    if (directory === process.env.FACTORY_TEST_SCAN_INBOX && ++scans > 1 && !globalThis.factoryWorkerDispatched) {
      process.stderr.write('fixture remaining inbox scan waiting\n');
      await new Promise(resolve => { globalThis.factoryScanRelease = resolve; });
    }
    return readdir.call(this, directory, ...args);
  };
}

if (process.env.FACTORY_TEST_AUDIT) registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/scripts/reconciler.mjs')) return { format: 'module', shortCircuit: true, source: `
      export async function findStaleInFlight() {
        process.stderr.write('fixture audit waiting\\n');
        await new Promise(resolve => { globalThis.factoryAuditRelease = resolve; });
        if (process.env.FACTORY_TEST_AUDIT === 'failure') throw new Error('fixture historical audit unavailable');
        return [];
      }
    ` };
    return nextLoad(url, context);
  },
});

const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (args?.some(arg => /(?:run-issue\.js|run-issue\.ts)$/.test(arg)) && args.includes('--issue')) {
    if (!args.includes('--stage') && process.env.FACTORY_TEST_WORKER_MERGED === '1') {
      return originalSpawn(process.execPath, ['-e', `console.log(JSON.stringify({issue:1,status:'completed',merged:true}));`], options);
    }
    if (!args.includes('--stage') && (process.env.FACTORY_TEST_AUDIT || process.env.FACTORY_TEST_SCAN_INBOX)) {
      process.stderr.write('fixture worker dispatched before audit settled\n');
      globalThis.factoryWorkerDispatched = true;
      globalThis.factoryAuditRelease?.();
      globalThis.factoryScanRelease?.();
    }
    if (!args.includes('--stage') && process.env.FACTORY_TEST_WORKER_EXIT === '1') {
      return originalSpawn(process.execPath, ['-e', `
        const fs = require('node:fs');
        const path = require('node:path');
        const directory = path.join(process.env.FACTORY_STATE_DIR, 'issues');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, '1.json'), JSON.stringify({
          issue: { number: 1, title: 'Interrupted worker', body: 'Fixture', labels: ['implementing'], comments: [] },
          status: 'waiting', nextLabel: 'implementing', merged: false,
          stages: { implementation: { startedAt: new Date().toISOString(), status: 'running', runId: 'interrupted-fixture' } },
        }));
        process.exit(1);
      `], options);
    }
    return originalSpawn(process.execPath, ['-e', `
      process.stderr.write('fixture worker started\\n');
      setTimeout(() => {
        console.log(JSON.stringify({ issue: 1, status: 'waiting', nextLabel: 'ready-to-spec' }));
      }, ${args.includes('--stage') || process.env.FACTORY_TEST_AUDIT || process.env.FACTORY_TEST_SCAN_INBOX ? 0 : 11000});
    `], options);
  }
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
