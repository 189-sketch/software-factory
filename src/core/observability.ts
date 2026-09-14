/**
 * Observability helpers (M6).
 *
 * The plan §5 M6 item 2 calls for every log line to carry the
 * canonical observability fields ("repository, issue, runId, stage,
 * artifactId, operationId, and event type" — whichever apply). The
 * factory daemon's existing structured logger accepts an arbitrary
 * bindings object; this module provides:
 *
 *   - the canonical binding keys as named exports, so callers don't
 *     end up with drift between "issue" / "issueNumber" / "number";
 *   - `withObsBindings(logger, ...)` — a builder that wraps the
 *     caller-supplied keys onto a child logger;
 *   - `summarizeUsage(usage)` — the M6 item 3 helper that renders a
 *     usage record and explicitly marks "unavailable" when the
 *     model did not report token counts (zero-cost reads are
 *     forbidden by §5 M6 — a missing usage record is NEVER zero).
 *   - `summarizeRecovery(recovery)` — the M6 item 4 helper that
 *     records a recovery plan and its actual outcome. The previous
 *     `self-healed` log line could fire without an actual successful
 *     recovery; the new contract logs the plan first, then the
 *     outcome, and only counts it as a success when an evidence field
 *     is present.
 */
import type { AgentLogger } from "./types.js";

export const OBSERV_KEYS = Object.freeze({
  repository: "repository",
  issue: "issue",
  issueNumber: "issueNumber",
  runId: "runId",
  stage: "stage",
  artifactId: "artifactId",
  operationId: "operationId",
  eventType: "eventType",
  ruleId: "ruleId",
  findingId: "findingId",
  requirementVersion: "requirementVersion",
});

/** The set of binding keys the plan §5 M6 names as canonical. */
export type CanonicalBindingKey = (typeof OBSERV_KEYS)[keyof typeof OBSERV_KEYS];

/**
 * Return a child logger that carries the canonical observability
 * bindings. Accepts a plain object so callers can spread conditionals
 * without having to construct the union twice.
 */
export function withObsBindings(
  logger: AgentLogger,
  bindings: Partial<Record<CanonicalBindingKey, unknown>>,
): AgentLogger {
  const defined: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bindings)) {
    if (v === undefined || v === null) continue;
    defined[k] = v;
  }
  if (Object.keys(defined).length === 0) return logger;
  return logger.child(defined);
}

/**
 * Shape of a usage record the harness already emits. Optional fields
 * are exactly the ones that may be missing on an upstream that does
 * not report them.
 */
export interface ModelUsage {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  totalTokens?: number | null;
}

/**
 * Summarize a usage record. When the upstream did NOT report token
 * counts, the summary explicitly says "unavailable" so operators
 * can tell "the model did not respond with usage" from "the model
 * actually used zero tokens". The plan §5 M6 item 3 forbids the
 * latter interpretation.
 */
export function summarizeUsage(usage: ModelUsage | undefined | null): {
  available: boolean;
  input: number | "unavailable";
  output: number | "unavailable";
  total: number | "unavailable";
  cacheRead: number | "unavailable";
  cacheWrite: number | "unavailable";
} {
  const u = usage ?? {};
  const present = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  return {
    available: present(u.input) || present(u.output) || present(u.totalTokens),
    input: present(u.input) ? u.input : "unavailable",
    output: present(u.output) ? u.output : "unavailable",
    total: present(u.totalTokens) ? u.totalTokens! : "unavailable",
    cacheRead: present(u.cacheRead) ? u.cacheRead : "unavailable",
    cacheWrite: present(u.cacheWrite) ? u.cacheWrite : "unavailable",
  };
}

/**
 * Recovery record. The plan §5 M6 item 4 forbids reporting a
 * recovery as successful without evidence. `outcome = succeeded` is
 * only valid when at least one of `receiptPath`, `remoteSha`, or
 * `verification` is set; otherwise callers should pass `outcome =
 * "unknown"` so the log line is honest.
 */
export interface RecoveryRecord {
  /** Short label, e.g. "lease-reclaim", "pr-merge-on-restart". */
  kind: string;
  issueNumber: number;
  plan: string;
  outcome: "succeeded" | "failed" | "unknown";
  /** Evidence fields — at least one must be set when outcome = succeeded. */
  receiptPath?: string;
  remoteSha?: string;
  verification?: string;
  error?: string;
}

const REQUIRED_EVIDENCE: Array<keyof RecoveryRecord> = ["receiptPath", "remoteSha", "verification"];

/**
 * Validate a recovery record and return a list of problems. An empty
 * list means the record is well-formed and may be logged as a
 * success.
 */
export function validateRecovery(record: RecoveryRecord): string[] {
  const problems: string[] = [];
  if (!record.kind) problems.push("missing kind");
  if (!Number.isSafeInteger(record.issueNumber)) problems.push("missing issueNumber");
  if (!record.plan) problems.push("missing plan");
  if (!["succeeded", "failed", "unknown"].includes(record.outcome)) {
    problems.push(`invalid outcome "${record.outcome}"`);
  }
  if (record.outcome === "succeeded") {
    const hasEvidence = REQUIRED_EVIDENCE.some((key) => {
      const v = record[key];
      return typeof v === "string" && v.length > 0;
    });
    if (!hasEvidence) {
      problems.push("succeeded recovery requires receiptPath, remoteSha, or verification");
    }
  }
  return problems;
}

/**
 * Build the structured log payload for a recovery record. Use this so
 * the log line is identical across the daemon and the orchestrator.
 */
export function formatRecoveryLog(record: RecoveryRecord): Record<string, unknown> {
  const problems = validateRecovery(record);
  const payload: Record<string, unknown> = {
    kind: record.kind,
    issue: record.issueNumber,
    plan: record.plan,
    outcome: record.outcome,
    evidence: {
      receiptPath: record.receiptPath ?? null,
      remoteSha: record.remoteSha ?? null,
      verification: record.verification ?? null,
    },
    error: record.error ?? null,
    problems,
  };
  return payload;
}