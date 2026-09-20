/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T8.2 acceptance tests.
 *
 * Covers three contract bullets:
 * 1. `buildJudgmentState` returns a `JudgmentState` populated from a
 *    minimal issue fixture.
 * 2. `stateHashFor` is deterministic: same input -> same 64-char sha-256;
 *    changing any field changes the digest.
 * 3. Optional fields (`roadmap`, `prDiff`, `specBody`,
 *    `implementationDiff`, factory fields) default to undefined when the
 *    caller does not supply them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJudgmentState,
  stateHashFor,
  type DecisionRecord,
  type JudgmentState,
  type ReceiptRegistry,
} from "../core/judgment-state.js";
import type { Issue } from "../core/types.js";

function fixtureIssue(): Issue {
  return {
    number: 42,
    title: "Add a `typesafe` adapter",
    body: "Connect to api.typesafe.ai for cheap judgments.",
    labels: ["ready-to-implement"],
    author: "operator",
    url: "https://example.com/42",
    createdAt: "2026-09-20T10:00:00Z",
    comments: [
      { author: "operator", body: "Original ask.", createdAt: "2026-09-20T10:00:00Z" },
      { author: "factory", body: "<!-- pi-software-factory:triage:ready-to-implement -->\nNoted.", createdAt: "2026-09-20T10:05:00Z" },
      { author: "operator", body: "Looks good.", createdAt: "2026-09-20T11:00:00Z" },
    ],
  };
}

test("buildJudgmentState populates issue fields from a minimal fixture", () => {
  const issue = fixtureIssue();
  const state = buildJudgmentState(issue);

  assert.equal(state.issue.number, 42);
  assert.equal(state.issue.title, issue.title);
  assert.equal(state.issue.body, issue.body);
  assert.deepEqual(state.issue.labels, ["ready-to-implement"]);
  assert.equal(state.issue.updatedAt, issue.createdAt, "falls back to createdAt when no updatedAt is supplied");
  assert.equal(state.issue.comments.length, 3);
  // The factory comment (with the marker) is detected; the two operator comments are not.
  assert.equal(state.issue.comments[0].isFactoryComment, false);
  assert.equal(state.issue.comments[1].isFactoryComment, true);
  assert.equal(state.issue.comments[2].isFactoryComment, false);
  // Per-comment shape: only the contract fields survive.
  assert.deepEqual(Object.keys(state.issue.comments[0]).sort(), ["author", "body", "createdAt", "isFactoryComment"]);
});

test("buildJudgmentState prefers opts.issueUpdatedAt, then issue.updatedAt, then issue.createdAt", () => {
  const base = fixtureIssue();
  const explicit = "2026-09-20T12:00:00Z";
  const fromOpt = buildJudgmentState(base, undefined, { issueUpdatedAt: explicit });
  assert.equal(fromOpt.issue.updatedAt, explicit);

  const fromInput = buildJudgmentState({ ...base, updatedAt: "2026-09-20T11:30:00Z" });
  assert.equal(fromInput.issue.updatedAt, "2026-09-20T11:30:00Z");

  const fromCreatedAt = buildJudgmentState(base);
  assert.equal(fromCreatedAt.issue.updatedAt, base.createdAt);
});

test("buildJudgmentState applies factory context supplied via ctx or opts (and defaults)", () => {
  const issue = fixtureIssue();
  const prior: DecisionRecord[] = [
    { action: "triage.apply_label", outcome: "auto", ts: "2026-09-20T10:05:00Z" },
  ];
  const registry: ReceiptRegistry = { receipts: [{ id: "r1", kind: "browser", passed: true }] };
  const failureCounts = { implementation: { TRANSIENT: 2, ENVIRONMENT: 1 } };

  const viaCtx = buildJudgmentState(issue, { factory: { failureCounts, lastTriageAt: "2026-09-20T10:05:00Z", priorDecisions: prior, lastReceiptRegistry: registry } });
  assert.equal(viaCtx.factory.lastTriageAt, "2026-09-20T10:05:00Z");
  assert.deepEqual(viaCtx.factory.failureCounts, failureCounts);
  assert.equal(viaCtx.factory.priorDecisions.length, 1);
  assert.equal(viaCtx.factory.lastReceiptRegistry, registry);

  const viaOpts = buildJudgmentState(issue, undefined, { factory: { failureCounts: {} } });
  assert.deepEqual(viaOpts.factory.failureCounts, {});
  assert.deepEqual(viaOpts.factory.priorDecisions, [], "defaults to empty array");

  const noFactory = buildJudgmentState(issue);
  assert.deepEqual(noFactory.factory.failureCounts, {});
  assert.deepEqual(noFactory.factory.priorDecisions, []);
  assert.equal(noFactory.factory.lastTriageAt, undefined);
  assert.equal(noFactory.factory.lastReceiptRegistry, undefined);
});

test("buildJudgmentState default repoSignals are safe placeholders", () => {
  const state = buildJudgmentState(fixtureIssue());
  assert.deepEqual(state.repoSignals, { primaryLanguage: "unknown", hasOpenSpec: false, hasOpenPRs: 0 });
});

test("buildJudgmentState keeps optional top-level fields undefined unless supplied", () => {
  const state = buildJudgmentState(fixtureIssue());
  assert.equal(state.roadmap, undefined);
  assert.equal(state.prDiff, undefined);
  assert.equal(state.specBody, undefined);
  assert.equal(state.implementationDiff, undefined);

  const state2 = buildJudgmentState(fixtureIssue(), undefined, {
    roadmap: { missionText: "m", relevantSectionText: "r" },
    prDiff: "+ 1\n- 0",
    specBody: "# SPEC",
    implementationDiff: "+ 2\n- 1",
  });
  assert.deepEqual(state2.roadmap, { missionText: "m", relevantSectionText: "r" });
  assert.equal(state2.prDiff, "+ 1\n- 0");
  assert.equal(state2.specBody, "# SPEC");
  assert.equal(state2.implementationDiff, "+ 2\n- 1");
});

test("buildJudgmentState clones the roadmap section so callers cannot mutate it", () => {
  const roadmap = { missionText: "m" };
  const state = buildJudgmentState(fixtureIssue(), undefined, { roadmap });
  roadmap.missionText = "tampered";
  assert.equal(state.roadmap?.missionText, "m");
});

test("buildJudgmentState honours a custom isFactoryComment detector", () => {
  const issue = fixtureIssue();
  const detector = (_c: { body?: string }) => true;
  const state = buildJudgmentState(issue, undefined, { isFactoryComment: detector });
  assert.equal(state.issue.comments[0].isFactoryComment, true);
  assert.equal(state.issue.comments[1].isFactoryComment, true);
  assert.equal(state.issue.comments[2].isFactoryComment, true);
});

test("stateHashFor is deterministic and returns a 64-char sha-256 hex digest", () => {
  const state = buildJudgmentState(fixtureIssue());
  const a = stateHashFor(state);
  const b = stateHashFor(state);
  assert.equal(a, b, "same input must hash to the same digest");
  assert.match(a, /^[a-f0-9]{64}$/, "digest must be lowercase sha-256 hex");
});

test("stateHashFor is sensitive to every input field", () => {
  const baseIssue = fixtureIssue();
  const base = buildJudgmentState(baseIssue);
  const baseline = stateHashFor(base);

  // updatedAt
  const withUpdatedAt = buildJudgmentState(baseIssue, undefined, { issueUpdatedAt: "2026-09-21T00:00:00Z" });
  assert.notEqual(stateHashFor(withUpdatedAt), baseline);

  // comments.length (one extra comment)
  const withExtraComment = buildJudgmentState({
    ...baseIssue,
    comments: [...baseIssue.comments, { author: "operator", body: "thanks", createdAt: "2026-09-20T12:00:00Z" }],
  });
  assert.notEqual(stateHashFor(withExtraComment), baseline);

  // labels (one extra label)
  const withExtraLabel = buildJudgmentState({ ...baseIssue, labels: [...baseIssue.labels, "needs-info"] });
  assert.notEqual(stateHashFor(withExtraLabel), baseline);

  // factory.lastTriageAt
  const withTriageAt = buildJudgmentState(baseIssue, { factory: { failureCounts: {}, lastTriageAt: "2026-09-20T11:00:00Z" } });
  assert.notEqual(stateHashFor(withTriageAt), baseline);

  // factory.lastReceiptRegistry (one extra receipt)
  const withRegistry: JudgmentState = {
    ...base,
    factory: {
      ...base.factory,
      lastReceiptRegistry: { receipts: [{ id: "r1", kind: "browser", passed: true, detail: null }] },
    },
  };
  assert.notEqual(stateHashFor(withRegistry), baseline);

  // Different registry content -> different hash
  const withDifferentRegistry: JudgmentState = {
    ...base,
    factory: {
      ...base.factory,
      lastReceiptRegistry: { receipts: [{ id: "r1", kind: "browser", passed: false, detail: null }] },
    },
  };
  assert.notEqual(stateHashFor(withRegistry), stateHashFor(withDifferentRegistry));
});

test("stateHashFor omits the receipt sha when the registry is undefined", () => {
  const a = buildJudgmentState(fixtureIssue());
  const b = buildJudgmentState(fixtureIssue(), { factory: { failureCounts: {} } });
  // Both states have no registry; the hash ignores the receipt slot entirely,
  // matching the spec's "absence encoded as ''" rule.
  assert.equal(stateHashFor(a), stateHashFor(b));

  // The hash of a state whose registry slot is undefined must NOT depend on
  // any registry-derived bytes. Sanity check: a separate state whose only
  // difference is a present registry hashes to something different.
  const c = buildJudgmentState(fixtureIssue(), {
    factory: { failureCounts: {}, lastReceiptRegistry: { receipts: [] } },
  });
  assert.notEqual(stateHashFor(a), stateHashFor(c));
});

test("stateHashFor ignores optional non-hash fields (roadmap, prDiff, specBody, implementationDiff)", () => {
  const lean = buildJudgmentState(fixtureIssue());
  const rich = buildJudgmentState(fixtureIssue(), undefined, {
    roadmap: { missionText: "we have a mission" },
    prDiff: "+ 100\n- 100",
    specBody: "# huge spec",
    implementationDiff: "+ 200\n- 200",
  });
  assert.equal(stateHashFor(lean), stateHashFor(rich), "freshness hash is intentionally oblivious to optional payload fields");
});
