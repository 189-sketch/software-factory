#!/usr/bin/env node
import os from 'node:os';
import { resolveFactoryConfig } from '../runtime/factory-config.mjs';
import { GitHubStateStore } from '../runtime/github-state-store.mjs';
import { createLeaseManager } from '../runtime/lease-manager.mjs';

// Explicit operator confirmation, not automatic inference or a polling side effect.
const [numberText, id, outcome, ...reasonParts] = process.argv.slice(2);
const number = Number(numberText);
const reason = reasonParts.join(' ').trim();
if (!Number.isSafeInteger(number) || number < 1 || !id || !['succeeded', 'failed'].includes(outcome) || reason.length < 10) {
  throw new Error('Usage: resolve-external-op <issue> <operation-id> succeeded|failed <verified remote evidence, at least 10 characters>');
}
const config = resolveFactoryConfig();
if (config.state.backend !== 'github') throw new Error('Operator confirmation requires GitHub production state');
const options = { repository: config.github.repository, token: config.github.token, stateDir: config.paths.stateDir,
  writers: config.state.writers, defaultBranch: config.github.defaultBranch, staleMs: config.lease.staleMs };
const manager = createLeaseManager(options);
const lease = await manager.acquire(number, `${os.hostname()}:${process.pid}`);
if (!lease) throw new Error('需要你的操作：请先确认当前 worker 已结束，不能修改运行中的恢复记录。');
try {
  const store = new GitHubStateStore({ ...options, leaseSha: lease.sha });
  await store.recover(number);
  const state = await store.read(number);
  const operation = state.externalOps?.find((entry) => entry.id === id);
  if (!operation || !['in-flight', 'unknown', 'blocked'].includes(operation.status)) throw new Error('Operation is not awaiting confirmation');
  operation.status = outcome;
  operation.updatedAt = new Date().toISOString();
  operation.receipt = { ...operation.receipt, operatorConfirmation: reason };
  delete operation.error;
  if (state.wait?.reason === 'external-unknown') delete state.wait;
  await store.save(state);
  console.log(JSON.stringify({ issue: number, operation: id, outcome, revision: state.revision }));
} finally {
  await manager.release(lease);
}
