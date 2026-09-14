import {
  ACTIVE_PIPELINE_LABELS,
  PIPELINE_LABELS_TO_CLEAR,
  RETIRED_PIPELINE_LABELS,
} from "../../runtime/pipeline-definition.mjs";
import type { PipelineLabel, ReadinessState } from "../../runtime/pipeline-definition.mjs";

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
 *   verify-failed     --[impl]--> review-needed
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
  number: number;
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

/** A spec pair produced by the spec agent. */
export interface SpecPair {
  product: ProductSpec;
  tech: TechSpec;
  specBranch: string;
  specPrUrl: string;
  /** Commit SHA pushed to the spec branch (recorded after `commit_and_push`). */
  commitSha?: string;
  /**
   * Optional list of sub-issues to create when the spec is too big to
   * ship in one PR. When present, the parent advances to
   * ready-to-implement after each sub-issue is created on GitHub.
   */
  splitInto?: Array<{ title: string; body: string }>;
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
  specAlignment?: SpecAlignmentResult;
  behaviorVerification?: BehaviorVerificationResult;
  comment: string;
}

export interface ValidationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpecAlignmentResult {
  matched: string[];
  mismatched: string[];
  notes: string;
}

export type BehaviorMode = "reproduce" | "verify";

export interface BehaviorVerificationResult {
  mode: BehaviorMode;
  status: "verified" | "not-verified" | "blocked" | "confirmed" | "not-reproduced";
  channel: "browser" | "desktop" | "hybrid";
  ozRunUrl: string;
  evidence: EvidenceArtifact[];
  notes: string;
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
  status?: 'running' | 'waiting' | 'failed' | 'completed' | 'simulated';
  /**
   * Optional structured wait reason. Set when the issue enters
   * `waiting` so the panel can render "why" without grepping logs.
   * Complements the lease-wait record under
   * `<stateDir>/lease-waits/issue-<n>.json`.
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

/** How the triage supervisor decides a pipeline failure should be handled. */
export interface TriageRouting {
  /**
   * - `retry`     — run `targetStage` again with the correction applied.
   * - `reroute`   — send the issue to a different stage entirely.
   * - `needs-info`— stop and ask a human; the issue is underspecified.
   * - `abort`     — unrecoverable; escalate to an operator.
   */
  action: "retry" | "reroute" | "needs-info" | "abort";
  /** Stage to run next. Ignored for `needs-info` / `abort`. */
  targetStage: string;
  /** Ordered corrective turns delivered to `targetStage`. */
  correction: string[];
  /** Explanation posted to the issue thread. */
  comment: string;
}

export interface AgentContext {
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
}
