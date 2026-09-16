export type PipelineLabel =
  | "ready-to-implement"
  | "ready-to-spec"
  | "needs-info"
  | "wait-to-implement"
  | "review-needed"
  | "ready-to-merge"
  | "verified"
  | "verify-failed"
  | "changes-requested";

export type ReadinessState = "Ready to implement" | "Ready to spec" | "Needs info" | "Wait to implement";
export type ProjectStatus = "Backlog" | "Ready" | "In progress" | "In review" | "Done";
export type UiStageId = "triage" | "spec" | "implementation" | "review" | "verify" | "merge";

export const PROJECT_STATUSES: readonly ProjectStatus[];
export const COMPLETED_PROJECT_STATUS: "Done";
export const UI_STAGE_IDS: readonly UiStageId[];
export const PIPELINE_STAGES: readonly Readonly<{
  id: string;
  label: PipelineLabel | null;
  projectStatus: ProjectStatus | null;
  uiStage: UiStageId | null;
}>[];
export const PIPELINE_LABELS: readonly Readonly<{
  id: PipelineLabel;
  dispatchStage: string;
  projectStatus: ProjectStatus;
}>[];
export const RETIRED_PIPELINE_LABELS: readonly string[];
export const ACTIVE_PIPELINE_LABELS: readonly PipelineLabel[];
export const PIPELINE_LABELS_TO_CLEAR: readonly string[];
export const READINESS_STATES: readonly Readonly<{ state: ReadinessState; label: PipelineLabel }>[];
export const AGENT_ROLES: readonly Readonly<{ id: string; stage: string; label: string }>[];

export function normalizeStageId(stage: string): string | null;
export function labelForStage(stage: string): PipelineLabel | null;
export function stageForLabel(label: string): string | null;
export function projectStatusForLabel(label: string): ProjectStatus | null;
export function projectStatusForStage(stage: string): ProjectStatus | null;
export function uiStageForInternalStage(stage: string): UiStageId | null;
export function labelForReadinessState(state: string): PipelineLabel | null;
export function isPipelineLabel(label: string): label is PipelineLabel;
