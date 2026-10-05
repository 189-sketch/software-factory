import {
  ACTIVE_PIPELINE_LABELS,
  PIPELINE_LABELS_TO_CLEAR,
  RETIRED_PIPELINE_LABELS,
} from "../../runtime/pipeline-definition.mjs";
import type { PipelineLabel, ReadinessState } from "../../runtime/pipeline-definition.mjs";
import type { ProjectValidationPlan } from './project-validation.js';

/**
 * Core types for the pi-framework multi-agent software factory.
 *
 * Each agent is an independent unit that loads one skill file and produces a
 * structured result. The orchestrator wires the agents together via a state
 * machine keyed by GitHub issue labels.
 */

/** The four canonical triage-readiness states. */
export type TriageState = ReadinessState;

/**
 * Issue label as applied on GitHub. Together these form the workflow
 * state machine: each agent reads the current label to decide which stage
 * to run, and writes the next label when it finishes.
 *
 * The pipeline is **agent-driven end-to-end**: humans only participate by
 * responding when triage decides `needs-info`. Every transition between
 * states is owned by an agent (spec, review-spec, review, implementation,
 * verify-behavior). Labels are written for visibility and durability, not
 * as gates that humans must act on.
 *
 *   (no label)        --[triage]--> ready-to-spec / ready-to-implement / needs-info / wait-to-implement
 *   ready-to-spec     --[spec + review-spec + auto-merge spec PR]--> ready-to-implement
 *   ready-to-implement --[impl]--> review-needed
 *   review-needed     --[review]--> ready-to-merge | changes-requested
 *   changes-requested --[impl]--> review-needed
 *   ready-to-merge    --[verify]--> verified | verify-failed
 *   verify-failed     --[verify or proven product repair]--> ready-to-merge | review-needed
 *   verified          --[auto-merge]--> (label cleared)
 *
 * Unknown labels fall through to triage so the factory self-heals after
 * manual operator changes.
 */
export type TriageLabel = PipelineLabel;

/**
 * All labels the factory ever writes. Used to remove stale labels on
 * every transition so the issue's label set matches its current stage.
 */
export const ALL_FACTORY_LABELS: ReadonlyArray<TriageLabel> = ACTIVE_PIPELINE_LABELS;

/**
 * Labels written by older factory versions.
 *
 * They are deliberately excluded from `TriageLabel` and
 * `ALL_FACTORY_LABELS` so they can never dispatch work, but transitions
 * must continue removing them from repositories upgraded in place.
 */
export const RETIRED_FACTORY_LABELS = RETIRED_PIPELINE_LABELS;

/** Every active or retired label that a transition must remove. */
export const FACTORY_LABELS_TO_CLEAR: ReadonlyArray<string> = PIPELINE_LABELS_TO_CLEAR;

/** Triage agent output. Mirrors the demo's JSON contract exactly. */
export interface TriageResult {
  state: TriageState;
  label: TriageLabel;
  remove_labels: TriageLabel[];
  comment: string;
}

/** A captured issue, normalized to what the agents need. */
export interface Issue {
  /** Derived from current GitHub labels, never an inferred workflow decision. */
  workflowConflict?: string[];
  number: number;
  state?: "open" | "closed";
  title: string;
  body: string;
  labels: TriageLabel[];
  author: string;
  url: string;
  createdAt: string;
  comments: IssueComment[];
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * Author-side dismissal of a rubric finding (issue #46, 2026-09-24).
 * The author can explicitly retain a flagged item despite a previous
 * spec-review rejection — the rationale is what lets the R3 rubric
 * treat the item as resolved instead of repeating the same defect.
 */
export interface AuthorOverride {
  /** Requirement id this override applies to (`VP-3`, `AC-2`, ...). */
  requirementId: string;
  /** Non-empty rationale for retaining the item as-is. */
  rationale: string;
}

/** PRODUCT.md frontmatter + body. */
export interface ProductSpec {
  slug: string;
  title: string;
  problem: string;
  goals: string[];
  nonGoals: string[];
  stories: UserStory[];
  acceptanceCriteria: string[];
  openQuestions: string[];
  body: string;
  /**
   * Per-issue author-overrides that explicitly retain a rubric-flagged
   * item. The R3 rubric treats each entry with a non-empty rationale
   * as a resolved finding — without this, the spec revision loop
   * repeats the same R3 rejection across rounds because the rubric
   * has no signal that the author has weighed in.
   */
  authorOverrides?: AuthorOverride[];
}

export interface UserStory {
  id: string;
  title: string;
  asA: string;
  iWant: string;
  soThat: string;
  checks: string[];
}

/** TECH.md frontmatter + body. */
export interface TechSpec {
  slug: string;
  approach: string;
  affectedAreas: string[];
  dataModel: string;
  apiChanges: string[];
  migrationPlan: string;
  validationPlan: string[];
  alternatives: string[];
  openQuestions: string[];
  body: string;
}

/**
 * Spec `2026-09-20-decision-architecture` / Phase C / T9.2.
 *
 * Structured answer from the spec agent's `typesafe` batch covering the
 * B1 / B2 / B3 judgment primitives (Decision Inventory §B). The batch is
 * ONE HTTP request — `b2` and `b3` each carry one primitive per AC so
 * N ACs means `1 + N + N` primitives in a single `primitives[]` array.
 *
 * - `b1.value` is `"product-only"` vs `"PRODUCT+TECH"` (the spec agent's
 *   first decision: does this issue need a TECH.md or just a PRODUCT.md?).
 * - `b2[].value` is a numeric score per AC (completeness rubric).
 * - `b3[].value` is a boolean per AC (verifiability, true = yes).
 *
 * `meanConfidence` is the arithmetic mean of every primitive's
 * `confidence` (range `[0.0, 1.0]`). It is the `SpecPair.confidence` the
 * orchestrator surfaces on the panel.
 */
export interface SpecTypesafeBatchAnswer {
  b1: { id: string; value: string; confidence: number };
  b2: Array<{ id: string; acId: string; value: number; confidence: number }>;
  b3: Array<{ id: string; acId: string; value: boolean; confidence: number }>;
  meanConfidence: number;
}

/**
 * Spec `2026-09-20-decision-architecture` / Phase C / T9.2.
 *
 * Structured answer from the review-spec agent's `typesafe` batch
 * covering the B4 / B5 judgment primitives (Decision Inventory §B).
 *
 * - `b4.value` is `"APPROVE"` or `"REJECT"` (the verdict).
 * - `b5[].value` is one of `"blocking" | "important" | "suggestion" | "nit"`
 *   per finding (the per-finding severity).
 *
 * Like `SpecTypesafeBatchAnswer`, all primitives travel in a single
 * HTTP request (`1 + M` primitives for M findings).
 */
export interface ReviewSpecTypesafeBatchAnswer {
  b4: { id: string; value: "APPROVE" | "REJECT"; confidence: number };
  b5: Array<{ id: string; findingId: string; value: FindingSeverity; confidence: number }>;
  meanConfidence: number;
}

/**
 * R-series spec-review rubric (2026-09-21, issue #39 convergence fix).
 *
 * One structured judgment point answered by the `typesafe` batch that
 * runs BEFORE the LLM review-spec pass. Each entry is the adapter-
 * normalised answer for one primitive:
 *
 *   - noul rules (R1/R3/R4/R5/R6/R7) → `value` is boolean (p ≥ 0.5)
 *     and `confidence` is the RAW yes-probability (the official Noul
 *     answer carries no separate confidence; the adapter routes the
 *     probability through the confidence channel).
 *   - score rule (R2, story coverage) → `value` is the 0..1 weighted
 *     position and `confidence` is the distribution confidence.
 *
 * Rule families (see `core/spec-review-rubric.ts` for semantics):
 *   R1-AC-n   per-AC machine-verifiability (noul)
 *   R2-US-n   per-story AC coverage incl. quantifier alignment (score)
 *   R3-VP-n   per-validation-item CI-runnability + false-positive robustness (noul)
 *   R4-OQ-n   per-open-question blocking-ness (noul, reversed polarity)
 *   R5-US-n   per-story scope fidelity vs the issue (noul)
 *   R6-NG-n   per-non-goal quiet-implementation leak (noul, reversed polarity)
 *   R7-PF-n   per-previous-finding resolution in the revised spec (noul)
 */
export interface SpecRubricAnswerEntry {
  /** Primitive id, e.g. `R1-AC-2` / `R2-US-1` / `R7-PF-3`. */
  id: string;
  /** Rule family: `R1` … `R7`. */
  rule: string;
  /** Target item id inside the family (`AC-2`, `US-1`, `VP-3`, `OQ-P-1`, `NG-2`, `PF-1`). */
  target: string;
  /** noul → boolean (p ≥ 0.5); score (R2) → weighted position 0..1. */
  value: boolean | number;
  /** noul → raw yes-probability; score → distribution confidence. */
  confidence: number;
}

/** Aggregate answer of one R-series rubric batch (single HTTP request). */
export interface SpecRubricBatchAnswer {
  entries: SpecRubricAnswerEntry[];
  meanConfidence: number;
}

/** A spec pair produced by the spec agent. */
export interface SpecPair {
  product: ProductSpec;
  tech: TechSpec;
  specBranch: string;
  specPrUrl: string;
  /** Commit SHA pushed to the spec branch (recorded after `commit_and_push`). */
  commitSha?: string;
  /**
   * Spec `2026-09-20-decision-architecture` / Phase C / T9.2.
   * Aggregate confidence (mean of the per-primitive confidences) from the
   * `typesafe` batch covering B1 (PRODUCT vs PRODUCT+TECH), B2 (per-AC
   * completeness Score) and B3 (per-AC verifiability Noul). Populated by
   * the spec agent's typesafe path; absent when the batch fell back to
   * `claude-code`. Range `[0.0, 1.0]` per the CJK fallback contract.
   */
  confidence?: number;
  /**
   * Spec `2026-09-20-decision-architecture` / Phase C / T9.2.
   * Structured B1/B2/B3 answers from the `typesafe` batch. Populated
   * together with `confidence`; absent when the batch fell back to
   * `claude-code` so the orchestrator can tell "the model answered
   * these questions" from "we never asked".
   */
  typesafeBatch?: SpecTypesafeBatchAnswer;
  /**
   * Optional list of sub-issues to create when the spec is too big to
   * ship in one PR. When present, the parent advances to
   * ready-to-implement after each sub-issue is created on GitHub.
   */
  splitInto?: Array<{ title: string; body: string }>;
  /**
   * Ordered history of every spec revision the spec agent has produced
   * for this issue. Each entry is an immutable record of one
   * `SpecAgent.run()` invocation: a stable revision id, the commit
   * SHA it produced, the runId that produced it, and the verdict /
   * finding summary from the matching review-spec. Recovery tools and
   * the spec-revision loop use this array to answer "what did the
   * spec agent do last time, and what did the reviewer say about it?".
   *
   * Added in M5. Pre-M5 checkpoints may have this undefined; orchestrator
   * treats undefined as an empty array.
   */
  revisions?: SpecRevision[];
}

/**
 * One spec revision: a single `SpecAgent.run()` invocation + the
 * review-spec verdict that landed on the resulting commit.
 */
export interface SpecRevision {
  /** Stable UUID generated when the spec agent first ran. Persists
   * across re-runs; the review-spec verdict for this revision binds
   * to this id so triage can answer "which revision was rejected?". */
  id: string;
  /** Commit SHA the spec agent pushed (after `commit_and_push`). */
  commitSha?: string;
  /** `SpecAgent.run()` runId. */
  runId: string;
  /** ISO timestamp at which the spec agent returned. */
  generatedAt: string;
  /** Verdict the review-spec agent returned against this revision.
   * `undefined` if review-spec has not yet run on this revision. */
  reviewVerdict?: "APPROVE" | "REJECT";
  /** Review-spec findings against this revision. Empty array when
   * review-spec has not run, when the verdict was APPROVE, or when
   * the reviewer declined to emit findings. */
  reviewFindings?: Finding[];
  /** Whether the spec agent used `--amend` on the previous commit
   * (true) or created a fresh commit on the spec branch (false). */
  amended: boolean;
  /** First 8 chars of `commitSha` — convenience for log lines. */
  commitShort?: string;
}

/** Implementation agent output. */
export interface ImplementationResult {
  issueNumber: number;
  branch: string;
  commitSha: string;
  prUrl: string;
  prNumber: number;
  filesChanged: string[];
  validation: ValidationResult[];
  projectValidation?: ProjectValidationPlan;
  specAlignment?: SpecAlignmentResult;
  behaviorVerification?: BehaviorVerificationResult;
  comment: string;
}

export interface ValidationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: string | null;
  timeoutMs?: number;
  durationMs?: number;
}

export interface SpecAlignmentResult {
  matched: string[];
  mismatched: string[];
  notes: string;
}

export type BehaviorMode = "reproduce" | "verify";

export interface VerificationFailure {
  kind: 'product' | 'evidence' | 'tool';
  runId: string;
  requirementIds: string[];
  receiptIds: string[];
  reason: string;
}

export interface BehaviorVerificationResult {
  mode: BehaviorMode;
  status: "verified" | "not-verified" | "blocked" | "confirmed" | "not-reproduced";
  channel: "browser" | "desktop" | "hybrid";
  ozRunUrl: string;
  /** Factory-owned local receipt registry location, never selected by the model. */
  receiptPath?: string;
  /** Factory-issued recovery ownership, not a model-selected route. */
  failure?: VerificationFailure;
  evidence: EvidenceArtifact[];
  notes: string;
  /**
   * The checks the executing agent designed and the receipts it
   * cited (2026-09-22 execute-then-judge fix). Populated by
   * `parseVerifyBehavior`; retained on the typed result so the
   * orchestrator / panel can audit the per-criterion breakdown
   * even when the typesafe judgment layer was unavailable.
   */
  checks?: Array<{ criterion: string; requirementIds?: string[]; passed: boolean; receiptIds: string[] }>;
  coverage?: {
    specCommitSha: string;
    implementationSha: string;
    requirementsHash: string;
    runId: string;
    passingReceiptIds: string[];
  };
}

export interface EvidenceArtifact {
  kind: "video" | "screenshot";
  caption: string;
  path: string;
}

/** Review agent output. Mirrors the demo's review.json contract. */
export interface ReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  /** Optional anchor for multi-line review comments (GitHub's `start_line`). */
  start_line?: number;
  /** Optional side for the start anchor (must match `side`). */
  start_side?: "LEFT" | "RIGHT";
}

export interface ReviewResult {
  verdict: "APPROVE" | "REJECT";
  body: string;
  comments: ReviewComment[];
  /** Structured findings translated from severity markers. */
  findings?: Finding[];
  /**
   * B7 verdict confidence from the review-pr `typesafe` judgment
   * batch (2026-09-22 generate-then-judge fix). Absent when the
   * batch was unavailable — the claude-code review then stands
   * unjudged. This is the headline judgment confidence, NOT a
   * mixed-primitive mean.
   */
  confidence?: number;
  /** Structured B7/B8 batch answer, kept for the audit trail. */
  typesafeBatch?: ReviewSpecTypesafeBatchAnswer;
  /** Persisted merge route for this exact reviewed result. Missing is never auto-merge. */
  mergeRoute?: { mode: 'auto' | 'confirm' | 'escalate'; target?: string; prompt?: string };
}

/**
 * Spec-review agent output. Same shape contract as `ReviewResult` so the
 * orchestrator can reuse the same JSON parsing + comments validator; the
 * semantic content (severity prefixes, body guidance) is provided by the
 * `skills/review-spec.md` rubric and enforced by ReviewSpecAgent.
 */
export interface SpecReviewResult {
  verdict: "APPROVE" | "REJECT";
  body: string;
  comments: ReviewComment[];
  /** Free-form agent notes that don't fit the per-line comment model. */
  notes: string;
  /**
   * Structured findings translated from the textual severity markers
   * in `body` and `comments[*].body`. Populated by
   * `parseSpecReviewResult` so the orchestrator can grade severity
   * without re-running a regex over prose.
   */
  findings?: Finding[];
  /**
   * The spec revision id this verdict targets. Populated by
   * `runSpecPhase` from the latest entry in `state.specs.revisions`
   * before the review-spec agent runs. Recovery tools use this to
   * bind "REJECT against this spec commit" to "this spec commit was
   * revision X". When undefined (legacy checkpoints), the binding
   * defaults to "latest revision" — same behavior as before the
   * revision id was introduced.
   */
  revisionId?: string;
  /**
   * Spec `2026-09-20-decision-architecture` / Phase C / T9.2.
   * Aggregate confidence (mean of the per-primitive confidences) from the
   * `typesafe` batch covering B4 (review-spec verdict Choice) and B5
   * (per-finding severity Choice). Populated by the review-spec agent's
   * typesafe path; absent when the batch fell back to `claude-code`.
   */
  confidence?: number;
  /**
   * Spec `2026-09-20-decision-architecture` / Phase C / T9.2.
   * Structured B4/B5 answers from the `typesafe` batch. Populated
   * together with `confidence`; absent when the batch fell back to
   * `claude-code`.
   */
  typesafeBatch?: ReviewSpecTypesafeBatchAnswer;
  /**
   * R-series rubric batch answers (2026-09-21, issue #39 convergence
   * fix). Populated when the rubric gate ran for this review round —
   * both on the rubric-only REJECT path (no LLM review ran) and on the
   * pass path (attached for observability before the LLM exploration
   * review runs). Absent when `FACTORY_RUBRIC_OFF=1`, the batch fell
   * back, or typesafe was unavailable.
   */
  rubricBatch?: SpecRubricBatchAnswer;
}

/** Improve-review-pr agent output. */
export interface ImproveReviewResult {
  window: string;
  prsInspected: number;
  feedbackItems: { validated: number; corrected: number; refined: number; ambiguous: number };
  decision: "no_changes" | "update_review_pr" | "update_review_pr_local" | "both";
  learnings: string[];
  skillPrUrl: string | null;
  notes: string;
}

/**
 * Typed snapshot of the most recent implementation attempt that the
 * ImplementationAgent receives on a retry. Carries everything the
 * orchestrator already knows about the prior attempt so the LLM can
 * iterate from real evidence instead of markdown summary.
 *
 * Built by `buildPriorAttempt` in `orchestrator/index.ts` and injected
 * into `AgentContext.priorAttempt` before the agent is constructed.
 */
export interface PriorAttempt {
  /** Branch name carrying the prior implementation commit. */
  branch: string;
  /** Commit SHA at HEAD of the prior attempt. */
  commitSha: string;
  /** PR URL opened for the prior attempt, if any. */
  prUrl?: string;
  /** Files actually changed on disk (resolved from git, not the agent claim). */
  filesChanged: string[];
  /** Validation commands the prior attempt ran, with exit codes. */
  validation: ValidationResult[];
  /** Unified diff against the base branch (truncated to PRIOR_DIFF_MAX_BYTES). */
  diff: string;
  /** Most recent review verdict + per-line comments, if a review ran. */
  review?: ReviewResult;
  /** Most recent behavior-verification outcome, if verify ran. */
  behaviorVerification?: BehaviorVerificationResult;
  /** 1-based attempt number being retried (1 = first retry, etc.). */
  attemptNumber: number;
  /** Configured maximum before the orchestrator escalates / fails. */
  maxAttempts: number;
}

/**
 * Cross-stage event appended on every stage transition. Unlike the
 * single-value `state.review` / `state.implementation` slots, this log
 * preserves the full history so a later stage can ask "what did the
 * prior N implementations look like?" without re-deriving from text.
 */
export interface AgentEvent {
  /** Stage that produced this event (`triage`, `spec`, `review-spec`, etc.). */
  stage: string;
  /** Wall-clock ISO timestamp at stage start. */
  startedAt: string;
  /** Wall-clock ISO timestamp at stage end; absent if the stage is still running. */
  endedAt?: string;
  /** Final outcome keyword (`completed`, `failed`, `rejected`, etc.). */
  status: string;
  /** Implementation attempt counter at the time of the event. */
  attempts?: number;
  /** Spec-revision attempt counter at the time of the event. */
  specAttempts?: number;
  /** Truncated git diff summary (`M files changed, +A -B`). Optional — costly stages may omit. */
  diffSummary?: string;
  /** Verdict from review-style stages (`APPROVE` / `REJECT`). */
  verdict?: string;
  /** Free-form reason (e.g. error message on failure). */
  reason?: string;
  /**
   * M2: the run id of the execution that produced this event. Present
   * on every event written by the orchestrator's `stage()` wrapper so
   * retries, revisions and recoveries can be cross-referenced without
   * overwriting prior records.
   */
  runId?: string;
}

/**
 * Schema version of the persisted checkpoint shape.
 *
 * `1` is the legacy shape, written by every factory version prior to
 * the M2 upgrade. `2` is the M2 shape that distinguishes execution
 * identities (`runId`), tracks artifact revisions, and records
 * external operations separately from local stage state. Bumping the
 * number is the migration signal — readers that encounter a version
 * they don't recognize must NOT silently coerce, they must surface the
 * mismatch and either run the migration preview or refuse to write.
 */
export type CheckpointSchemaVersion = 1 | 2;
export const CURRENT_CHECKPOINT_SCHEMA_VERSION: CheckpointSchemaVersion = 2;

/**
 * Task-level lifecycle vocabulary (plan §3.3). `state.status` carries
 * one of these values; the orchestrator's `transition()` is the only
 * writer. Stage wrappers must NOT touch `state.status` — they own
 * `state.stages[name].status` (see `StageRunStatus` below).
 *
 * `running` is intentionally absent: "the task is actively being driven
 * by the orchestrator" is implicit when any `state.stages[name].status
 * === 'running'`. The task status flips to `waiting` when the
 * supervisor holds it, to `completed` only when the merge (or
 * terminal failure) lands, and to `failed` when triage runs out of
 * retries.
 */
export type TaskLifecycle =
  | "queued"
  | "waiting"
  | "completed"
  | "failed"
  | "simulated";

/**
 * Stage-run execution vocabulary (plan §3.3). Each entry in
 * `state.stages[name]` carries one of these; the orchestrator's
 * `stage()` wrapper is the only writer. Independent from
 * `TaskLifecycle` so a REJECT verdict can coexist with a successful
 * execution (the task is waiting on triage; the stage finished
 * cleanly).
 */
export type StageRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

/** The factory state machine, keyed by issue number. */
export interface FactoryIssueState {
  /**
   * Schema version of THIS checkpoint's persisted shape. Default `1`
   * when absent (legacy records written before M2). Required `2` for
   * checkpoints that record `runId` / `artifacts` / `externalOps`.
   */
  schemaVersion?: CheckpointSchemaVersion;
  /**
   * Monotonic revision counter. Incremented on every successful
   * checkpoint write so a recovery can tell which copy is newer.
   * The first write starts at 1.
   */
  revision?: number;
  issue: Issue;
  triage?: TriageResult;
  specs?: SpecPair;
  specReview?: SpecReviewResult;
  implementation?: ImplementationResult;
  review?: ReviewResult;
  merged: boolean;
  agentMode?: 'llm';
  labelPending?: boolean;
  reviewedSha?: string;
  verifiedSha?: string;
  reviewedBaseSha?: string;
  /** Cache key for the most recent spec review (`${branch}@${commitSha}`). */
  specReviewedKey?: string;
  nextLabel?: TriageLabel;
  status?: TaskLifecycle;
  /**
   * Optional structured wait reason. Set when the issue enters
   * `waiting` so the panel can render "why" without grepping logs.
   * Lease ownership is read separately from GitHub refs, not local wait files.
   */
  wait?: IssueWait;
  attempts?: number;
  /** Number of distinct spec revisions rejected by review-spec. */
  specAttempts?: number;
  /**
   * Total agent failures the triage supervisor has judged for this issue.
   *
   * This is a mechanical loop breaker, not a quality judgment: triage
   * decides *what* to do about each failure, and this counter only bounds
   * *how many times* it may decide before an operator is required.
   * Configured by `FACTORY_MAX_AGENT_FAILURES` (default 50).
   */
  agentFailures?: number;
  /**
   * Correction authored by triage for the next stage run. Persisted so a
   * daemon restart mid-retry does not silently drop the explanation and
   * re-run the agent with no idea why it is being re-run.
   */
  correction?: AgentCorrection;
  /**
   * @deprecated Superseded by `agentFailures`. Retained so checkpoints
   * written by older versions still load; never written by current code.
   */
  parseFailureHeals?: number;
  /** Version of the durable spec-review loop, used for in-place recovery. */
  specLoopVersion?: number;
  error?: string;
  stages?: Record<string, { startedAt: string; endedAt?: string; status: string; runId?: string }>;
  /** Cross-stage event log. Append-only; survives label / checkpoint transitions. */
  events?: AgentEvent[];
  /**
   * M2 artifact revisions: ordered history of every persisted
   * artifact (spec files, review verdicts, implementation commits,
   * verification receipts). Each entry binds the artifact to its
   * content hash, source stage, and parent revision so a later
   * reviewer can reconstruct the chain that produced it.
   */
  artifacts?: ArtifactRevision[];
  /**
   * M2 external operations: pending / in-flight / settled record of
   * every GitHub-facing side effect (comments, label syncs, branch
   * pushes, PR creations, merges). State transitions and operation
   * intent are committed together; the executor drains them
   * afterwards. See plan §3.8.
   */
  externalOps?: ExternalOperation[];
  /**
   * Ordered list of stages the issue is queued to run through.
   * Populated by `setNextLabelForStage`. Recovery tools walk this
   * array to answer "what is the pipeline waiting on?" without
   * re-running the label-to-stage map.
   */
  pendingSteps?: PendingStep[];
  /**
   * Open questions raised by the spec / reviewer / triage stages.
   * `blocking: true` entries force a `needs-info` transition until
   * they are closed. The spec agent's `SpecPair.openQuestions`
   * seeds this array; review-spec / triage may append.
   */
  openQuestions?: OpenQuestion[];
  /**
   * Per-(stage, FailureClass) attempt counter. Replaces the legacy
   * single `agentFailures` integer. The orchestrator's failure
   * handler reads this to decide whether the next failure should
   * retry, escalate, or abort without consulting the supervisor
   * LLM.
   */
  failureCounts?: Record<string, Record<FailureClass, number>>;
  /** Bounded verification recovery; receipt UUIDs and model prose do not reset it. */
  verificationRecovery?: { context: string; attempts: number; coveredRequirementIds: string[] };
  /**
   * Last classified failure for the current stage. Read by the
   * orchestrator to short-circuit obvious cases (PERMANENT →
   * immediate abort; POLICY_BLOCK → immediate needs-info) before
   * paying the supervisor LLM token cost.
   */
  lastFailure?: { stage: string; class: FailureClass; message: string; at: string };
  /**
   * Spec `2026-09-20-decision-architecture` / Phase C / T9.2.
   * Counter for typesafe-driven spec revision cycles. The spec phase
   * loop in `Orchestrator.runSpecPhase` increments this each time
   * `deriveSpecVerdict` returns `needs-revision`; the loop bails to
   * `SpecTypesafeRevisionsExhaustedError` after `MAX_TYPESAFE_REVISIONS`
   * (default 2). Reset by `resetFailedState` so the budget is fresh
   * across the `orchestrator-resetting-failed-state` boundary.
   */
  specTypesafeRevisions?: number;
  /**
   * R-series rubric convergence ratchet (2026-09-21, issue #39).
   * Per-judgment-point consecutive-failure counts keyed by rubric
   * point id (`R1-AC-3`, `R2-US-1`, …). Incremented for every point
   * the rubric flags in a review round; points that pass are dropped
   * from the map, so a count of N means "failed N consecutive rounds".
   * When any count reaches the ratchet limit (default 2) the
   * orchestrator throws `SpecRubricRepeatedFailureError` and routes
   * deterministically to needs-info instead of burning another
   * spec→review cycle on a non-converging revision.
   */
  specRubricFailures?: Record<string, number>;
  /**
   * Spec `2026-09-20-decision-architecture` / Phase C / T9.2.
   * Last typesafe verdict for the spec stage. Surfaced on the panel
   * `lastSpecVerdict` row so the operator can see what typesafe said
   * without re-running the batch.
   */
  lastSpecVerdict?: { verdict: 'pass' | 'needs-revision'; reasons: string[] };
  /**
   * M6 multi-turn session map. Each role that runs an LLM agent holds
   * at most one live CLI session; the binding is read at stage start
   * (to feed `StageRunRequest.resumeSessionId`) and updated at stage
   * end (from `StageRunResult.providerSessionId`). See
   * `core/provider-session.ts` for the read/write API.
   *
   * Missing / undefined means "open a fresh session on next run".
   */
  providerSessions?: ProviderSessionMap;
  /**
   * Spec `2026-09-20-decision-architecture` / Phase B / T8.4.
   * SHA-256 of the freshness hash computed by
   * `core/judgment-state.ts::stateHashFor(buildJudgmentState(issue, ctx))`
   * after the most recent judgment. The polling loop writes this on
   * every successful freshness check (both skip and no-skip paths),
   * so a subsequent poll whose current stateHash equals this value
   * is a guaranteed `state_unchanged` skip — no `typesafe` call is
   * made. The hash is opaque to anything outside `freshness-poc.mjs`.
   */
  lastJudgmentHash?: string;
  /**
   * Spec `2026-09-20-decision-architecture` / Phase B / T8.4.
   * ISO-8601 timestamp of the most recent triage. Read by
   * `freshness-poc.mjs` to seed the factory side of
   * `JudgmentState.factory.lastTriageAt`; updated by the triage
   * stage after it completes. The polling loop never writes this.
   */
  lastTriageAt?: string;
}

/**
 * Structured wait reason attached to `FactoryIssueState.wait`. The
 * plan's failure taxonomy (§3.6) lists the categories; this type
 * narrows it to the values we record in the checkpoint.
 */
export interface IssueWait {
  /** Wait category from the plan §3.6 table. */
  reason:
    | "lease-busy"
    | "lease-network-failed"
    | "lease-refused"
    | "external-unknown"
    | "external-retry-wait"
    | "blocked-operator"
    | "quality-rejection"
    | "spec-merge-conflict";
  /** Free-form explanation; truncated to a few hundred chars by callers. */
  note?: string;
  /** ISO timestamp at which the wait started. */
  since: string;
  /** ISO timestamp at which the daemon will next attempt (when applicable). */
  nextAttemptAt?: string;
}

/**
 * Ordered list of stages the issue is queued to run through.
 *
 * Populated by the orchestrator every time `setNextLabelForStage`
 * changes `state.nextLabel` (or its predecessor equivalent). Each
 * entry tells the operator (and the recovery walk) "this issue is
 * waiting for stage X to run because of reason Y since Z". The
 * `setNextLabelForStage` writes one entry per transition; the
 * orchestrator's outer loop clears the array on terminal status
 * transitions.
 *
 * Recovery tools use this to answer "where is this issue in the
 * pipeline" without re-running the label-to-stage map.
 */
export interface PendingStep {
  stage: string;
  reason: string;
  since: string;
}

/**
 * Open question raised by a stage that the pipeline expects the
 * author (or another stage) to close. Unlike a `Finding` (which
 * targets a specific acceptance criterion) an `OpenQuestion` is a
 * free-form blocker that the spec or reviewer surfaced.
 *
 * `blocking: true` causes the deterministic router to route the
 * issue to `needs-info` even when the rest of the spec passes
 * review; the issue is not unblocked until every blocking question
 * is closed (status set to `closed`, `closedBy` populated). The
 * previous wording referenced the now-removed `triage-supervisor`
 * LLM stage; routing is now a pure function in
 * `src/core/routing-decision.ts`.
 */
export interface OpenQuestion {
  id: string;
  raisedBy: "spec" | "review-spec" | "review-pr" | "triage" | "implementation";
  text: string;
  blocking: boolean;
  raisedAt: string;
  /** When the question was closed, the revision that closed it. */
  closedBy?: string;
  closedAt?: string;
  /** Human-readable note explaining how the question was closed. */
  closureNote?: string;
}

/**
 * Failure taxonomy (plan §3.6). Each non-transient failure is
 * classified into one of these buckets before the orchestrator
 * decides retry policy. Replacing the legacy `state.agentFailures`
 * counter, this enables per-(issue, stage, class) budgets so the
 * factory can answer "the same root cause just happened for the
 * third time" without relying on the LLM supervisor to notice.
 */
export type FailureClass =
  | "TRANSIENT"
  | "POLICY_BLOCK"
  | "USER_INPUT_REQUIRED"
  | "CONTRACT_VIOLATION"
  | "AGENT_FORMAT_ERROR"
  | "AGENT_REASONING"
  | "ENVIRONMENT"
  | "EXECUTOR_CRASH"
  | "PERMANENT";

/**
 * A persisted artifact revision.
 *
 * Each stage that produces a file or a structured result writes one
 * entry here. The `hash` lets later stages verify the artifact they
 * read is the same one the previous stage wrote (and that the file
 * on disk was not silently overwritten between writes). The
 * `parentRevision` lets a recovery tool walk the chain.
 */
export interface ArtifactRevision {
  /** Stable id (UUID). */
  id: string;
  /** Logical kind: `spec-product`, `spec-tech`, `review-spec`,
   * `implementation`, `review-pr`, `verify-behavior`, `pr`, `merge`. */
  kind: string;
  /** Hash of the artifact contents. SHA-256 hex for files; defined
   * per-kind for structured results (e.g. commit SHA for `implementation`). */
  hash: string;
  /** Filesystem path for file artifacts; undefined for PR / merge records. */
  path?: string;
  /** Stage run that produced this revision. */
  sourceRunId: string;
  /** Stage name (matches `events[].stage`). */
  sourceStage: string;
  /** Parent revision id; `undefined` for the first revision of a kind. */
  parentRevision?: string;
  /** ISO timestamp at which the artifact was registered. */
  registeredAt: string;
}

/**
 * Status of a pending external operation.
 *
 * Transitions: pending → in-flight → (succeeded | failed | unknown).
 * `unknown` is sticky until a follow-up reconciliation query resolves
 * it; controllers do NOT auto-flip unknown back to pending.
 */
export type ExternalOperationStatus =
  | "pending"
  | "in-flight"
  | "succeeded"
  | "failed"
  | "retry-wait"
  | "unknown"
  | "blocked";

/** Categories of external operations the factory tracks. */
export type ExternalOperationKind =
  | "issue-comment"
  | "label-sync"
  | "project-sync"
  | "spec-push"
  | "implementation-push"
  | "pr-create"
  | "pr-merge"
  | "issue-close"
  | "lease-acquire"
  | "lease-release";

/**
 * M4 requirement baseline: every requirement the pipeline must
 * satisfy, tagged by source so a reviewer can tell "user asked for
 * this" from "the factory inferred this" from "an automated comment
 * suggested it".
 *
 * `acceptedChanges` records changes the user explicitly accepted
 * (typically via reply comments). A reviewer must NOT silently
 * promote an assumption or an automated comment into a requirement.
 */
export type RequirementSource = "user" | "engineering-assumption" | "automated-comment" | "accepted-change" | "spec-product" | "spec-tech";

export interface RequirementEntry {
  /** Stable id (UUID). */
  id: string;
  /** Source category. Reviewers must treat `user` and `accepted-change`
   * as binding; `engineering-assumption` and `automated-comment` are
   * advisory until the user promotes them. */
  source: RequirementSource;
  /** The requirement as plain text. */
  text: string;
  /** Optional reference (comment URL, issue body excerpt, …). */
  ref?: string;
  /** ISO timestamp at which the requirement was registered. */
  registeredAt: string;
  /** Status — `superseded` is sticky; the entry stays in the baseline
   * for the audit trail but no longer binds. */
  status: "active" | "superseded" | "dismissed";
  /** When superseded or dismissed, the id of the change that closed it. */
  closedBy?: string;
}

export interface RequirementBaseline {
  /** Issue number. */
  issueNumber: number;
  /** Monotonic version; bumped on every accepted change. Manifests
   * pin the version they were built against so a stale review cannot
   * ride along. */
  version: number;
  /** Source stage that produced the baseline (typically `triage`). */
  sourceStage: string;
  /** Requirements, ordered by registration time. */
  entries: RequirementEntry[];
}

/**
 * M4 finding: a structured observation emitted by a reviewer.
 *
 * Reviewers MUST populate `evidence` and `requirementIds` so triage
 * can judge whether the finding is grounded or noise. Findings are
 * stored on the issue checkpoint so subsequent reviewers can close
 * them with a revision, dismiss them, or supersede them.
 */
export type FindingSeverity = "blocking" | "important" | "suggestion" | "nit";
export type FindingStatus = "open" | "resolved" | "dismissed" | "superseded";

export interface FindingEvidence {
  /** File path the finding refers to. */
  path?: string;
  /** 1-based line number when applicable. */
  line?: number;
  /** Free-form excerpt or reproduction note. */
  excerpt?: string;
}

export interface Finding {
  /** Stable id (UUID). */
  id: string;
  /** Rule id that produced the finding (e.g. `missing-acceptance-criteria`). */
  ruleId: string;
  severity: FindingSeverity;
  /** The requirement ids the finding blocks / addresses. Empty for
   * `nit` and some `suggestion` findings. */
  requirementIds: string[];
  /** One-line summary. */
  summary: string;
  /** Detailed evidence. */
  evidence: FindingEvidence;
  /** Stage that emitted this finding. */
  sourceStage: string;
  /** Run id of the stage run that emitted this finding. */
  sourceRunId: string;
  /** ISO timestamp. */
  registeredAt: string;
  /** Current status. */
  status: FindingStatus;
  /** Resolution note (set when status transitions). */
  resolutionNote?: string;
  /** Revision id that resolved / dismissed / superseded this finding. */
  resolvedByRevisionId?: string;
}

/**
 * A review verdict in structured form. Replaces the free-text
 * `body` field on the legacy `SpecReviewResult` / `ReviewResult`
 * shapes when a finding set is present; the free-text body is kept
 * for backward compatibility but reviewers are expected to ALSO
 * emit `findings`.
 */
export interface ReviewerFindingsBundle {
  /** Reviewer stage. */
  stage: string;
  /** Run id. */
  runId: string;
  /** Findings emitted by this run. */
  findings: Finding[];
  /** Requirement version the reviewer was pinned to. */
  requirementVersion: number;
}

/**
 * A side effect intended against GitHub or the local lease backend.
 *
 * Persisted alongside the state transition that caused it so a
 * daemon restart can resume exactly where it left off. See plan §3.8.
 */
export interface ExternalOperation {
  id: string;
  kind: ExternalOperationKind;
  /** Stable identity the executor uses to dedupe retries. For PR
   * creates this is the local intent (e.g. `${issue}@${branch}`); for
   * merges it is the PR's remote identity once known. */
  externalId: string;
  /**
   * Deduplication key the executor uses to skip a re-execution when
   * it sees a `succeeded` row with the same key. Defaults to
   * `${issue}@${kind}@${branch}` for branch-bound operations, or
   * `${issue}@${kind}@global` otherwise. The reconciler uses this
   * to coalesce concurrent restarts of the same daemon.
   */
  idempotencyKey?: string;
  /** Free-form payload describing the operation. Validated against
   * `kind` at execution time. */
  payload: Record<string, unknown>;
  /** Expected remote state after success (commit SHA, PR number, …). */
  expectedRemote?: Record<string, unknown>;
  status: ExternalOperationStatus;
  /** ISO timestamp at which the operation was first registered. */
  createdAt: string;
  /** ISO timestamp at which the executor last updated the record. */
  updatedAt: string;
  /** Error category if `status` is `failed` or `unknown`. */
  errorCategory?: "transient-infrastructure" | "contract" | "ambiguous-result" | "auth";
  /** Last error message (truncated). */
  error?: string;
  /** Number of attempts made so far. */
  attempts?: number;
  /** ISO timestamp at which the next attempt is allowed (when `status` is `retry-wait`). */
  nextAttemptAt?: string;
  /** Receipt produced on a successful settle. For comments / labels
   * this is the API response id; for merges it is the merge commit
   * SHA. */
  receipt?: Record<string, unknown>;
}

/**
 * Provider CLI session binding (M6).
 *
 * Persisted on `FactoryIssueState.providerSessions[role]` so a daemon
 * restart, worker crash, or attempt-2 retry can `--resume <id>` the same
 * Claude Code session instead of paying cold-start cost and losing the
 * model's in-session memory (tool-use history, prior reads, etc.).
 *
 * Each role owns its own session because each role runs in its own
 * git worktree — the filesystem is the persistent context, and the
 * CLI session only adds the model's own conversational memory on top.
 *
 * The `backend` field guards against accidental cross-provider reuse:
 * a session minted by `claude-code` cannot be resumed by `codex-cli`,
 * and `getProviderSession` (in `core/provider-session.ts`) refuses to
 * return a binding whose `backend` does not match the requested one.
 */
export interface SessionBinding {
  /** UUID minted by the CLI's `--session-id` / `--resume` protocol. */
  providerSessionId: string;
  /** Which backend minted the session; refuses cross-provider reuse. */
  backend: 'claude-code' | 'codex-cli' | 'pi-cli' | 'typesafe';
  /** Model the session was started under; resume requires the same model. */
  model: string;
  /** Checkout identity; legacy bindings without it cannot be resumed in production. */
  workdir?: string;
  /** Immutable input revision for review/verification sessions. */
  inputRevision?: string;
  /** ISO timestamp of the last successful run that used this session. */
  lastUsedAt: string;
  /** 1-based attempt number when this session was last touched. */
  attempt: number;
}

/** Map from pipeline role (`implementation`, `review-pr`, ...) to its live session. */
export type ProviderSessionMap = Record<string, SessionBinding>;

/** Logger interface every agent implements. */
export interface AgentLogger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  child(bindings: Record<string, unknown>): AgentLogger;
}

/**
 * A skill the agent may load on demand.
 *
 * Only the name and one-line description travel in the system prompt.
 * The body — often several KB of rubric — is fetched by the agent
 * through the `load_skill` tool when (and if) it actually needs it.
 *
 * This is progressive disclosure: inlining every rubric into every system
 * prompt spent thousands of tokens per turn on guidance the agent might
 * never consult, and made the prompt grow with the rubric instead of
 * staying constant.
 */
export interface SkillRef {
  name: string;
  description: string;
}

/**
 * A corrective conversation injected into an agent before it retries.
 *
 * Authored by the triage supervisor after it judges a pipeline failure.
 * Each entry becomes its own user turn (see `contextTurns` in
 * `core/llm-agent.ts`), so the agent can call tools against turn N before
 * turn N+1 arrives — that is what makes the cause-and-effect explanation
 * land as a conversation rather than one undifferentiated wall of text.
 */
export interface AgentCorrection {
  /** Stage this correction is addressed to (`spec`, `implementation`, …). */
  targetStage: string;
  /** Ordered user turns: what was asked, what came back, what was wrong, what to do now. */
  turns: string[];
}

/**
 * Everything the triage supervisor needs to judge a pipeline failure.
 *
 * Before this envelope existed, the one failure path that re-routed
 * through triage (implementation parse errors) handed triage *nothing* —
 * it re-classified the issue blind, with no idea what had just gone
 * wrong. Judgment without evidence is guesswork, so every field here
 * exists to give triage a fact it would otherwise have to invent.
 */
export interface PipelineFailure {
  /** Pipeline stage that failed (`spec`, `implementation`, `review`, …). */
  stage: string;
  /** LLM agent name within the stage (`spec-product`, `spec-tech`, …). */
  agentName: string;
  /** 1-based attempt number for this stage. */
  attempt: number;
  /** The error as thrown. */
  error: string;
  /** Raw model output that failed, when the failure was an output problem. */
  rawOutput?: string;
  /**
   * Ground truth gathered by tool execution — not model self-report.
   *
   * Carries facts that code used to assert on (which validation commands
   * actually ran and their exit codes, which verification receipts truly
   * exist and passed). Code no longer decides what those facts *mean*,
   * but it must not hide them: triage is itself a model, so handing it
   * only the model's own claims would let a fabrication validate itself.
   */
  evidence?: unknown;
  /** Cross-stage history so triage can see a repeating pattern. */
  priorEvents: AgentEvent[];
}

/**
 * `TriageRouting` was removed in 2026-09 (issue #36 fix). The LLM
 * triage-supervisor hat was replaced by a deterministic pure
 * function: `RoutingDecision` from `src/core/routing-decision.ts`,
 * which classifies pipeline failures via `classifyError` (9 classes)
 * and chooses retry / reroute / needs-info / abort without
 * consulting an LLM.
 */

export interface AgentContext {
  /** Operator-owned execution ceiling, not chosen by the model. */
  commandTimeoutMs?: number;
  /** Private artifact storage hint; verification refuses product-tree placement. */
  artifactStateDir?: string;
  repo: { owner: string; name: string; defaultBranch: string; workdir: string };
  issue: Issue;
  logger: AgentLogger;
  /**
   * Skills this agent may load on demand, by name + description only.
   * The first entry is the agent's own primary skill.
   */
  skills: SkillRef[];
  /**
   * Filesystem root the `load_skill` tool resolves skill bodies against.
   * Supports both the source layout (`<root>/<name>/SKILL.md`) and the
   * bundled layout (`<root>/<name>.json`) — see `core/skill.ts`.
   */
  skillsRoot: string;
  /** Optional shared run id used in Oz run links. */
  runId: string;
  /**
   * Typed artifact describing the previous implementation attempt.
   * Populated by the orchestrator when retrying implementation after
   * review / verify failure. Other agents should leave this undefined.
   */
  priorAttempt?: PriorAttempt;
  /**
   * Corrective conversation authored by the triage supervisor after a
   * failure. Populated by the orchestrator on a retry; absent on a
   * first attempt.
   */
  correction?: AgentCorrection;
  /**
   * M6 transient sink: the agent sets this on the way out of
   * `dispatchAgentStage` with the latest `StageRunResult.providerSessionId`,
   * and the orchestrator reads it after `agent.run()` returns to
   * persist on `FactoryIssueState.providerSessions[role]`. Lives
   * here (not on the return value of `agent.run()`) so the seven
   * existing agent return shapes (TriageResult, SpecPair, …) stay
   * untouched.
   */
  lastProviderSessionId?: string | null;
  /**
   * M6 transient input: the orchestrator sets this BEFORE calling
   * `agent.run()` with the resume id from `state.providerSessions[role]`
   * (or leaves it unset for a cold start). `dispatchAgentStage` reads
   * it and threads it into `StageRunRequest.resumeSessionId` so the
   * adapter can pass `--resume <id>` to the CLI. Cleared on read so
   * a single agent that internally calls `dispatchAgentStage` more
   * than once (spec agent: product + tech) doesn't accidentally resume
   * the second call from a session the first call just minted.
   */
  resumeSessionId?: string;
  /**
   * ISO-8601 timestamp of the most recent triage decision on this
   * issue. The orchestrator sets this from `state.lastTriageAt`
   * before calling `TriageAgent.run()`. TriageAgent uses it to send
   * ONLY the author comments newer than that timestamp on a resumed
   * session (M6 incremental principle) — the prior replies are
   * already in the CLI's session memory and re-sending them burns
   * tokens and re-asserts context the model can read back on its
   * own. Undefined ⇒ cold start ⇒ full evidence block.
   */
  lastTriageAt?: string;
}
