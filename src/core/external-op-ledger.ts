/**
 * External operation ledger helpers (M5).
 *
 * `state.externalOps: ExternalOperation[]` is a typed slot in the
 * checkpoint that records the *intent* and *outcome* of every
 * GitHub-facing side effect the factory issues. Before M5 the
 * orchestrator wrote only the sidecar receipt under
 * `.factory/receipts/` and never updated `state.externalOps`, so a
 * crash between "issue the API call" and "record the receipt"
 * left the checkpoint with no record of which side effect was
 * in-flight. Recovery tools could not tell whether to retry.
 *
 * This module is the single writer for `state.externalOps`. The
 * `state.externalOps` array is mutated through the returned
 * reference so the orchestrator's checkpoint write captures the
 * full transition (intent → in-flight → succeeded | failed |
 * unknown) in one save.
 *
 * The state machine is a strict subset of plan §3.8:
 *   pending → in-flight → (succeeded | failed | unknown)
 * The library also handles `retry-wait` and `blocked` for backoff
 * and policy-block cases respectively.
 */
import { randomUUID } from "node:crypto";

import type { ExternalOperation, ExternalOperationKind, ExternalOperationStatus, FactoryIssueState } from "./types.js";

/** Inputs to the intent-recording step (called BEFORE the side effect). */
export interface BeginExternalOp {
  kind: ExternalOperationKind;
  /** Stable identity the executor uses to dedupe retries. For PR
   * creates this is `${issue}@${branch}`; for label syncs it is
   * `${issue}@${label}`. The daemon will skip a re-execution if it
   * sees a `succeeded` row with the same key. */
  idempotencyKey: string;
  /** Free-form payload describing the operation. */
  payload?: Record<string, unknown>;
  /** Expected remote state after success (commit SHA, PR number, …). */
  expectedRemote?: Record<string, unknown>;
  /** ISO timestamp; defaults to now. */
  createdAt?: string;
}

/** Inputs to the outcome-recording step (called AFTER the side effect). */
export interface FinishExternalOp {
  /** Same `id` returned by `beginExternalOp`. */
  id: string;
  status: ExternalOperationStatus;
  /** Free-form error message; truncated to a few hundred chars by callers. */
  error?: string;
  /** Receipt produced on a successful settle. For comments / labels
   * this is the API response id; for merges it is the merge commit
   * SHA. */
  receipt?: Record<string, unknown>;
  /** ISO timestamp; defaults to now. */
  updatedAt?: string;
}

/**
 * Pre-side-effect step: append a `pending` row to
 * `state.externalOps` (creating the array if absent). Returns the
 * new row's id so the caller can match the later finish.
 *
 * Idempotency: when an existing row with the same
 * `(kind, idempotencyKey)` and a non-terminal status is found, the
 * function returns its id without appending. This is how the daemon
 * avoids re-issuing the same side effect after a crash.
 */
export function beginExternalOp(state: FactoryIssueState, op: BeginExternalOp): { id: string; duplicate: boolean } {
  const existing = state.externalOps ?? [];
  const dup = existing.find(
    (e) => e.kind === op.kind && e.idempotencyKey === op.idempotencyKey && isTerminal(e.status) === false,
  );
  if (dup) {
    return { id: dup.id, duplicate: true };
  }
  const id = randomUUID();
  const row: ExternalOperation = {
    id,
    kind: op.kind,
    externalId: op.idempotencyKey,
    idempotencyKey: op.idempotencyKey,
    payload: op.payload ?? {},
    expectedRemote: op.expectedRemote,
    status: "pending",
    createdAt: op.createdAt ?? new Date().toISOString(),
    updatedAt: op.createdAt ?? new Date().toISOString(),
  };
  state.externalOps = [...existing, row];
  return { id, duplicate: false };
}

/**
 * Mark an in-flight row as in-flight. Called right before the
 * side effect is issued so a crash in the network window leaves
 * a row the reconciler can spot.
 */
export function markExternalOpInFlight(state: FactoryIssueState, id: string, updatedAt?: string): void {
  updateRow(state, id, (row) => ({ ...row, status: "in-flight", updatedAt: updatedAt ?? new Date().toISOString() }));
}

/** Terminal state: succeeded / failed / unknown / blocked. */
export function isTerminal(status: ExternalOperationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "unknown" || status === "blocked";
}

/**
 * Post-side-effect step: set the row's status to `succeeded`,
 * `failed`, or `unknown`. The `attempts` counter increments by 1
 * (the side effect used one attempt of its budget).
 */
export function finishExternalOp(state: FactoryIssueState, op: FinishExternalOp): void {
  updateRow(state, op.id, (row) => ({
    ...row,
    status: op.status,
    error: op.error,
    receipt: op.receipt,
    attempts: (row.attempts ?? 0) + 1,
    updatedAt: op.updatedAt ?? new Date().toISOString(),
  }));
}

/** Internal helper: immutably replace the row whose id matches. */
function updateRow(
  state: FactoryIssueState,
  id: string,
  updater: (row: ExternalOperation) => ExternalOperation,
): void {
  const list = state.externalOps ?? [];
  const next = list.map((row) => (row.id === id ? updater(row) : row));
  state.externalOps = next;
}

/**
 * Find the most recent row of `kind` with `idempotencyKey`. Used by
 * callers that need to look up a pre-existing row after a crash.
 */
export function findExternalOp(
  state: FactoryIssueState,
  kind: ExternalOperationKind,
  idempotencyKey: string,
): ExternalOperation | undefined {
  return (state.externalOps ?? []).find((e) => e.kind === kind && e.idempotencyKey === idempotencyKey);
}

/** Persist intent before an idempotent remote write and settle it afterwards. */
export async function runExternalOp<T>(
  state: FactoryIssueState,
  save: (state: FactoryIssueState) => Promise<unknown>,
  op: BeginExternalOp,
  execute: () => Promise<T>,
): Promise<T> {
  const { id } = beginExternalOp(state, op);
  markExternalOpInFlight(state, id);
  await save(state);
  let result: T;
  try {
    result = await execute();
  } catch (error) {
    finishExternalOp(state, { id, status: "unknown", error: String((error as Error).message ?? error).slice(0, 500) });
    await save(state);
    throw error;
  }
  finishExternalOp(state, { id, status: "succeeded" });
  await save(state);
  return result;
}
