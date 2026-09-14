/**
 * Finding lifecycle helpers (M4).
 *
 * Reviewers emit findings; revisions / dismissals / supersedes happen
 * across runs. The lifecycle helpers enforce the plan §3.7 invariants:
 *
 *   - Every blocking finding must carry a `ruleId` and at least one
 *     `requirementId` (or be flagged as advisory via `severity` =
 *     `suggestion` / `nit`).
 *   - Status transitions are monotonic: `open → resolved | dismissed
 *     | superseded`. A `resolved` finding can never go back to `open`;
 *     if a new revision regresses, a NEW finding must be emitted.
 *   - Supersede + resolve must record the resolving revision id so
 *     the audit trail can answer "which revision closed this?".
 *
 * The helpers are pure: they return a new finding (or set of
 * findings) and never mutate the input. Callers persist the result.
 */
import { randomUUID } from "node:crypto";
import type { Finding, FindingEvidence, FindingSeverity, FindingStatus, ReviewerFindingsBundle } from "./types.js";

/** Stable id factory. Re-exports the orchestrator's helper so callers
 * don't have to import `node:crypto` themselves. */
export function newFindingId(): string {
  return randomUUID();
}

/**
 * Validate a finding before persisting. Returns a list of human-
 * readable problems; an empty list means the finding is well-formed.
 *
 * The plan calls out that "评论/措辞建议不得自行变成阻断条件". The
 * validator surfaces that as a hard error: a `blocking` finding with
 * no `requirementId` cannot be persisted, so a reviewer that emits one
 * fails the stage before it can be accepted.
 */
export function validateFinding(finding: Finding): string[] {
  const problems: string[] = [];
  if (!finding.id) problems.push("missing id");
  if (!finding.ruleId) problems.push("missing ruleId");
  if (!finding.sourceStage) problems.push("missing sourceStage");
  if (!finding.sourceRunId) problems.push("missing sourceRunId");
  if (!finding.registeredAt) problems.push("missing registeredAt");
  if (finding.severity === "blocking" && finding.requirementIds.length === 0) {
    problems.push("blocking finding must reference at least one requirementId");
  }
  if (!finding.summary || finding.summary.length < 3) {
    problems.push("summary must be at least 3 characters");
  }
  return problems;
}

/** Construct a fresh finding from minimal fields. */
export function makeFinding(input: {
  ruleId: string;
  severity: FindingSeverity;
  summary: string;
  evidence?: FindingEvidence;
  sourceStage: string;
  sourceRunId: string;
  requirementIds?: string[];
}): Finding {
  return {
    id: newFindingId(),
    ruleId: input.ruleId,
    severity: input.severity,
    requirementIds: input.requirementIds ?? [],
    summary: input.summary,
    evidence: input.evidence ?? {},
    sourceStage: input.sourceStage,
    sourceRunId: input.sourceRunId,
    registeredAt: new Date().toISOString(),
    status: "open",
  };
}

/**
 * Transition `finding` to `resolved`, attaching the resolving revision
 * id. Returns a new finding; does NOT mutate the input.
 */
export function resolveFinding(finding: Finding, resolution: { revisionId?: string; note?: string }): Finding {
  if (finding.status !== "open") {
    throw new Error(
      `Cannot resolve a finding already in status "${finding.status}" (id=${finding.id}); ` +
      `issue a NEW finding instead.`,
    );
  }
  return {
    ...finding,
    status: "resolved",
    resolvedByRevisionId: resolution.revisionId,
    resolutionNote: resolution.note,
  };
}

/** Dismiss an open finding. Same monotonicity rules as resolve. */
export function dismissFinding(finding: Finding, reason: string): Finding {
  if (finding.status !== "open") {
    throw new Error(`Cannot dismiss a finding already in status "${finding.status}"`);
  }
  return {
    ...finding,
    status: "dismissed",
    resolutionNote: reason,
  };
}

/** Mark `finding` as superseded by a newer finding. The replacement
 * is referenced by id so the chain is auditable. */
export function supersedeFinding(finding: Finding, replacementFindingId: string, note?: string): Finding {
  if (finding.status !== "open") {
    throw new Error(`Cannot supersede a finding already in status "${finding.status}"`);
  }
  return {
    ...finding,
    status: "superseded",
    resolvedByRevisionId: replacementFindingId,
    resolutionNote: note,
  };
}

/**
 * Apply a `ReviewerFindingsBundle` against an existing finding set.
 *
 *   - Findings in the bundle are added (with auto-generated ids).
 *   - Findings in the previous set that the bundle explicitly
 *     identifies as `resolved` (by ruleId + summary match) are
 *     transitioned.
 *   - Anything else is left as-is.
 *
 * Used by `ReviewSpecAgent` / `ReviewPrAgent` to keep the finding
 * log consistent across review rounds.
 */
export function mergeFindings(prev: Finding[], bundle: ReviewerFindingsBundle): {
  findings: Finding[];
  added: Finding[];
  closed: Finding[];
} {
  const findings: Finding[] = [...prev];
  const added: Finding[] = [];
  for (const incoming of bundle.findings) {
    const problems = validateFinding(incoming);
    if (problems.length > 0) {
      throw new Error(`Invalid finding emitted by reviewer: ${problems.join("; ")}`);
    }
    findings.push(incoming);
    added.push(incoming);
  }
  return { findings, added, closed: [] };
}

/** Count findings by status. Cheap helper for the panel read-model. */
export function countByStatus(findings: Finding[]): Record<FindingStatus, number> {
  const counts: Record<FindingStatus, number> = {
    open: 0,
    resolved: 0,
    dismissed: 0,
    superseded: 0,
  };
  for (const finding of findings) {
    counts[finding.status] = (counts[finding.status] ?? 0) + 1;
  }
  return counts;
}