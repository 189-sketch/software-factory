#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFactoryConfig } from "../runtime/factory-config.mjs";
import { listIssueStates } from "../runtime/issue-state.mjs";
import { listGitHubLeases } from "../runtime/github-leases.mjs";

const IN_FLIGHT_THRESHOLD_MS = 5 * 60 * 1000;
const LEASE_STALE_THRESHOLD_MS = 30 * 60 * 1000;
const WORKTREE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Read-only reconciliation of trusted GitHub recovery records, never old local production JSON. */
export async function findStaleInFlight(config, thresholdMs = IN_FLIGHT_THRESHOLD_MS, options = {}) {
  const documents = options.documents ?? await listIssueStates(config, options);
  const out = [];
  for (const document of documents) {
    for (const op of document.externalOps ?? []) {
      if (!["pending", "in-flight", "unknown"].includes(op.status)) continue;
      const ageMs = Date.now() - Date.parse(op.updatedAt ?? op.createdAt ?? "");
      if (!Number.isFinite(ageMs) || ageMs < thresholdMs) continue;
      out.push({ issueNumber: document.issue.number, opId: op.id, status: op.status,
        idempotencyKey: op.idempotencyKey, ageMs,
        requiredAction: "需要核对 GitHub 实际副作用；恢复记录未确认前不可当作成功或直接重放。" });
    }
  }
  return out;
}

export async function findStaleLeases(config, thresholdMs = LEASE_STALE_THRESHOLD_MS, options = {}) {
  const leases = options.leases ?? await listGitHubLeases(config, options.ghClient);
  return leases.filter((lease) => lease.dead || lease.malformed
    || (Number.isFinite(Date.parse(lease.acquiredAt)) && Date.now() - Date.parse(lease.acquiredAt) >= thresholdMs))
    .map((lease) => ({ ...lease, ageMs: lease.acquiredAt ? Date.now() - Date.parse(lease.acquiredAt) : null,
      requiredAction: "请核对持有者是否仍在运行；仅租约年龄不能证明可安全删除。" }));
}

export async function findOrphanWorktrees(config, thresholdMs = WORKTREE_STALE_THRESHOLD_MS, options = {}) {
  const leases = options.leases ?? await listGitHubLeases(config, options.ghClient);
  const protectedIssues = new Set(leases.map((lease) => lease.issueNumber));
  let entries;
  try { entries = await readdir(config.paths.workdir); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const name of entries) {
    const match = name.match(/^issue-(\d+)$/);
    if (!match || protectedIssues.has(Number(match[1]))) continue;
    const worktreePath = path.join(config.paths.workdir, name);
    const row = await stat(worktreePath);
    const ageMs = Date.now() - row.mtimeMs;
    if (ageMs >= thresholdMs) out.push({ worktreePath, issueNumber: Number(match[1]), ageMs });
  }
  return out;
}

export async function runReconciler(config, options = {}) {
  const [documents, leases] = await Promise.all([
    listIssueStates(config, options), listGitHubLeases(config, options.ghClient),
  ]);
  const observed = { ...options, documents, leases };
  const [inFlight, staleLeases, orphanWorktrees] = await Promise.all([
    findStaleInFlight(config, options.inFlightThresholdMs, observed),
    findStaleLeases(config, options.leaseStaleThresholdMs, observed),
    findOrphanWorktrees(config, options.worktreeStaleThresholdMs, observed),
  ]);
  return { inFlight, staleLeases, orphanWorktrees, ranAt: new Date().toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runReconciler(resolveFactoryConfig()), null, 2));
}
