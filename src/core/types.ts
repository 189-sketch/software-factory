/**
 * Core types for the pi-framework multi-agent software factory.
 *
 * Each agent is an independent unit that loads one skill file and produces a
 * structured result. The orchestrator wires the agents together via a state
 * machine keyed by GitHub issue labels.
 */

/** The four canonical triage-readiness states. */
export type TriageState =
  | "Ready to implement"
  | "Ready to spec"
  | "Needs info"
  | "Wait to implement";

/**
 * Issue label as applied on GitHub. Together these form the workflow
 * state machine: each agent reads the current label to decide which stage
 * to run, and writes the next label when it finishes.
 *
 *   (no label)        --[triage]--> ready-to-spec / ready-to-implement / needs-info / wait-to-implement
 *   ready-to-spec     --[spec]-----> spec-ready-for-review | ready-to-implement (if split)
 *   spec-ready-for-review --[human review]--> ready-to-implement (manual)
 *   ready-to-implement --[impl]--> review-needed
 *   review-needed     --[review]--> ready-to-merge | changes-requested
 *   changes-requested --[impl]--> review-needed
 *   ready-to-merge    --[verify]--> verified | verify-failed
 *   verify-failed     --[impl]--> review-needed
 *   verified          --[merge]--> (label cleared)
 *
 * Unknown labels fall through to triage so the factory self-heals after
 * manual operator changes.
 */
export type TriageLabel =
  | "ready-to-implement"
  | "ready-to-spec"
  | "spec-ready-for-review"
  | "needs-info"
  | "wait-to-implement"
  | "review-needed"
  | "ready-to-merge"
  | "verified"
  | "verify-failed"
  | "changes-requested";

/**
 * All labels the factory ever writes. Used to remove stale labels on
 * every transition so the issue's label set matches its current stage.
 */
export const ALL_FACTORY_LABELS: ReadonlyArray<TriageLabel> = [
  "ready-to-implement",
  "ready-to-spec",
  "spec-ready-for-review",
  "needs-info",
  "wait-to-implement",
  "review-needed",
  "ready-to-merge",
  "verified",
  "verify-failed",
  "changes-requested",
];

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

/** The factory state machine, keyed by issue number. */
export interface FactoryIssueState {
  issue: Issue;
  triage?: TriageResult;
  specs?: SpecPair;
  implementation?: ImplementationResult;
  review?: ReviewResult;
  merged: boolean;
  agentMode?: 'llm';
  labelPending?: boolean;
  reviewedSha?: string;
  verifiedSha?: string;
  reviewedBaseSha?: string;
  nextLabel?: TriageLabel;
  status?: 'running' | 'waiting' | 'failed' | 'completed' | 'simulated';
  attempts?: number;
  error?: string;
  stages?: Record<string, { startedAt: string; endedAt?: string; status: string }>;
}

/** Logger interface every agent implements. */
export interface AgentLogger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  child(bindings: Record<string, unknown>): AgentLogger;
}

export interface AgentContext {
  repo: { owner: string; name: string; defaultBranch: string; workdir: string };
  issue: Issue;
  logger: AgentLogger;
  /** Loaded SKILL.md body for this agent. */
  skillBody: string;
  /** Optional shared run id used in Oz run links. */
  runId: string;
}
