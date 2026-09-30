// scripts/needs-info-wake.mjs
//
// Helpers around the `needs-info-wake-<n>` polling-loop marker file.
// Lives in its own module (no daemon side-effects on import) so the
// `test/needs-info-wake-clear.unit.test.mjs` suite can import it for
// direct unit testing.
import fs from "node:fs";
import path from "node:path";

/**
 * Clear a consumed author-reply marker only when the final pipeline
 * state has advanced beyond needs-info. A transient triage advance
 * followed by a review rejection must not re-arm the same reply.
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
    if (triageLabel === "needs-info" || summary?.nextLabel === "needs-info") {
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
