/**
 * Stage input manifest: the typed handoff contract between stages.
 *
 * ## Why this module exists
 *
 * Before M3 the only thing that survived a stage transition was the
 * typed result (`SpecPair`, `ImplementationResult`, etc.). The next
 * stage either re-derived everything from the worktree (slow) or
 * trusted the previous stage's summary (fragile). Issue #20's
 * review-spec loop fell into the second bucket: the second reviewer
 * saw the same PRODUCT/TECH twice but never the diff between them
 * and the prior review's REJECT, so it could not tell "what changed
 * since I last looked at this".
 *
 * M3 fixes that by giving every stage a `StageInputManifest` that
 * captures:
 *
 *   - the requirement version (so a rule change invalidates old
 *     reviews rather than letting them ride along);
 *   - the artifact revisions the next stage will read (hash + path +
 *     source run id, so a later stage can verify the file on disk is
 *     the one the previous stage wrote);
 *   - the open findings the previous stage left (so a reviewer knows
 *     what to re-check);
 *   - the rules the next stage must apply (by hash, so a stale cache
 *     cannot silently downgrade);
 *   - the completion criteria for the stage (machine-readable, not
 *     free-text in the system prompt).
 *
 * Persisted as part of the checkpoint's `events` log (each manifest
 * is one event with `kind: "stage-input-manifest"`), so a recovery
 * walk can reconstruct exactly what every stage saw.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

/** A reference to a specific artifact revision the next stage will read. */
export interface InputArtifactRef {
  /** Kind of artifact (e.g. `spec-product`, `spec-tech`, `implementation`). */
  kind: string;
  /** Content hash. SHA-256 hex for file bodies; commit SHA for VCS artifacts. */
  hash: string;
  /** Filesystem path when the artifact is a file. */
  path?: string;
  /** Source run id (matches `events[].runId` of the stage that produced it). */
  sourceRunId: string;
  /** Source stage name. */
  sourceStage: string;
}

/** A finding the next stage must address (open or dismissed-superseded). */
export interface InputFindingRef {
  findingId: string;
  ruleId: string;
  severity: "blocking" | "important" | "suggestion" | "nit";
  /** Affected requirement id (matches `RequirementBaseline.id`). */
  requirementId?: string;
  /** One-line summary. Full body lives in the parent checkpoint's `findings[]`. */
  summary: string;
}

/** A rule version the next stage must apply. */
export interface InputRuleRef {
  ruleId: string;
  /** SHA-256 of the rule body. Read against the on-disk skill to verify it
   * hasn't drifted between the manifest write and the stage run. */
  contentHash: string;
  /** Human-readable label (e.g. `severity-spec`). */
  label: string;
}

/** A previous decision the next stage should respect. */
export interface InputDecisionRef {
  decisionId: string;
  /** `accepted | dismissed | superseded` — superseded means a newer
   * decision replaced it; the next stage should treat the newer one
   * as the active rule. */
  status: "accepted" | "dismissed" | "superseded";
  /** One-line summary. */
  summary: string;
}

/**
 * The full input manifest handed to one stage.
 *
 * `requirementVersion` is a monotonically increasing id bumped on
 * every accepted requirement change. A manifest with an older
 * requirementVersion than a stage expects is invalid — the stage
 * must refuse and re-derive its inputs from the latest baseline.
 */
export interface StageInputManifest {
  manifestId: string;
  /** Stage the manifest is addressed to (`spec`, `implementation`, …). */
  stage: string;
  /** Issue number. */
  issueNumber: number;
  /** Source run id (which stage wrote this manifest). */
  sourceRunId: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Monotonic requirement version the stage must satisfy. */
  requirementVersion: number;
  /** Artifact revisions the stage must read. */
  artifacts: InputArtifactRef[];
  /** Open findings the stage must address. */
  findings: InputFindingRef[];
  /** Decisions the stage must respect. */
  decisions: InputDecisionRef[];
  /** Rule versions the stage must apply (skill content hashes). */
  rules: InputRuleRef[];
  /** Machine-readable completion criteria. Free-text descriptions go
   * in the rule prompt; these are the checks that can be evaluated
   * without an LLM. */
  completionCriteria: string[];
  /** Free-form note from the previous stage (truncated). */
  note?: string;
}

/** Compute the SHA-256 hex digest of a UTF-8 string. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Compute the SHA-256 hex digest of a file on disk. */
export async function hashFile(absolutePath: string): Promise<string> {
  const buffer = await fs.readFile(absolutePath);
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Verify that the artifact on disk still matches the hash recorded in
 * the manifest. Returns `null` when the file is missing or unreadable
 * (the caller decides whether missing is fatal — usually it is, but
 * a recovery tool may want to fall through). Returns the on-disk
 * hash on success.
 *
 * The mismatch error message includes both hashes so the daemon log
 * can attribute the divergence to either a write-side bug or an
 * out-of-band edit without grepping two files.
 */
export async function verifyArtifact(ref: InputArtifactRef): Promise<
  { ok: true; onDiskHash: string } | { ok: false; reason: "missing" | "mismatch"; onDiskHash?: string }
> {
  if (!ref.path) return { ok: false, reason: "missing" };
  let onDisk: string;
  try {
    onDisk = await hashFile(ref.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, reason: "missing" };
    throw error;
  }
  if (onDisk !== ref.hash) return { ok: false, reason: "mismatch", onDiskHash: onDisk };
  return { ok: true, onDiskHash: onDisk };
}

/**
 * Pretty-print the manifest for the daemon log so an entry can answer
 * "what did the spec reviewer actually see?" without parsing JSON.
 * Kept short on purpose — full data is in the checkpoint event.
 */
export function summarizeManifest(manifest: StageInputManifest): string {
  return [
    `manifest=${manifest.manifestId}`,
    `stage=${manifest.stage}`,
    `req=${manifest.requirementVersion}`,
    `artifacts=${manifest.artifacts.length}`,
    `findings=${manifest.findings.length}`,
    `rules=${manifest.rules.length}`,
  ].join(" ");
}

/**
 * Minimal state shape needed to build a manifest. The orchestrator
 * passes the whole `FactoryIssueState`, but only the fields below are
 * read — keeping the surface area narrow makes the helper testable
 * without a full state object.
 */
export interface ManifestBuildInput {
  issue: { number: number };
  /** Used as the basis for `requirementVersion`. */
  specLoopVersion?: number;
  /** Last successful spec run. */
  specs?: { product?: { body?: string; slug?: string }; tech?: { body?: string; slug?: string }; specBranch?: string; specPrUrl?: string };
  /** Last successful spec review. */
  specReview?: { verdict?: string; body?: string };
  /** Cached key that says "specs at this revision are reviewed". */
  specReviewedKey?: string;
  /** Last successful implementation. */
  implementation?: { commitSha?: string; branch?: string };
  /** Last successful code review. */
  review?: { verdict?: string; body?: string };
  /** Supervisor's feedback to the current stage. */
  correction?: { targetStage?: string; turns?: string[] };
}

/** Stage names in pipeline order. Used by `buildStageInputManifest` to
 * decide which artifacts the next stage reads. */
const KNOWN_STAGES = [
  "triage",
  "spec",
  "review-spec",
  "implementation",
  "review-pr",
  "verify-behavior",
] as const;

/** Per-stage completion criteria. Free-text descriptions live in the
 * skill body; these are the machine-checkable checks a verifier (or a
 * future gate) can run without an LLM. */
const COMPLETION_CRITERIA: Record<string, string[]> = {
  triage: [
    "stage.status === 'completed'",
    "state.triage is populated with a verdict",
    "state.nextLabel is set",
  ],
  spec: [
    "state.specs.product.body and state.specs.tech.body are non-empty",
    "PRODUCT.md and TECH.md exist on disk and sha256-match the bodies",
  ],
  "review-spec": [
    "state.specReview.verdict is 'APPROVE' or 'REJECT'",
    "state.specReviewedKey is set and matches current specs",
  ],
  implementation: [
    "state.implementation.commitSha is a 40-char hex",
    "state.implementation.branch matches the issue-number convention",
  ],
  "review-pr": [
    "state.review.verdict is 'APPROVE' or 'REJECT'",
    "state.reviewedSha === state.implementation.commitSha",
  ],
  "verify-behavior": [
    "state.verifiedSha === state.implementation.commitSha",
    "verification outcome is recorded",
  ],
};

/**
 * Build the manifest the next stage receives. Each artifact ref points
 * at the canonical on-disk path under `<workdir>/specs/<slug>/` for
 * specs, `<workdir>` for implementation (where the worktree lives).
 *
 * Artifacts are filtered by the target stage: a stage only sees the
 * inputs it actually reads. `review-spec` therefore does not see
 * implementation (which is downstream of spec review), and `spec`
 * never sees the implementation commit even if a prior run left one.
 *
 * Stable manifest ids let a recovery walk correlate a manifest with
 * the run id stamped on the stage entry; we use `manifest-<runId>` so
 * the relationship is explicit.
 */
export function buildStageInputManifest(
  state: ManifestBuildInput,
  stage: string,
  sourceRunId: string,
  workdir: string = "",
): StageInputManifest {
  const issueNumber = state.issue.number;
  const artifacts: InputArtifactRef[] = [];
  const readsSpecs = stage === "review-spec" || stage === "implementation";
  const readsSpecReview = stage === "implementation";
  const readsImplementation = stage === "review-pr" || stage === "verify-behavior";
  const readsCodeReview = stage === "verify-behavior";
  if (readsSpecs && (state.specs?.product?.body || state.specs?.tech?.body)) {
    const slug = state.specs.product?.slug ?? state.specs.tech?.slug ?? "";
    artifacts.push({
      kind: "spec-product",
      hash: state.specs.product?.body ? hashText(state.specs.product.body) : "",
      path: slug && workdir ? `${workdir}/specs/${slug}/PRODUCT.md` : undefined,
      sourceRunId,
      sourceStage: "spec",
    });
    artifacts.push({
      kind: "spec-tech",
      hash: state.specs.tech?.body ? hashText(state.specs.tech.body) : "",
      path: slug && workdir ? `${workdir}/specs/${slug}/TECH.md` : undefined,
      sourceRunId,
      sourceStage: "spec",
    });
  }
  if (readsSpecReview && state.specReview?.body) {
    artifacts.push({
      kind: "spec-review",
      hash: hashText(state.specReview.body),
      path: undefined,
      sourceRunId,
      sourceStage: "review-spec",
    });
  }
  if (readsImplementation && state.implementation?.commitSha) {
    artifacts.push({
      kind: "implementation",
      hash: state.implementation.commitSha,
      path: workdir || undefined,
      sourceRunId,
      sourceStage: "implementation",
    });
  }
  if (readsCodeReview && state.review?.body) {
    artifacts.push({
      kind: "code-review",
      hash: hashText(state.review.body),
      path: undefined,
      sourceRunId,
      sourceStage: "review-pr",
    });
  }
  const decisions: InputDecisionRef[] = [];
  if (state.correction?.targetStage) {
    decisions.push({
      decisionId: `correction-${sourceRunId}`,
      status: "accepted",
      summary: `supervisor reroute/correction to ${state.correction.targetStage}`,
    });
  }
  return {
    manifestId: `manifest-${sourceRunId}`,
    stage,
    issueNumber,
    sourceRunId,
    createdAt: new Date().toISOString(),
    requirementVersion: state.specLoopVersion ?? 1,
    artifacts,
    findings: [],
    decisions,
    rules: [],
    completionCriteria: COMPLETION_CRITERIA[stage] ?? [],
    note: state.correction?.turns?.join(" | "),
  };
}

/** Re-export so callers don't need a second import. */
export { KNOWN_STAGES };