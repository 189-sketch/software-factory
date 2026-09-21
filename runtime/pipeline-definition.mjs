export const PROJECT_STATUSES = Object.freeze(["Backlog", "Ready", "In progress", "In review", "Done"]);
export const COMPLETED_PROJECT_STATUS = PROJECT_STATUSES[4];

export const UI_STAGE_IDS = Object.freeze(["triage", "spec", "implementation", "review", "verify", "merge"]);

export const PIPELINE_STAGES = Object.freeze([
  { id: "triage", label: null, projectStatus: "Backlog", uiStage: "triage" },
  { id: "spec", label: "ready-to-spec", projectStatus: "In progress", uiStage: "spec" },
  { id: "review-spec", label: "ready-to-spec", projectStatus: "In review", uiStage: "spec" },
  { id: "merge-spec-pr", label: "ready-to-spec", projectStatus: "In progress", uiStage: "spec" },
  { id: "implementation", label: "ready-to-implement", projectStatus: "In progress", uiStage: "implementation" },
  { id: "review", label: "review-needed", projectStatus: "In review", uiStage: "review" },
  { id: "verify", label: "ready-to-merge", projectStatus: "In review", uiStage: "verify" },
  { id: "merge", label: "verified", projectStatus: "In progress", uiStage: "merge" },
  { id: "improve-review-pr", label: null, projectStatus: null, uiStage: null },
]);

export const PIPELINE_LABELS = Object.freeze([
  { id: "ready-to-implement", dispatchStage: "implementation", projectStatus: "Ready" },
  { id: "ready-to-spec", dispatchStage: "spec", projectStatus: "Ready" },
  { id: "needs-info", dispatchStage: "triage", projectStatus: "Backlog" },
  { id: "wait-to-implement", dispatchStage: "triage", projectStatus: "Backlog" },
  { id: "review-needed", dispatchStage: "review", projectStatus: "In review" },
  { id: "ready-to-merge", dispatchStage: "verify", projectStatus: "In review" },
  { id: "verified", dispatchStage: "merge", projectStatus: "In review" },
  { id: "verify-failed", dispatchStage: "implementation", projectStatus: "In progress" },
  { id: "changes-requested", dispatchStage: "implementation", projectStatus: "In progress" },
]);

export const RETIRED_PIPELINE_LABELS = Object.freeze(["spec-ready-for-review"]);
export const ACTIVE_PIPELINE_LABELS = Object.freeze(PIPELINE_LABELS.map((entry) => entry.id));
export const PIPELINE_LABELS_TO_CLEAR = Object.freeze([...ACTIVE_PIPELINE_LABELS, ...RETIRED_PIPELINE_LABELS]);

export const READINESS_STATES = Object.freeze([
  { state: "Ready to implement", label: "ready-to-implement" },
  { state: "Ready to spec", label: "ready-to-spec" },
  { state: "Needs info", label: "needs-info" },
  { state: "Wait to implement", label: "wait-to-implement" },
]);

export const AGENT_ROLES = Object.freeze([
  { id: "triage", stage: "triage", label: "Triage" },
  { id: "spec", stage: "spec", label: "Spec" },
  { id: "implementation", stage: "implementation", label: "Implementation" },
  { id: "review-pr", stage: "review", label: "Review PR" },
  { id: "review-spec", stage: "spec", label: "Review Spec" },
  { id: "verify-behavior", stage: "verify", label: "Verify Behavior" },
  { id: "improve-review-pr", stage: "improve", label: "Improve Review PR" },
]);

const stageAliases = Object.freeze({
  "spec-review": "review-spec",
  "review-pr": "review",
  "verify-behavior": "verify",
});

const stageById = new Map(PIPELINE_STAGES.map((entry) => [entry.id, entry]));
const labelById = new Map(PIPELINE_LABELS.map((entry) => [entry.id, entry]));
const readinessByState = new Map(READINESS_STATES.map((entry) => [entry.state, entry]));

export function normalizeStageId(stage) {
  const normalized = stageAliases[String(stage)] || String(stage);
  return stageById.has(normalized) ? normalized : null;
}

export function labelForStage(stage) {
  const id = normalizeStageId(stage);
  return id ? stageById.get(id).label : null;
}

export function stageForLabel(label) {
  return labelById.get(String(label))?.dispatchStage ?? null;
}

export function projectStatusForLabel(label) {
  return labelById.get(String(label))?.projectStatus ?? null;
}

export function projectStatusForStage(stage) {
  const id = normalizeStageId(stage);
  return id ? stageById.get(id).projectStatus : null;
}

export function uiStageForInternalStage(stage) {
  const id = normalizeStageId(stage);
  return id ? stageById.get(id).uiStage : null;
}

export function labelForReadinessState(state) {
  return readinessByState.get(String(state))?.label ?? null;
}

export function isPipelineLabel(label) {
  return labelById.has(String(label));
}
