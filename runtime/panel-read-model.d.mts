export interface OperationalJudgments {
  source: string;
  d1PipelineBottleneck: { stage: string | null; score: number; perStage: Record<string, any> };
  d2SystemicFailure: { triggered: boolean; failureClass: string | null; issueCount: number; issues: number[]; threshold: number };
  d3OperatorEscalation: { triggered: boolean; issues: number[]; reasons: Record<number, string> };
  d4Backpressure: { triggered: boolean; triggeredCount: number; signals: Record<string, { triggered: boolean; value: number; threshold: number }> };
  d5SkillSuggestion: { choice: string | null; failureClass: string | null; options: string[]; source: string };
}

export interface PanelReadModel {
  projects(): Promise<{ projects: Array<Record<string, unknown>>; metrics: Record<string, unknown> }>;
  /**
   * Persisted issue projections. Additive (T10.0): every entry also carries
   * `health`, `healthBand`, `stageConfidence`, and `fallbackBadges`
   * (see `IssueSignals`) alongside the raw checkpoint fields.
   */
  issues(projectId: string): Promise<Array<Record<string, any>>>;
  events(): Promise<Array<Record<string, any>>>;
  agents(): Promise<Array<Record<string, any>>>;
  settings(): Promise<Record<string, any>>;
  /** Additive (T9.3): deterministic D1–D5 aggregation across all projects. */
  operationalJudgments(): Promise<OperationalJudgments>;
  project(projectId: string): Record<string, unknown>;
}

export function createPanelReadModel(
  root: string,
  options?: { includeGitHub?: boolean; skillsRoot?: string },
): Promise<PanelReadModel>;

/**
 * Single seam for the operational judgments (D1–D5). A future
 * typesafe-backed scorer replaces this deterministic derivation without
 * touching consumers.
 */
export function scoreOperationalJudgments(
  readModel: { issues?: Array<Record<string, any>>; leaseWaits?: Array<Record<string, any>> },
  options?: { now?: number; thresholds?: Record<string, number> },
): OperationalJudgments;

export const OPERATIONAL_JUDGMENT_THRESHOLDS: Readonly<Record<string, number>>;
export const SKILL_SUGGESTION_RULES: ReadonlyArray<{ pattern: RegExp; skill: string }>;
export const SKILL_SUGGESTION_BY_STAGE: Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// T10.0 (additive) — composite health, per-stage confidence, fallback badges.
// ---------------------------------------------------------------------------

/** Decision 6 operator-visible band: `< 0.5` alert, `0.5–0.7` banner, `> 0.7` log_only. */
export type HealthBandName = "alert" | "banner" | "log_only";

/** The four composite dimensions from Decision 6. */
export type CompositeDimension = "spec" | "impl" | "review" | "verify";

/** Latest typesafe confidence for one stage, keyed on the producing run id. */
export interface StageConfidenceEntry {
  runId: string | null;
  /** `null` when the persisted state carries no confidence for the stage. */
  confidence: number | null;
}

/** Per-stage badge set when the stage's last run fell back to claude-code. */
export interface FallbackBadgeEntry {
  reason: string;
  at: string | null;
}

/** T10.0 signal set attached to every persisted issue projection. */
export interface IssueSignals {
  /** Decision 6 composite, or null until all four dimension scores persist. */
  health: number | null;
  healthBand: HealthBandName | null;
  stageConfidence: Record<string, StageConfidenceEntry>;
  fallbackBadges: Record<string, FallbackBadgeEntry>;
}

/** Decision 6 weights (mirrors `runtime/decisions.yaml` §composite). */
export const COMPOSITE_WEIGHTS: Readonly<Record<CompositeDimension, number>>;
/** CJK Fallback Contract downgrade: fallback dimensions contribute at 0.9× weight. */
export const FALLBACK_WEIGHT_FACTOR: number;
/** Dimension → UI stage whose fallback badge triggers the downgrade. */
export const DIMENSION_STAGE: Readonly<Record<CompositeDimension, string>>;

/** JS mirror of `computeHealth` from `src/orchestrator/composite.ts`. */
export function computeHealthJs(
  scores: Record<CompositeDimension, number>,
  weights?: Readonly<Record<CompositeDimension, number>>,
): number;

/** JS mirror of `healthBand` from `src/orchestrator/composite.ts`. */
export function healthBandJs(score: number): HealthBandName;

/** Per-UI-stage fallback badges derived from one persisted issue document. */
export function deriveFallbackBadges(document: Record<string, any>): Record<string, FallbackBadgeEntry>;

/** Per-UI-stage latest confidence derived from one persisted issue document. */
export function deriveStageConfidence(document: Record<string, any>): Record<string, StageConfidenceEntry>;

/** Full T10.0 signal set for one persisted issue document. */
export function deriveIssueSignals(document: Record<string, any>): IssueSignals;
