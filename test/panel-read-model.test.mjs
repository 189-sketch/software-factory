import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPanelReadModel, scoreOperationalJudgments, OPERATIONAL_JUDGMENT_THRESHOLDS } from "../runtime/panel-read-model.mjs";
import { recordLeaseWait } from "../runtime/lease-wait-state.mjs";

async function project(root, name, issueNumber, stage) {
  await fs.mkdir(path.join(root, ".factory-daemon"), { recursive: true });
  await fs.mkdir(path.join(root, "state", "issues"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name }));
  await fs.writeFile(path.join(root, ".factory-daemon", ".env"), [
    `FACTORY_STATE_DIR=state`,
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
