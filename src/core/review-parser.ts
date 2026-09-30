/**
 * Shared reviewer-output parser (M4).
 *
 * Both `ReviewSpecAgent` and `ReviewPrAgent` use the same JSON
 * transport-layer parsing: salvage malformed JSON, drop bad inline
 * comments, translate textual severity markers into structured
 * `Finding[]`, and downgrade an APPROVE verdict that contains blocking
 * findings. The only difference is whether the result carries a
 * `notes` field (spec review keeps it; PR review does not).
 *
 * `parseReviewerOutput` owns the shared shape so the two agents only
 * pass in their stage-specific extras.
 */
import { jsonObject } from "./output.js";
import {
  containsBlockingFindingFromList,
  extractFindingsFromText,
} from "../agents/review-spec.js";
import type { Finding, ReviewComment, ReviewResult, SpecReviewResult } from "./types.js";

export interface ReviewerOutputExtras {
  /** When true, the parser populates a `notes` field on the result. */
  includeNotes?: boolean;
  /** Stage name used when translating severity markers into findings. */
  stage: "review-spec" | "review-pr";
  /** Run id stamped on each structured finding. */
  sourceRunId: string;
  /**
   * M5: stable acceptance-criterion ids the spec was written
   * against. When present, `extractFindingsFromText` will pull
   * `AC-N` / `VP-N` tokens from each finding's summary and use
   * them as the finding's real `requirementId`. Without this
   * list the parser falls back to the synthetic
   * `text-extracted:<stage>` placeholder.
   */
  acceptanceCriteria?: ReadonlyArray<{ id: string }>;
  /** M5: validation plan ids accepted in the same way as AC ids. */
  validationPlan?: ReadonlyArray<{ id: string }>;
}

/**
 * Parse the raw LLM response into a typed reviewer result, salvaging
 * plain-text verdict/body when JSON is malformed and dropping
 * malformed inline comments. Translates textual severity markers in
 * `body` and `comments[*].body` into the structured `Finding[]` the
 * orchestrator grades on.
 */
export function parseReviewerOutput(
  text: string,
  extras: ReviewerOutputExtras,
): SpecReviewResult | ReviewResult {
  let value: Record<string, any>;
  try {
    value = jsonObject(text);
  } catch (jsonError) {
    const verdictMatch = text.match(/\b(?:verdict|VERDICT)\b\s*["']?\s*[:=]\s*["']?\s*(APPROVE|REJECT|approve|reject)/i);
    const bodyMatch = text.match(/\b(?:body|BODY)\b\s*["']?\s*[:=]\s*["']?([\s\S]*?)(?=["']\s*[,}\n]|$)/);
    if (verdictMatch) {
      value = {
        verdict: verdictMatch[1].toUpperCase(),
        body: bodyMatch ? bodyMatch[1].trim() : text.slice(0, 4000),
        comments: [],
        ...(extras.includeNotes ? { notes: "" } : {}),
      };
    } else {
      throw jsonError;
    }
  }
  if (!["APPROVE", "REJECT"].includes(value.verdict)) throw new Error("Invalid verdict");
  if (typeof value.body !== "string" || !value.body.trim()) throw new Error("Missing body");
  if (!Array.isArray(value.comments)) throw new Error("comments must be an array");

  const validComments: ReviewComment[] = [];
  for (const comment of value.comments ?? []) {
    if (typeof comment?.path !== "string") continue;
    if (!Number.isSafeInteger(comment.line) || comment.line < 1) continue;
    if (!["LEFT", "RIGHT"].includes(comment.side)) continue;
    if (typeof comment.body !== "string") continue;
    validComments.push(comment as ReviewComment);
  }
  const findings: Finding[] = extractFindingsFromText(
    value.body,
    extras.stage,
    extras.sourceRunId,
    extras.acceptanceCriteria ?? [],
    extras.validationPlan ?? [],
  );
  for (const comment of validComments) {
    const inlineFindings = extractFindingsFromText(
      comment.body,
      extras.stage,
      extras.sourceRunId,
      extras.acceptanceCriteria ?? [],
      extras.validationPlan ?? [],
    );
    for (const finding of inlineFindings) {
      finding.evidence = { ...finding.evidence, path: comment.path, line: comment.line };
    }
    findings.push(...inlineFindings);
  }
  const notes = extras.includeNotes ? (typeof value.notes === "string" ? value.notes : "") : undefined;
  const base = { verdict: value.verdict as "APPROVE" | "REJECT", body: value.body, comments: validComments, findings };
  if (base.verdict === "APPROVE" && containsBlockingFindingFromList(findings)) {
    return {
      ...base,
      verdict: "REJECT",
      body: `LLM marked APPROVE but body contains blocking findings — automatically reclassified as REJECT.\n\n${base.body}`,
      ...(notes !== undefined ? { notes } : {}),
    } as SpecReviewResult | ReviewResult;
  }
  return { ...base, ...(notes !== undefined ? { notes } : {}) } as SpecReviewResult | ReviewResult;
}
