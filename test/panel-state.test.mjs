import test from "node:test";
import assert from "node:assert/strict";
import { buildStages, issueSummary } from "../control-panel/src/data/api.ts";

test("blocked behavior verification is rendered as failed", () => {
  const issue = {
    issue: { number: 1, title: "Dashboard" },
    implementation: {
      comment: "All implementation work is complete",
      behaviorVerification: { status: "blocked", notes: "Browser verification unavailable" },
    },
    review: { verdict: "APPROVE" },
    merged: false,
    status: "waiting",
    nextLabel: "verify-failed",
    stages: {
      implementation: { status: "completed" },
      review: { status: "completed" },
      verify: { status: "completed" },
    },
  };

  assert.equal(buildStages(issue).find((stage) => stage.id === "verify")?.status, "failed");
  assert.equal(issueSummary(issue), "Browser verification unavailable");
});
