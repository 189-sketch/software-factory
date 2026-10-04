// Opt-in real daemon integration. Credentials remain in process memory only.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [targetRoot, envFile] = process.argv.slice(2);
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
});
process.argv = [process.execPath, 'factory-daemon.mjs', '--no-env-file', '--interval', '10'];
await import('../../scripts/factory-daemon.mjs');
