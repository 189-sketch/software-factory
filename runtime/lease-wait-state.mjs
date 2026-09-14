/**
 * Persistent lease-wait state.
 *
 * The factory daemon polls a list of issues per tick and acquires a lease
 * before processing each. When `LEASE_MANAGER.acquire()` returns null
 * (someone else already holds the lease), the daemon historically just
 * logged "issue-lease-busy" and moved on. Operators watching the panel
 * had no way to tell:
 *
 *   - which owner is holding the lease,
 *   - when the lease was acquired (so they can judge staleness
 *     themselves), or
 *   - when stale reclaim is enabled and would next kick in.
 *
 * The plan calls this F07: "缺少持久化的等待原因、下次调度时间和恢复动作".
 * This module is the fix: when acquire fails we write a small JSON
 * record under `<stateDir>/lease-waits/issue-<n>.json` containing the
 * wait reason, the holder, the blocked-at timestamp, and the
 * next-attempt-at the daemon will use on its next poll. The record is
 * cleared whenever the daemon successfully acquires or releases the
 * lease, so a stale wait-record always means "still busy".
 *
 * Kept dependency-free (only node:fs / node:path) so it can be loaded
 * from both the daemon and the panel read-model without pulling in the
 * factory orchestrator.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const LEASE_WAIT_REASONS = Object.freeze({
  /** Another process / owner already holds the lease. */
  busy: "lease-busy",
  /** Network or GitHub API failure prevented the acquisition attempt. */
  network: "lease-network-failed",
  /** Acquisition logic refused to proceed (e.g. owner mismatch in force-clear). */
  refused: "lease-refused",
});

/** Return the canonical file path for a lease-wait record. */
export function leaseWaitPath(stateDir, issueNumber) {
  if (!Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) < 0) {
    throw new Error(`Invalid lease issue number: ${issueNumber}`);
  }
  return path.join(stateDir, "lease-waits", `issue-${Number(issueNumber)}.json`);
}

/**
 * Record that an issue is waiting on a lease.
 *
 * @param stateDir     The factory state directory.
 * @param issueNumber  The issue that is blocked.
 * @param entry        The wait-record fields. `reason` and `blockedAt` are
 *                     required; everything else is best-effort metadata for
 *                     the panel.
 */
export async function recordLeaseWait(stateDir, issueNumber, entry) {
  const file = leaseWaitPath(stateDir, issueNumber);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const record = {
    issueNumber: Number(issueNumber),
    reason: entry?.reason ?? LEASE_WAIT_REASONS.busy,
    blockedAt: entry?.blockedAt ?? new Date().toISOString(),
    holder: entry?.holder ?? null,
    staleReclaimEnabled: Boolean(entry?.staleReclaimEnabled),
    staleMs: typeof entry?.staleMs === "number" ? entry.staleMs : null,
    expectedRecoveryAt: entry?.expectedRecoveryAt ?? null,
    note: entry?.note ?? null,
  };
  await fs.writeFile(file, JSON.stringify(record, null, 2));
  return record;
}

/**
 * Clear the wait record for an issue. Missing records are a no-op (the
 * caller shouldn't have to special-case ENOENT). Returns true when a
 * record was deleted, false when there was nothing to clear.
 */
export async function clearLeaseWait(stateDir, issueNumber) {
  const file = leaseWaitPath(stateDir, issueNumber);
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Read the current wait record, if any. Returns null when there is no
 * record (i.e. the issue is NOT blocked on a lease right now).
 */
export async function readLeaseWait(stateDir, issueNumber) {
  const file = leaseWaitPath(stateDir, issueNumber);
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * List every issue currently blocked on a lease. Useful for the panel
 * "stuck waiting" view; reads are cheap because records are tiny.
 */
export async function listLeaseWaits(stateDir) {
  const directory = path.join(stateDir, "lease-waits");
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const name of entries) {
    const match = name.match(/^issue-(\d+)\.json$/);
    if (!match) continue;
    const record = await readLeaseWait(stateDir, match[1]).catch(() => null);
    if (record) out.push(record);
  }
  return out;
}

/**
 * Compute the expected recovery time for a leased issue given the
 * recorded acquisition time and `staleMs`. Returns null when stale
 * reclaim is disabled — there is no automatic recovery time to
 * promise in that case.
 */
export function computeExpectedRecoveryAt(recordedAt, staleMs) {
  if (!staleMs || staleMs <= 0) return null;
  const at = Date.parse(recordedAt);
  if (!Number.isFinite(at)) return null;
  return new Date(at + staleMs).toISOString();
}