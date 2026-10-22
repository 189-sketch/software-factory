/**
 * Failure classifier (M5) — plan §3.6.
 *
 * Before M5 every non-transient failure was a single opaque
 * `error.message` that triage-supervisor (an LLM) had to interpret
 * in order to decide retry vs. reroute vs. needs-info. The factory
 * dead-looped on issue #29 in 2026-09 because the supervisor
 * repeatedly chose `retry spec` for the same root cause (duplicate
 * spec directory) without ever questioning the choice.
 *
 * The classifier is a fast, deterministic categoriser that runs
 * BEFORE the supervisor. It:
 *
 *   1. Categorises the error into one of the plan §3.6 buckets
 *      (TRANSIENT / POLICY_BLOCK / USER_INPUT_REQUIRED / etc.).
 *   2. Returns a retry-policy table row with `maxAttempts` and a
 *      default `action` so the orchestrator can short-circuit
 *      obvious cases (PERMANENT → abort; POLICY_BLOCK → needs-info)
 *      without paying the LLM token cost.
 *   3. Records the classification in `state.failureCounts` so the
 *      same (stage, class) hitting the limit escalates
 *      automatically, regardless of what the supervisor "thinks".
 *
 * The classifier is conservative: when in doubt it returns the
 * `AGENT_REASONING` bucket (which routes through the supervisor).
 * A wrong classification should be a recoverable miss, not a wrong
 * abort.
 */
import type { FailureClass } from "./types.js";

/** Factory execution faults must bypass product failure routing and use daemon recovery. */
export function isFactoryRuntimeError(error: unknown): boolean {
  return /^FACTORY_(?:STATE|AGENT)_/.test(String((error as { code?: string } | null)?.code ?? ''));
}

/** Result of classifying one failure. The orchestrator reads
 * `maxAttempts` and `defaultAction` to decide whether the failure
 * should retry, escalate, or be sent to the supervisor LLM. */
export interface ClassifiedFailure {
  class: FailureClass;
  /** True when the classifier is confident in its category; the
   * orchestrator can apply `defaultAction` directly without
   * asking the supervisor. */
  confident: boolean;
  /** Retry budget for the same (stage, class) pair. */
  maxAttempts: number;
  /** Action the orchestrator takes when the retry budget is hit. */
  defaultAction: "retry" | "needs-info" | "abort" | "reroute";
  /** One-line human-readable reason; logged with the failure. */
  reason: string;
}

/**
 * Classify an unknown thrown value into a ClassifiedFailure.
 *
 * The classifier is a series of cheap regex / structural checks;
 * it never invokes a model. The output is paired with the
 * `failureCounts: Record<stage, Record<FailureClass, number>>`
 * map on the checkpoint so the orchestrator can decide "this is
 * the 3rd AGENT_REASONING failure for spec → escalate".
 */
export function classifyError(error: unknown): ClassifiedFailure {
  const e = error as {
    name?: string;
    code?: string;
    message?: string;
    stderr?: string;
    status?: number;
  } | null | undefined;
  const message = (e?.message ?? String(error ?? "")).toLowerCase();
  const stderr = (e?.stderr ?? "").toLowerCase();
  const haystack = `${message}\n${stderr}`;
  if (e?.code === 'FACTORY_SPEC_RUBRIC_REPEATED_FAILURE' || e?.code === 'FACTORY_SPEC_TYPESAFE_REVISIONS_EXHAUSTED') {
    return { class: 'AGENT_REASONING', confident: true, ...DEFAULT_FAILURE_POLICY.AGENT_REASONING,
      reason: 'legacy spec revision limit; continue targeted automatic repair' };
  }
  if (e?.code === 'FACTORY_PROJECT_VALIDATION_UNRESOLVED') {
    return { class: 'USER_INPUT_REQUIRED', confident: true, ...DEFAULT_FAILURE_POLICY.USER_INPUT_REQUIRED,
      reason: 'independent project validation requires a missing execution capability or external CI proof; model-selected replacement checks cannot bypass it' };
  }
  if (e?.code === 'FACTORY_VALIDATION_FAILED') {
    return { class: 'VALIDATION_FAILED', confident: true, ...DEFAULT_FAILURE_POLICY.VALIDATION_FAILED,
      reason: 'independent validation failed; diagnose the captured command against the preserved implementation' };
  }
  if (e?.code === 'FACTORY_COMMAND_TIMEOUT') {
    return { class: 'COMMAND_TIMEOUT', confident: true, ...DEFAULT_FAILURE_POLICY.COMMAND_TIMEOUT,
      reason: 'command-specific timeout; diagnose slow execution, blocked input, dependency/network waits or a hanging test from the captured evidence' };
  }

  // 1. SpecHashMismatchError + similar contract violations land in
  // CONTRACT_VIOLATION. The agent produced output that does not
  // match the on-disk body — retrying with the same prompt is the
  // best fix; escalating is also acceptable.
  if (
    e?.name === "SpecHashMismatchError" ||
    e?.code === "SPEC_HASH_MISMATCH" ||
    /expected.*found|did not match|missing required field|schema (?:mismatch|invalid)/i.test(haystack)
  ) {
    return {
      class: "CONTRACT_VIOLATION",
      confident: true,
      ...DEFAULT_FAILURE_POLICY.CONTRACT_VIOLATION,
      reason: "spec output violated a content contract (hash / schema / required field)",
    };
  }

  // 2. POLICY_BLOCK — `assertSafeAgentCommand` or any other safety
  // hook refused the action. Retrying with the same agent is
  // pointless; we should escalate so the operator can either
  // permit the action or rewrite the prompt.
  if (
    e?.name === "PolicyError" ||
    e?.code === "POLICY_BLOCK" ||
    /(?:not allowed|policy violation|assertsafe|forbidden command|blocked by policy)/i.test(haystack)
  ) {
    return {
      class: "POLICY_BLOCK",
      confident: true,
      maxAttempts: 0,
      defaultAction: "needs-info",
      reason: "agent command was refused by a safety policy",
    };
  }

  // 3. TRANSIENT — already-classified network / RPC / timeout
  // errors. We use the same regex vocabulary as
  // `isTransientNetworkError` so the retry budget is consistent
  // with the existing transient retry loop.
  if (
    e?.code === "ETIMEDOUT" ||
    /schannel|ssl\/tls|tls handshake|failed to receive handshake|eof\b|early eof|connection (?:reset|refused|timed out)|could not resolve host|http\/2|stream closed|pipe broken|peer closed/i.test(haystack)
  ) {
    return {
      class: "TRANSIENT",
      confident: true,
      maxAttempts: 3,
      defaultAction: "retry",
      reason: "transient network / TLS / timeout error",
    };
  }

  // 4. EXECUTOR_CRASH — the LLM CLI exited non-zero without a
  // parseable payload. Could be the CLI itself crashing; retry
  // once with the same prompt, then escalate.
  if (
    e?.code === "ENOENT" ||
    e?.code === "EACCES" ||
    /exited with code [^0]|spawn .* failed|cli error|subtype.*error_(?:max_turns|during_execution)|claude.*not found|node:bad option/i.test(haystack)
  ) {
    return {
      class: "EXECUTOR_CRASH",
      confident: true,
      maxAttempts: 2,
      defaultAction: "abort",
      reason: "LLM CLI crashed or exited non-zero",
    };
  }

  // 5. ENVIRONMENT — node_modules / git / fs / tool missing.
  if (
    /no such file|cannot find module|enoent|eacces|eperm|git lock|another.*process|index\.lock|fatal: not a git repository|out of disk|enospc/i.test(haystack)
  ) {
    return {
      class: "ENVIRONMENT",
      confident: true,
      maxAttempts: 2,
      defaultAction: "abort",
      reason: "environment / git / fs error",
    };
  }

  // 6. AGENT_FORMAT_ERROR — JSON parse miss, missing field, output
  // contract violation surfaced by the parser. Retry twice (the
  // model can usually fix on a second pass); on the third miss,
  // escalate.
  if (
    /json (?:parse|syntax)|expected.*property|missing field|invalid json|unexpected end of json|truncated/i.test(haystack)
  ) {
    return {
      class: "AGENT_FORMAT_ERROR",
      confident: true,
      ...DEFAULT_FAILURE_POLICY.AGENT_FORMAT_ERROR,
      reason: "agent output failed to parse / validate",
    };
  }

  // Unstructured prose cannot declare a human dependency or permanent
  // failure. Preserve it for the next agent and continue automatic repair.
  return {
    class: "AGENT_REASONING",
    confident: false,
    maxAttempts: DEFAULT_FAILURE_POLICY.AGENT_REASONING.maxAttempts,
    defaultAction: DEFAULT_FAILURE_POLICY.AGENT_REASONING.defaultAction,
    reason: "unclassified agent failure; preserve the error and retry with targeted correction",
  };
}

/** Lookup table for retry policy. The orchestrator should
 * consult this AFTER incrementing the per-(stage, class) counter
 * to decide what to do. The numbers match the policy table in
 * the plan. */
export const DEFAULT_FAILURE_POLICY: Record<FailureClass, { maxAttempts: number; defaultAction: "retry" | "needs-info" | "abort" | "reroute" }> = {
  COMMAND_TIMEOUT: { maxAttempts: Infinity, defaultAction: 'retry' },
  VALIDATION_FAILED: { maxAttempts: Infinity, defaultAction: 'retry' },
  TRANSIENT: { maxAttempts: 3, defaultAction: "retry" },
  POLICY_BLOCK: { maxAttempts: 0, defaultAction: "needs-info" },
  USER_INPUT_REQUIRED: { maxAttempts: 0, defaultAction: "needs-info" },
  CONTRACT_VIOLATION: { maxAttempts: Infinity, defaultAction: "retry" },
  AGENT_FORMAT_ERROR: { maxAttempts: Infinity, defaultAction: "reroute" },
  AGENT_REASONING: { maxAttempts: Infinity, defaultAction: "retry" },
  ENVIRONMENT: { maxAttempts: 2, defaultAction: "abort" },
  EXECUTOR_CRASH: { maxAttempts: 2, defaultAction: "abort" },
  PERMANENT: { maxAttempts: 0, defaultAction: "abort" },
};

/** Increment the per-(stage, FailureClass) counter and return
 * the new total. Pure function; the caller is responsible for
 * writing the result back to `state.failureCounts`. */
export function bumpFailureCount(
  state: { failureCounts?: Record<string, Record<FailureClass, number>> },
  stage: string,
  failureClass: FailureClass,
): number {
  const counts = { ...(state.failureCounts ?? {}) };
  const stageCounts = { ...(counts[stage] ?? {}) };
  const next = (stageCounts[failureClass] ?? 0) + 1;
  stageCounts[failureClass] = next;
  counts[stage] = stageCounts;
  state.failureCounts = counts;
  return next;
}

/** Decide whether the next retry should short-circuit. Returns
 * the action the orchestrator should take, or null when the
 * policy says "go to the supervisor LLM". The decision uses
 * `bumpFailureCount` to keep the counter consistent. */
export function nextFailureAction(
  state: { failureCounts?: Record<string, Record<FailureClass, number>> },
  stage: string,
  failureClass: FailureClass,
  policy: Record<FailureClass, { maxAttempts: number; defaultAction: "retry" | "needs-info" | "abort" | "reroute" }> = DEFAULT_FAILURE_POLICY,
): { action: "retry" | "needs-info" | "abort" | "reroute" | "supervisor"; budgetLeft: number; total: number } {
  const total = bumpFailureCount(state, stage, failureClass);
  const max = policy[failureClass].maxAttempts;
  if (max === 0) {
    return { action: policy[failureClass].defaultAction, budgetLeft: 0, total };
  }
  if (total >= max) {
    return { action: policy[failureClass].defaultAction, budgetLeft: 0, total };
  }
  return { action: "supervisor", budgetLeft: max - total, total };
}
