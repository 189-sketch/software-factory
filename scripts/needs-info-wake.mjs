// scripts/needs-info-wake.mjs
//
// Helpers around the `needs-info-wake-<n>` polling-loop marker file.
// Lives in its own module (no daemon side-effects on import) so the
// `test/needs-info-wake-clear.unit.test.mjs` suite can import it for
// direct unit testing.
import fs from "node:fs";
import path from "node:path";

/**
 * Bug 2 fix: when a pipeline run observes a triage decision that
 * ADVANCES the issue past `needs-info`, remove the
 * `needs-info-wake-<issueNumber>` marker so the next poll can
 * re-fire the wake if the supervisor subsequently routes the issue
 * back to `needs-info`.
 *
 * The wake itself is edge-triggered by the latest non-factory author
 * comment's `createdAt`. The marker is set on the first wake and only
 * cleared on a crashed run via `releaseIssueClaim(issue, false)` —
 * which is correct for the normal "wake fires once, triage decides
 * needs-info, daemon parks" flow, but breaks when the supervisor
 * overrides an advancing triage verdict (Bug 1's symptom on
 * issue #34: triage said `ready-to-implement`, the spec-existence
 * check failed because the spec PR was rejected, the supervisor
 * routed the failure back to `needs-info`, and the wake never
 * re-fired because the marker still matched the latest comment).
 *
 * Without this clear the polling loop sees
 *   `authorVoice && alreadyWoke === true`
 * and skips the wake even though the supervisor has re-parked the
 * issue. With this clear, the next poll starts from a fresh
 * `alreadyWoke = false` and the wake re-fires — until triage agrees
 * with the supervisor (or the operator intervenes).
 *
 * Returns an object describing the outcome so the caller can log
 * without doing its own fs.stat. Throws nothing: missing summary or
 * missing marker file are both safe no-ops.
 *
 * @param {string} stateDir factory state dir (the daemon's STATE_DIR)
 * @param {number} issueNumber
 * @param {object} [summary] the pipeline's stdout-parsed summary JSON
 * @param {function} [logger] optional `(level, event, payload) => void`
 * @returns {{ removed: boolean, markerExisted: boolean, triageLabel: string|null, finalLabel: string|null }}
 */
export function clearNeedsInfoWakeIfTriageAdvanced(stateDir, issueNumber, summary, logger) {
    const triageLabel = summary?.triageResult?.label;
    if (typeof triageLabel !== "string" || triageLabel.length === 0) {
        return { removed: false, markerExisted: false, triageLabel: null, finalLabel: summary?.nextLabel ?? null };
    }
    if (triageLabel === "needs-info") {
        return { removed: false, markerExisted: false, triageLabel, finalLabel: summary?.nextLabel ?? null };
    }
    const wakeFile = path.join(stateDir, `needs-info-wake-${issueNumber}`);
    let existed = true;
    try { fs.rmSync(wakeFile, { force: true }); } catch { existed = false; }
    const finalLabel = summary?.nextLabel ?? null;
    if (typeof logger === "function") {
        try {
            logger("INFO", "needs-info-wake-cleared", {
                issue: issueNumber,
                triageLabel,
                finalLabel,
                markerExisted: existed,
            });
        } catch {}
    }
    return { removed: true, markerExisted: existed, triageLabel, finalLabel };
}
