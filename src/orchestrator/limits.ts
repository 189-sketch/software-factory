
/**
 * Parse a strictly positive integer env var. Pure function so the
 * validation rules can be unit-tested without touching `process.env`.
 * Used by `resolveMaxAgentFailures` and `resolveMaxImplAttempts` so
 * the regex + fallback shape live in exactly one place.
 */
export function parsePositiveInteger(
  envName: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Invalid ${envName}: ${JSON.stringify(raw)} (must be a positive integer)`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${envName}: ${JSON.stringify(raw)} (must be a positive integer)`);
  }
  return value;
}

/**
 * Parse `FACTORY_MAX_AGENT_FAILURES`. Pure function so the validation
 * rules can be unit-tested without touching `process.env`.
 *
 * Accepts only positive integers. `0` is rejected so a typo doesn't
 * silently disable the cap and let an issue spin forever.
 */
export function resolveMaxAgentFailures(raw: string | undefined): number {
  return parsePositiveInteger("FACTORY_MAX_AGENT_FAILURES", raw, 50);
}

/**
 * Parse the maximum-implementation-attempts env var. Pure function so
 * the validation rules can be unit-tested without touching
 * `process.env` module state.
 */
export function resolveMaxImplAttempts(raw: string | undefined): number {
  return parsePositiveInteger("FACTORY_MAX_IMPL_ATTEMPTS", raw, 10);
}

/**
 * Mechanical loop breaker for the triage supervisor.
 *
 * Pure count of how many times the supervisor has judged a failure for
 * this issue. Triage decides WHAT to do about each failure (retry,
 * reroute, needs-info, abort); this cap bounds HOW MANY times it may
 * decide before an operator is required. Configurable via
 * `FACTORY_MAX_AGENT_FAILURES` (positive integer; default 50).
 *
 * Replaces three older counters that all measured "how stuck is this
 * issue" in different ways: `MAX_IMPL_ATTEMPTS`, `MAX_PARSE_FAILURE_HEALS`,
 * and the `specAttempts >= 3` ceiling. Unifying them means the same
 * knob governs every stage, and "is this issue stuck?" is a question
 * one counter answers instead of three.
 */
export const MAX_AGENT_FAILURES = resolveMaxAgentFailures(process.env.FACTORY_MAX_AGENT_FAILURES);
