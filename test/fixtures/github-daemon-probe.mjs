// Opt-in real daemon integration. Credentials remain in process memory only.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [targetRoot, envFile, commandBudget] = process.argv.slice(2);
if (!targetRoot || !envFile) throw new Error('Usage: github-daemon-probe <target-root> <env-file>');
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
process.loadEnvFile(envFile);
Object.assign(process.env, {
  GH_TOKEN: token, FACTORY_GH_REPO: '189-sketch/software-factory-demo',
  FACTORY_LOCAL_DIR: '', FACTORY_ISSUE_LEASE_SHA: '', FACTORY_STATE_WRITERS: '',
  FACTORY_STATE_DIR: path.join(targetRoot, 'r3-runtime'),
  FACTORY_WORKDIR: path.join(targetRoot, 'core-daemon-managed'),
  FACTORY_REVIEW_DIR: path.join(targetRoot, 'r3-review-artifacts'),
  FACTORY_AUTO_MERGE: '1', FACTORY_SYNC_LABELS: '1', FACTORY_SYNC_PROJECTS: '0',
  FACTORY_TRUSTED_EXECUTION: '1', FACTORY_VERIFY_COMMAND: 'node bin/create-scaffold.js --help',
  ...(commandBudget === undefined ? {} : { FACTORY_COMMAND_TIMEOUT_MS: commandBudget }),
});
process.argv = [process.execPath, 'factory-daemon.mjs', '--no-env-file', '--interval', '10'];
// Keep the complete on-disk daemon log, but expose only safe lifecycle metadata here.
const writeLifecycle = console.log.bind(console);
console.log = line => {
  if (typeof line !== 'string') return;
  const match = line.match(/^(.*?) (INFO|WARN|ERROR|DEBUG) ([a-z0-9.-]+) (\{.*\})$/);
  if (!match || ['child-stdout', 'pipeline-failed', 'pipeline-waiting'].includes(match[3])) return;
  let details;
  try { details = JSON.parse(match[4]); } catch { return; }
  const safe = {};
  for (const key of ['issue', 'exitCode', 'stage', 'reason', 'previousRequestContractVersion',
    'requestContractVersion', 'active', 'queued', 'ready', 'processed', 'merged']) {
    const value = details[key];
    if (typeof value === 'number' || typeof value === 'boolean'
      || (typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value))) safe[key] = value;
  }
  writeLifecycle(`${match[1]} ${match[2]} ${match[3]} ${JSON.stringify(safe)}`);
};
await import('../../scripts/factory-daemon.mjs');
