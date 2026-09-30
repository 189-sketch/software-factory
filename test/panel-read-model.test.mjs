import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPanelReadModel,
  scoreOperationalJudgments,
  OPERATIONAL_JUDGMENT_THRESHOLDS,
  COMPOSITE_WEIGHTS,
  FALLBACK_WEIGHT_FACTOR,
  computeHealthJs,
  healthBandJs,
  deriveFallbackBadges,
  deriveStageConfidence,
  deriveIssueSignals,
} from "../runtime/panel-read-model.mjs";
async function recordLeaseWait(stateDir, issueNumber, record) {
  const directory = path.join(stateDir, "lease-waits");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `issue-${issueNumber}.json`), JSON.stringify({ issueNumber, ...record }));
}

async function project(root, name, issueNumber, stage) {
  await fs.mkdir(path.join(root, ".factory-daemon"), { recursive: true });
  await fs.mkdir(path.join(root, "state", "issues"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name }));
  await fs.writeFile(path.join(root, ".factory-daemon", ".env"), [
    `FACTORY_STATE_DIR=state`,
    `FACTORY_LOCAL_DIR=fixtures`,
    `FACTORY_GH_REPO=acme/${name}`,
  ].join("\n"));
  await fs.writeFile(path.join(root, "state", "issues", `${issueNumber}.json`), JSON.stringify({
    issue: { number: issueNumber, title: `${name} issue`, labels: [] },
    stages: {
      [stage]: { startedAt: "2026-09-11T00:00:00.000Z", endedAt: "2026-09-11T00:01:00.000Z", status: "completed" },
    },
    events: [{ stage, startedAt: "2026-09-11T00:00:00.000Z", endedAt: "2026-09-11T00:01:00.000Z", status: "completed" }],
  }));
}

test("PanelReadModel loads explicit projects and each project's configured state directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-panel-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const second = path.join(root, "second");
  await project(root, "primary", 1, "review-spec");
  await project(second, "secondary", 2, "implementation");
  await fs.mkdir(path.join(root, ".factory"), { recursive: true });
  await fs.writeFile(path.join(root, ".factory", "projects.json"), JSON.stringify({
    projects: [{ id: "secondary", root: "second", name: "Secondary" }],
  }));

  const model = await createPanelReadModel(root, { includeGitHub: false });
  const projects = await model.projects();
  assert.deepEqual(projects.projects.map((entry) => entry.id), ["current", "secondary"]);
  assert.equal((await model.issues("current"))[0].issue.number, 1);
  assert.equal((await model.issues("secondary"))[0].issue.number, 2);
});

test("PanelReadModel does not leak the current project's path overrides into registered projects", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-panel-env-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const second = path.join(root, "second");
  await project(root, "primary", 1, "triage");
  await project(second, "secondary", 2, "implementation");
  await fs.mkdir(path.join(root, ".factory"), { recursive: true });
  await fs.writeFile(path.join(root, ".factory", "projects.json"), JSON.stringify({
    projects: [{ id: "secondary", root: "second" }],
  }));

  const previousStateDir = process.env.FACTORY_STATE_DIR;
  process.env.FACTORY_STATE_DIR = path.join(root, "state");
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.FACTORY_STATE_DIR;
    else process.env.FACTORY_STATE_DIR = previousStateDir;
  });

  const model = await createPanelReadModel(root, { includeGitHub: false });
  assert.equal((await model.issues("secondary"))[0].issue.number, 2);
});

test("PanelReadModel projects internal stage events onto canonical UI stages", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-panel-events-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await project(root, "primary", 7, "review-spec");

  const model = await createPanelReadModel(root, { includeGitHub: false });
  const [issue] = await model.issues("current");
  assert.equal(issue.stages.spec.status, "completed");
  const events = await model.events();
  assert.equal(events[0].stage, "spec");
  assert.equal(events[0].bindings.internalStage, "review-spec");
  assert.equal(events[0].projectId, "current");
});

// --- T9.3 operational judgments (D1–D5) -------------------------------------

function judgmentIssue(number, overrides = {}) {
  return {
    issue: { number, title: `issue ${number}`, labels: [], ...(overrides.issue || {}) },
    stages: overrides.stages || {},
    events: overrides.events || [],
    ...(overrides.extra || {}),
  };
}

function failedEvent(stage, reason, at) {
  return { stage, status: "failed", reason, endedAt: at };
}

test("scoreOperationalJudgments derives D1 bottleneck from stage latency and failures", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  const hour = 3600_000;
  const issues = [
    judgmentIssue(1, {
      stages: {
        triage: { startedAt: new Date(now - 10 * hour).toISOString(), endedAt: new Date(now - 9.9 * hour).toISOString(), status: "completed" },
        review: { startedAt: new Date(now - 9 * hour).toISOString(), endedAt: new Date(now - 3 * hour).toISOString(), status: "completed" },
      },
      events: [{ stage: "review", status: "completed", endedAt: new Date(now - 3 * hour).toISOString() }],
    }),
    judgmentIssue(2, {
      stages: {
        review: { startedAt: new Date(now - 8 * hour).toISOString(), endedAt: new Date(now - 2 * hour).toISOString(), status: "failed" },
      },
      events: [failedEvent("review", "review parser crashed", new Date(now - 2 * hour).toISOString())],
    }),
  ];
  const judgments = scoreOperationalJudgments({ issues }, { now });
  assert.equal(judgments.d1PipelineBottleneck.stage, "review");
  assert.ok(judgments.d1PipelineBottleneck.score > 0);
  assert.ok(judgments.d1PipelineBottleneck.score <= 1);
  assert.equal(judgments.d1PipelineBottleneck.perStage.review.failures, 1);
  // Additive contract: the five D-sections are all present.
  for (const key of ["d1PipelineBottleneck", "d2SystemicFailure", "d3OperatorEscalation", "d4Backpressure", "d5SkillSuggestion"]) {
    assert.ok(key in judgments, `missing ${key}`);
  }
});

test("scoreOperationalJudgments D2 fires on ≥3 issues sharing a failure class within the window", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  const hour = 3600_000;
  const makeIssue = (number) => judgmentIssue(number, {
    events: [failedEvent("implementation", "CONTRACT_VIOLATION", new Date(now - hour).toISOString())],
  });
  const below = scoreOperationalJudgments({ issues: [makeIssue(1), makeIssue(2)] }, { now });
  assert.equal(below.d2SystemicFailure.triggered, false);
  const atThreshold = scoreOperationalJudgments(
    { issues: [makeIssue(1), makeIssue(2), makeIssue(3)] },
    { now },
  );
  assert.equal(atThreshold.d2SystemicFailure.triggered, true);
  assert.equal(atThreshold.d2SystemicFailure.failureClass, "contract-violation");
  assert.deepEqual(atThreshold.d2SystemicFailure.issues, [1, 2, 3]);
  assert.equal(atThreshold.d2SystemicFailure.threshold, OPERATIONAL_JUDGMENT_THRESHOLDS.systemicFailureMinIssues);
  // Outside the window the same failures do not fire.
  const stale = scoreOperationalJudgments({
    issues: [1, 2, 3].map((number) => judgmentIssue(number, {
      events: [failedEvent("implementation", "CONTRACT_VIOLATION", new Date(now - 30 * 24 * hour).toISOString())],
    })),
  }, { now });
  assert.equal(stale.d2SystemicFailure.triggered, false);
});

test("scoreOperationalJudgments D3 fires on stalled needs-info and escalation events", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  const hour = 3600_000;
  const judgments = scoreOperationalJudgments({
    issues: [
      judgmentIssue(1, {
        issue: { number: 1, labels: ["needs-info"] },
        events: [{ stage: "triage", status: "completed", endedAt: new Date(now - 72 * hour).toISOString() }],
      }),
      judgmentIssue(2, {
        events: [failedEvent("review", "operator escalation required", new Date(now - hour).toISOString())],
      }),
      judgmentIssue(3, {
        issue: { number: 3, labels: ["needs-info"] },
        events: [{ stage: "triage", status: "completed", endedAt: new Date(now - hour).toISOString() }],
      }),
    ],
  }, { now });
  assert.equal(judgments.d3OperatorEscalation.triggered, true);
  assert.deepEqual(judgments.d3OperatorEscalation.issues, [1, 2]);
  assert.equal(judgments.d3OperatorEscalation.reasons[1], "needs-info-stall");
  assert.equal(judgments.d3OperatorEscalation.reasons[2], "escalation-event");
});

test("scoreOperationalJudgments D4 exposes three independent Noul signals", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  const hour = 3600_000;
  const queued = (number) => judgmentIssue(number, { issue: { number, labels: ["ready-to-implement"] } });
  const leaseWaits = [1, 2, 3].map((n) => ({ issueNumber: n, reason: "lease-busy", blockedAt: new Date(now - hour).toISOString() }));
  const failing = (number, index) => judgmentIssue(number, {
    events: [failedEvent("verify", "playwright timeout", new Date(now - (10 - index) * hour).toISOString())],
  });
  const judgments = scoreOperationalJudgments({
    issues: [
      ...[11, 12, 13, 14, 15].map(queued),
      ...[21, 22, 23].map((number, index) => failing(number, index)),
      // A success in between would reset the streak; none here.
    ],
    leaseWaits,
  }, { now });
  const { signals } = judgments.d4Backpressure;
  assert.deepEqual(Object.keys(signals).sort(), ["failureStreak", "leaseSaturation", "queueDepth"]);
  assert.equal(signals.queueDepth.triggered, true);
  assert.equal(signals.queueDepth.value, 5);
  assert.equal(signals.leaseSaturation.triggered, true);
  assert.equal(signals.leaseSaturation.value, 3);
  assert.equal(signals.failureStreak.triggered, true);
  assert.ok(signals.failureStreak.value >= 3);
  assert.equal(judgments.d4Backpressure.triggeredCount, 3);
  assert.equal(judgments.d4Backpressure.triggered, true);

  const calm = scoreOperationalJudgments({ issues: [], leaseWaits: [] }, { now });
  assert.equal(calm.d4Backpressure.triggered, false);
  assert.equal(calm.d4Backpressure.triggeredCount, 0);
});

test("scoreOperationalJudgments D5 maps the dominant failure class to a skill Choice", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  const hour = 3600_000;
  const judgments = scoreOperationalJudgments({
    issues: [1, 2, 3, 4].map((number) => judgmentIssue(number, {
      events: [failedEvent("spec", "CONTRACT_VIOLATION", new Date(now - hour).toISOString())],
    })),
  }, { now });
  assert.equal(judgments.d5SkillSuggestion.failureClass, "contract-violation");
  assert.equal(judgments.d5SkillSuggestion.choice, "skills/spec/SKILL.md");
  assert.ok(judgments.d5SkillSuggestion.options.includes("skills/spec/SKILL.md"));

  const none = scoreOperationalJudgments({ issues: [] }, { now });
  assert.equal(none.d5SkillSuggestion.choice, null);
});

test("PanelReadModel.operationalJudgments aggregates persisted issues and lease waits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-panel-judgments-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await project(root, "primary", 1, "implementation");
  // Add three more issues failing with the same class so D2 reaches its ≥3 threshold.
  const stateDir = path.join(root, "state");
  for (const number of [2, 3, 4]) {
    await fs.writeFile(path.join(stateDir, "issues", `${number}.json`), JSON.stringify({
      issue: { number, title: `failing ${number}`, labels: [] },
      stages: {},
      events: [{ stage: "implementation", status: "failed", reason: "CONTRACT_VIOLATION", endedAt: new Date().toISOString() }],
    }));
  }
  for (const number of [1, 2, 3]) {
    await recordLeaseWait(stateDir, number, { reason: "lease-busy", blockedAt: new Date().toISOString() });
  }

  const model = await createPanelReadModel(root, { includeGitHub: false });
  const judgments = await model.operationalJudgments();
  assert.equal(judgments.source, "deterministic-v1");
  assert.equal(judgments.d2SystemicFailure.triggered, true);
  assert.equal(judgments.d4Backpressure.signals.leaseSaturation.triggered, true);
  // Existing consumers keep working unchanged (additive contract).
  const projects = await model.projects();
  assert.equal(projects.projects[0].id, "current");
  assert.equal((await model.issues("current")).length, 4);
});

// --- T10.0 composite health, per-stage confidence, fallback badges ----------

const SCORES = Object.freeze({ spec: 0.8, impl: 0.6, review: 0.7, verify: 0.9 });

test("T10.0 computeHealthJs mirrors the Decision 6 formula and normalises by weight sum", () => {
  // 0.30·0.8 + 0.25·0.6 + 0.20·0.7 + 0.25·0.9 = 0.24 + 0.15 + 0.14 + 0.225 = 0.755
  const health = computeHealthJs(SCORES);
  assert.ok(Math.abs(health - 0.755) < 1e-9, `expected 0.755, got ${health}`);
  // Weights sum to 1.0 per Decision 6.
  const weightSum = Object.values(COMPOSITE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-9);
  // Out-of-range scores are clamped, not rejected.
  assert.equal(computeHealthJs({ spec: 5, impl: -3, review: 1, verify: 0 }), computeHealthJs({ spec: 1, impl: 0, review: 1, verify: 0 }));
  // A missing dimension throws rather than silently defaulting.
  assert.throws(() => computeHealthJs({ spec: 0.5, impl: 0.5, review: 0.5 }), /verify/);
});

test("T10.0 healthBandJs applies the <0.5 / 0.5–0.7 / >0.7 rubric", () => {
  assert.equal(healthBandJs(0.0), "alert");
  assert.equal(healthBandJs(0.49), "alert");
  assert.equal(healthBandJs(0.5), "banner");
  assert.equal(healthBandJs(0.7), "banner");
  assert.equal(healthBandJs(0.71), "log_only");
  assert.equal(healthBandJs(1.0), "log_only");
});

test("T10.0 deriveIssueSignals returns null health until all four scores persist", () => {
  const empty = deriveIssueSignals({ issue: { number: 1 } });
  assert.equal(empty.health, null);
  assert.equal(empty.healthBand, null);
  assert.deepEqual(empty.fallbackBadges, {});
  // Every UI stage exposes a confidence entry, all null when unpersisted.
  for (const stage of ["triage", "spec", "implementation", "review", "verify", "merge"]) {
    assert.equal(empty.stageConfidence[stage].confidence, null, `${stage} confidence`);
  }
  // A partial score set (three of four) still yields null — no partial health.
  const partial = deriveIssueSignals({ scores: { spec: 0.8, impl: 0.6, review: 0.7 } });
  assert.equal(partial.health, null);
  assert.equal(partial.healthBand, null);
});

test("T10.0 deriveIssueSignals computes composite health + band from persisted scores", () => {
  const signals = deriveIssueSignals({ scores: SCORES });
  // 0.755 rounds to 0.76 for display; band is log_only (> 0.7).
  assert.equal(signals.health, 0.76);
  assert.equal(signals.healthBand, "log_only");

  const low = deriveIssueSignals({ scores: { spec: 0.2, impl: 0.3, review: 0.4, verify: 0.3 } });
  assert.equal(low.healthBand, "alert");
  const mid = deriveIssueSignals({ scores: { spec: 0.6, impl: 0.6, review: 0.6, verify: 0.6 } });
  assert.equal(mid.health, 0.6);
  assert.equal(mid.healthBand, "banner");
});

test("T10.0 deriveFallbackBadges flags a stage whose last run carried the contractual warning", () => {
  const at = "2026-09-18T10:00:00.000Z";
  const badges = deriveFallbackBadges({
    stages: {},
    events: [
      { stage: "spec", status: "failed", reason: "typesafe_fallback_to_claude: http 500", endedAt: at },
    ],
  });
  assert.ok(badges.spec, "spec badge missing");
  assert.equal(badges.spec.reason, "http 500");
  assert.equal(badges.spec.at, at);
  assert.equal(badges.implementation, undefined);

  // An older fallback followed by a clean run does NOT badge — the LAST run
  // is what the observability clause keys on.
  const recovered = deriveFallbackBadges({
    stages: {},
    events: [
      { stage: "spec", status: "failed", reason: "typesafe_fallback_to_claude: http 500", endedAt: at },
      { stage: "spec", status: "completed", endedAt: "2026-09-18T11:00:00.000Z" },
    ],
  });
  assert.equal(recovered.spec, undefined);

  // A stage record carrying `warnings[]` also badges (forward-compatible shape).
  const fromRecord = deriveFallbackBadges({
    stages: { review: { startedAt: at, endedAt: at, status: "completed", warnings: ["typesafe_fallback_to_claude: TYPESAFE_API_KEY missing"] } },
    events: [],
  });
  assert.equal(fromRecord.review.reason, "TYPESAFE_API_KEY missing");
});

test("T10.0 fallback downgrades the affected dimension to 0.9× weight (CJK observability clause)", () => {
  const clean = deriveIssueSignals({ scores: SCORES });
  const downgraded = deriveIssueSignals({
    scores: SCORES,
    events: [{ stage: "spec", status: "failed", reason: "typesafe_fallback_to_claude: http 500", endedAt: "2026-09-18T10:00:00.000Z" }],
  });
  // The spec dimension contributed at 0.9× weight, so health strictly drops.
  assert.ok(downgraded.health < clean.health, `expected downgrade: ${downgraded.health} < ${clean.health}`);
  // Exact recomputation with the 0.9× factor on the spec weight.
  const w = { ...COMPOSITE_WEIGHTS, spec: COMPOSITE_WEIGHTS.spec * FALLBACK_WEIGHT_FACTOR };
  const expected = computeHealthJs(SCORES, w);
  assert.ok(Math.abs(downgraded.health - Math.round(expected * 100) / 100) < 1e-9, `${downgraded.health} vs ${expected}`);
  assert.ok(downgraded.fallbackBadges.spec);
});

test("T10.0 deriveStageConfidence reads persisted judgment confidence and keys it on the run id", () => {
  const confidence = deriveStageConfidence({
    stages: { spec: { startedAt: "2026-09-18T09:00:00.000Z", endedAt: "2026-09-18T09:30:00.000Z", status: "completed", runId: "run-spec-42" } },
    specs: { confidence: 0.82 },
    review: { verdict: "APPROVE" },
    events: [],
  });
  assert.equal(confidence.spec.confidence, 0.82);
  assert.equal(confidence.spec.runId, "run-spec-42");
  // review has a verdict but no persisted confidence → null, not invented.
  assert.equal(confidence.review.confidence, null);
  assert.equal(confidence.merge.confidence, null);
});

test("T10.0 PanelReadModel.issues attaches health/band/confidence/fallback additively", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-panel-t10-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".factory-daemon"), { recursive: true });
  await fs.mkdir(path.join(root, "state", "issues"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "primary" }));
  await fs.writeFile(path.join(root, ".factory-daemon", ".env"), ["FACTORY_LOCAL_DIR=fixtures", "FACTORY_STATE_DIR=state", "FACTORY_GH_REPO=acme/primary"].join("\n"));
  await fs.writeFile(path.join(root, "state", "issues", "55.json"), JSON.stringify({
    issue: { number: 55, title: "health issue", labels: [] },
    stages: { spec: { startedAt: "2026-09-18T09:00:00.000Z", endedAt: "2026-09-18T09:30:00.000Z", status: "completed", runId: "run-1" } },
    events: [{ stage: "spec", status: "completed", endedAt: "2026-09-18T09:30:00.000Z" }],
    specs: { confidence: 0.9 },
    scores: { spec: 0.9, impl: 0.85, review: 0.8, verify: 0.75 },
  }));

  const model = await createPanelReadModel(root, { includeGitHub: false });
  const [issue] = await model.issues("current");
  // Additive: the pre-existing projected fields are untouched.
  assert.equal(issue.issue.number, 55);
  assert.equal(issue.stages.spec.status, "completed");
  // New T10.0 fields are present and correct.
  assert.equal(typeof issue.health, "number");
  assert.equal(issue.healthBand, "log_only");
  assert.equal(issue.stageConfidence.spec.confidence, 0.9);
  assert.equal(issue.stageConfidence.spec.runId, "run-1");
  assert.deepEqual(issue.fallbackBadges, {});
});
