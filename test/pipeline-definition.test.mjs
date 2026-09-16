import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_PIPELINE_LABELS,
  PIPELINE_LABELS_TO_CLEAR,
  UI_STAGE_IDS,
  labelForReadinessState,
  labelForStage,
  projectStatusForLabel,
  projectStatusForStage,
  stageForLabel,
  uiStageForInternalStage,
} from "../runtime/pipeline-definition.mjs";

test("PipelineDefinition is the canonical label and stage projection", () => {
  assert.deepEqual(ACTIVE_PIPELINE_LABELS, [
    "ready-to-implement",
    "ready-to-spec",
    "needs-info",
    "wait-to-implement",
    "review-needed",
    "ready-to-merge",
    "verified",
    "verify-failed",
    "changes-requested",
  ]);
  assert.equal(new Set(PIPELINE_LABELS_TO_CLEAR).size, PIPELINE_LABELS_TO_CLEAR.length);
  assert.deepEqual(UI_STAGE_IDS, ["triage", "spec", "implementation", "review", "verify", "merge"]);
});

test("PipelineDefinition maps lifecycle labels in both directions", () => {
  assert.equal(stageForLabel("ready-to-spec"), "spec");
  assert.equal(stageForLabel("changes-requested"), "implementation");
  assert.equal(stageForLabel("ready-to-merge"), "verify");
  assert.equal(labelForStage("review-pr"), "review-needed");
  assert.equal(labelForStage("review-spec"), "ready-to-spec");
  assert.equal(labelForStage("triage"), null);
  assert.equal(labelForStage("made-up-stage"), null);
});

test("PipelineDefinition owns Project and UI projections", () => {
  assert.equal(projectStatusForLabel("needs-info"), "Backlog");
  assert.equal(projectStatusForLabel("ready-to-implement"), "Ready");
  assert.equal(projectStatusForLabel("changes-requested"), "In progress");
  assert.equal(projectStatusForStage("review-spec"), "In review");
  assert.equal(uiStageForInternalStage("merge-spec-pr"), "spec");
});

test("PipelineDefinition derives readiness labels", () => {
  assert.equal(labelForReadinessState("Ready to implement"), "ready-to-implement");
  assert.equal(labelForReadinessState("Needs info"), "needs-info");
  assert.equal(labelForReadinessState("unknown"), null);
});

