/**
 * Distinguish a successful worker invocation from a completed product change.
 * A pipeline is complete only after its reviewed and verified PR is merged.
 */
export function classifyPipelineOutcome(exitCode, summary = {}) {
    if (exitCode !== 0) {
        return { executionOk: false, completed: false, outcome: "failed" };
    }
    if (summary.status === "completed" && summary.merged === true) {
        return { executionOk: true, completed: true, outcome: "completed" };
    }
    return { executionOk: true, completed: false, outcome: "waiting" };
}
