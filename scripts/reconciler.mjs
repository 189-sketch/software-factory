#!/usr/bin/env node
/**
 * Reconciler (M5) — periodic background tick that reconciles
 * factory state against the real world.
 *
 * Plan §46 calls for a periodic scan that catches:
 *   - in-flight `state.externalOps` rows older than threshold
 *     (caller crashed mid-side-effect → query GitHub to decide
 *     retry vs. confirm)
 *   - stale lease locks whose host pid is dead (already covered by
 *     `withStaleReclaim`, but the reconciler sweeps the directory
 *     on a timer so a daemon that never re-acquires a lock still
 *     gets its work back)
 *   - orphan worktrees whose issue is no longer in flight
 *
 * Design choices:
 *   - Pure: every helper is testable in isolation.
 *   - Side-effect bounded: the only I/O is reading the issue
 *     state files + writing back a `reconciler-tick` log line.
 *   - Composable: each sweep is a function `(config) => Promise<{...}>`,
 *     so a future caller can run a single sweep without booting
 *     the whole reconciler.
 *   - The reconciler is also importable from the daemon's main
 *     loop; no separate process. The factory-daemon's main loop
 *     already sleeps POLL_INTERVAL seconds; the reconciler
 *     piggybacks on that.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Default thresholds. The daemon can override these via the
 * `FACTORY_RECONCILER_*` env vars; for now we keep them as
 * hardcoded constants so the reconciler has no factory-config
 * dependency.
 */
const IN_FLIGHT_THRESHOLD_MS = 5 * 60 * 1000;     // 5 min
const LEASE_STALE_THRESHOLD_MS = 30 * 60 * 1000;  // 30 min
const WORKTREE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 h

/**
 * Result of one tick. Returned to the caller (the daemon) so it
 * can decide whether to log a summary or trigger remediation.
 *
 * @typedef {Object} ReconcilerReport
 * @property {Array<{issueNumber: number, opId: string, idempotencyKey: string, ageMs: number}>} inFlight
 * @property {Array<{issueNumber: number, lockFile: string, ageMs: number}>} staleLeases
 * @property {Array<{worktreePath: string, issueNumber: number, ageMs: number}>} orphanWorktrees
 * @property {string} ranAt
 */

/** @type {ReconcilerReport} */
const EMPTY_REPORT = { inFlight: [], staleLeases: [], orphanWorktrees: [], ranAt: "" };

/**
 * Find every `state.externalOps` row whose status is
 * `in-flight` and whose `updatedAt` is older than the threshold.
 * The daemon uses this list to call GitHub REST and decide
 * whether each op actually succeeded.
 */
export async function findStaleInFlight(
  stateDir,
  thresholdMs = IN_FLIGHT_THRESHOLD_MS,
) {
  const issuesDir = path.join(stateDir, "issues");
  let entries;
  try {
    entries = await fs.readdir(issuesDir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const now = Date.now();
  const out = [];
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    const issueNumber = Number(entry.replace(/\.json$/, ""));
    let state;
    try {
      const raw = await fs.readFile(path.join(issuesDir, entry), "utf8");
      state = JSON.parse(raw);
    } catch {
      continue;
    }
    const ops = state?.externalOps ?? [];
    for (const op of ops) {
      if (op?.status !== "in-flight") continue;
      const updatedAt = Date.parse(op.updatedAt ?? op.createdAt ?? "");
      if (Number.isNaN(updatedAt)) continue;
      const ageMs = now - updatedAt;
      if (ageMs < thresholdMs) continue;
      out.push({
        issueNumber,
        opId: op.id,
        idempotencyKey: op.idempotencyKey ?? `${issueNumber}@${op.kind}`,
        ageMs,
      });
    }
  }
  return out;
}

/**
 * Find lease lock files whose mtime is older than the threshold
 * AND whose owning host's pid is no longer running. Locks whose
 * owner host is alive are skipped (the daemon may legitimately
 * be holding them across polls).
 */
export async function findStaleLeases(
  stateDir,
  thresholdMs = LEASE_STALE_THRESHOLD_MS,
) {
  const leasesDir = path.join(stateDir, "leases");
  let entries;
  try {
    entries = await fs.readdir(leasesDir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const now = Date.now();
  const out = [];
  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue;
    const lockFile = path.join(leasesDir, entry);
    const stat = await fs.stat(lockFile).catch(() => null);
    if (!stat) continue;
    const ageMs = now - stat.mtimeMs;
    if (ageMs < thresholdMs) continue;
    let payload = null;
    try {
      payload = JSON.parse(await fs.readFile(lockFile, "utf8"));
    } catch {
      // Lock file unparseable → treat as stale and report.
    }
    if (payload?.pid && process.platform !== "win32") {
      try {
        process.kill(payload.pid, 0);
        // Owner is alive on POSIX → skip.
        continue;
      } catch {
        // Owner is dead → stale.
      }
    }
    const issueNumber = Number(entry.replace(/^issue-/, "").replace(/\.lock$/, ""));
    out.push({ issueNumber, lockFile, ageMs });
  }
  return out;
}

/**
 * Find worktrees in `factoryWorkdir` that are older than the
 * threshold and whose backing issue is no longer in the in-flight
 * issues directory. The reconciler does not delete them — the
 * daemon's existing worktree-cleanup-on-merge path is the only
 * one authorised to remove worktrees — but it surfaces them so
 * operators can decide.
 */
export async function findOrphanWorktrees(
  factoryWorkdir,
  stateDir,
  thresholdMs = WORKTREE_STALE_THRESHOLD_MS,
) {
  let entries;
  try {
    entries = await fs.readdir(factoryWorkdir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const now = Date.now();
  const inFlight = new Set();
  try {
    const stateFiles = await fs.readdir(path.join(stateDir, "issues"));
    for (const f of stateFiles) {
      const m = f.match(/^(\d+)\.json$/);
      if (m) inFlight.add(Number(m[1]));
    }
  } catch {
    // No state dir yet → every worktree is "orphan" by default.
  }
  const out = [];
  for (const entry of entries) {
    if (entry === "repository") continue; // The shared clone is never orphan.
    const m = entry.match(/^issue-(\d+)/);
    if (!m) continue;
    const issueNumber = Number(m[1]);
    if (inFlight.has(issueNumber)) continue;
    const fullPath = path.join(factoryWorkdir, entry);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) continue;
    const ageMs = now - stat.mtimeMs;
    if (ageMs < thresholdMs) continue;
    out.push({ worktreePath: fullPath, issueNumber, ageMs });
  }
  return out;
}

/**
 * Run every sweep and return a single report. Convenience entry
 * point for the daemon's main loop.
 */
export async function runReconciler(config) {
  const inFlight = await findStaleInFlight(config.stateDir, config.inFlightThresholdMs);
  const staleLeases = await findStaleLeases(config.stateDir, config.leaseStaleThresholdMs);
  const orphanWorktrees = await findOrphanWorktrees(config.workdir, config.stateDir, config.worktreeStaleThresholdMs);
  return { inFlight, staleLeases, orphanWorktrees, ranAt: new Date().toISOString() };
}

/**
 * CLI entry point: when run as `node reconciler.mjs` (e.g. as a
 * cron job), print a JSON report to stdout. The factory daemon
 * uses the importable functions directly instead of spawning
 * this script.
 */
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const stateDir = process.env.FACTORY_STATE_DIR ?? path.join(process.cwd(), ".factory");
  const workdir = process.env.FACTORY_WORKDIR ?? path.join(process.cwd(), "factory-workdir");
  const report = await runReconciler({ stateDir, workdir });
  console.log(JSON.stringify(report, null, 2));
}
