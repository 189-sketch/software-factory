
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

/** @deprecated Automatic repair limits are retired; zero denotes unlimited. */
export function resolveMaxAgentFailures(_raw: string | undefined): number {
  return 0;
}

/**
 * Parse the maximum-implementation-attempts env var. Pure function so
 * the validation rules can be unit-tested without touching
 * `process.env` module state.
 */
export function resolveMaxImplAttempts(_raw: string | undefined): number {
  return 0;
}

/** @deprecated Compatibility export; zero denotes unlimited automatic repair. */
export const MAX_AGENT_FAILURES = resolveMaxAgentFailures(process.env.FACTORY_MAX_AGENT_FAILURES);
