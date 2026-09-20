/**
 * Shared time formatting helpers.
 *
 * The factory daemon and the agent runtime logger both want to render
 * ISO-style timestamps with a fixed UTC offset. Previously each had
 * its own copy of `formatUtc8Timestamp`, so any change to the format
 * had to be made in two places — and the agent logger
 * (`src/core/log.ts`) and the daemon support module
 * (`scripts/daemon-support.mjs`) drifted slightly in their import
 * paths.
 *
 * `formatTimestamp` here is the canonical implementation. The offset
 * is configurable via the `offsetHours` argument (default 8, matching
 * the prior behavior); callers that need a different locale can pass
 * a different value.
 */

const DEFAULT_OFFSET_HOURS = 8;

/**
 * Render `date` as an ISO-8601 string in UTC+offsetHours (default +08:00).
 * Uses `+HH:MM` suffix rather than the `Z` short form so log lines
 * unambiguously identify which offset they were rendered against.
 */
export function formatTimestamp(date = new Date(), offsetHours = DEFAULT_OFFSET_HOURS) {
  const offsetMs = offsetHours * 60 * 60 * 1000;
  return new Date(date.getTime() + offsetMs)
    .toISOString()
    .replace(/Z$/, formatOffset(offsetHours));
}

/**
 * Backwards-compatible alias for the old `formatUtc8Timestamp` symbol
 * (kept under the legacy name to avoid breaking callers that imported
 * it before this module existed). New code should call
 * `formatTimestamp` directly so the offset is explicit.
 */
export const formatUtc8Timestamp = formatTimestamp;

/** Render the offset as `HH:MM`, e.g. `8` → `"08:00"`, `-5` → `"-05:00"`. */
function formatOffset(offsetHours) {
  const sign = offsetHours < 0 ? "-" : "+";
  const abs = Math.abs(offsetHours);
  const hh = String(Math.trunc(abs)).padStart(2, "0");
  const mm = String(Math.round((abs - Math.trunc(abs)) * 60)).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}