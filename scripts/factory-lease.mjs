#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveFactoryConfig } from "../runtime/factory-config.mjs";
import { createLeaseManager } from "../runtime/lease-manager.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const issueNumber = Number(args.issue);
const config = resolveFactoryConfig({
  env: {
    ...process.env,
    FACTORY_GH_REPO: process.env.FACTORY_GH_REPO || process.env.GITHUB_REPOSITORY,
  },
  cwd: process.cwd(),
  cli: args["state-dir"] ? { stateDir: args["state-dir"] } : {},
});
const stateDir = config.paths.stateDir;
const receiptPath = path.resolve(args.receipt || path.join(stateDir, `lease-${issueNumber}.json`));
const manager = createLeaseManager({
  stateDir,
  repository: config.github.repository,
  token: config.github.token,
  defaultBranch: config.github.defaultBranch,
  staleMs: config.lease.staleMs,
});

if (!Number.isSafeInteger(issueNumber) || issueNumber < 0) {
  throw new Error("--issue must be a non-negative integer");
}

if (command === "acquire") {
  const force = Boolean(args.force);
  if (force) {
    // Drop any existing lease (orphan or otherwise) before attempting to acquire.
    // Useful for tests and operator recovery from a daemon that was killed
    // before it could release the lock. Errors that are NOT "not found" still
    // surface so operators can diagnose auth/network issues.
    await manager.clear(issueNumber);
  }
  const owner = String(args.owner || `${process.env.GITHUB_RUN_ID || process.pid}:${process.env.GITHUB_JOB || "worker"}`);
  const lease = await manager.acquire(issueNumber, owner);
  if (!lease) {
    process.stderr.write(`Issue #${issueNumber} already has an active factory lease\n`);
    process.exit(75);
  }
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  await fs.writeFile(receiptPath, JSON.stringify(lease));
  process.stdout.write(`${receiptPath}\n`);
} else if (command === "release") {
  const lease = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  await manager.release(lease);
  await fs.unlink(receiptPath).catch(() => {});
} else {
  process.stderr.write("Usage: factory-lease acquire|release --issue N [--owner ID] [--receipt FILE]\n");
  process.exit(2);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith("--")) out._.push(value);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) out[value.slice(2)] = argv[++index];
    else out[value.slice(2)] = true;
  }
  return out;
}
