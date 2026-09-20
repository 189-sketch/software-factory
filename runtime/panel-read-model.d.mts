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
