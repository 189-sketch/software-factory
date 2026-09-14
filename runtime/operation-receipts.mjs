/**
 * Persistent operation receipts (M5).
 *
 * The plan §3.8 calls out that the factory must separate "the work
 * ran" from "the work's external effect was confirmed", and that a
 * failed external effect must leave a receipt (not just a log line)
 * so the next poll can decide retry vs. blocked vs. unknown.
 *
 * The lease-release half of that already has a sidecar: every lease
 * release now writes `<stateDir>/lease-receipts/issue-<n>.json` with
 * the owner, the expected sha (when the backend is GitHub-ref), the
 * actual sha observed at release time, and the resulting status. The
 * comment / label / PR / merge receipts reuse the same module so
 * future external operations have one place to write to.
 *
 * Kept dependency-free so it can be loaded from the daemon and any
 * future executor without dragging in the orchestrator.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const RECEIPT_STATUSES = Object.freeze({
  succeeded: "succeeded",
  failed: "failed",
  unknown: "unknown",
  retryWait: "retry-wait",
  blocked: "blocked",
});

/** Return the canonical path for a receipt of `operationKind` for an issue. */
export function receiptPath(stateDir, issueNumber, operationKind) {
  if (!Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) < 0) {
    throw new Error(`Invalid issue number: ${issueNumber}`);
  }
  // One file per (issue, kind). PR merges may write multiple entries
  // over time; the most recent is the one that matters, so writes
  // overwrite. Past receipts can be archived separately if needed.
  const safeKind = String(operationKind).replace(/[^a-z0-9-]/gi, "-");
  return path.join(stateDir, "receipts", `issue-${Number(issueNumber)}-${safeKind}.json`);
}

/**
 * Persist a receipt. Always overwrites — the caller decides what the
 * "current" receipt means. Missing directories are created.
 */
export async function recordReceipt(stateDir, issueNumber, operationKind, receipt) {
  const file = receiptPath(stateDir, issueNumber, operationKind);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = {
    issueNumber: Number(issueNumber),
    operationKind,
    status: receipt?.status ?? "unknown",
    attempt: typeof receipt?.attempt === "number" ? receipt.attempt : null,
    owner: receipt?.owner ?? null,
    expectedSha: receipt?.expectedSha ?? null,
    observedSha: receipt?.observedSha ?? null,
    error: receipt?.error ?? null,
    note: receipt?.note ?? null,
    recordedAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2));
  return payload;
}

/**
 * Read the current receipt for an issue + operation kind. Returns
 * null when there is no receipt yet.
 */
export async function readReceipt(stateDir, issueNumber, operationKind) {
  try {
    const raw = await fs.readFile(receiptPath(stateDir, issueNumber, operationKind), "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Remove a receipt. Missing files are a no-op. */
export async function clearReceipt(stateDir, issueNumber, operationKind) {
  try {
    await fs.unlink(receiptPath(stateDir, issueNumber, operationKind));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** List every receipt present in `<stateDir>/receipts/`. Used by the
 * panel "external state" view and by the migration preview. */
export async function listReceipts(stateDir) {
  const directory = path.join(stateDir, "receipts");
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const name of entries) {
    const match = name.match(/^issue-(\d+)-(.+)\.json$/);
    if (!match) continue;
    const raw = await fs.readFile(path.join(directory, name), "utf-8");
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Corrupt receipt — record its presence with an unknown body
      // rather than dropping it, so an operator can inspect.
      out.push({ issueNumber: Number(match[1]), operationKind: match[2], status: "unknown", error: "unparseable" });
    }
  }
  return out;
}