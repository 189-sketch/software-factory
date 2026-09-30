/**
 * Pure unit tests for `src/agents/freshness-routing.ts`.
 *
 * This module is the polling-time "resume stage" decision helper
 * (spec T11.3). The HTTP plumbing lives in `scripts/freshness-poc.mjs::
 * decideResumeStage`; these tests pin the build / parse helpers that
 * the JS shim mirrors verbatim.
 *
 * The tests are deliberately independent from the daemon so a
 * regression in the pure logic surfaces without spinning up the
 * full poll loop.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    buildResumeStageRequest,
    parseResumeStageDecision,
    RESUME_STAGE_WHITELIST,
    type ResumeStage,
} from "../agents/freshness-routing.js";

/* -------------------------------------------------------------------------- */
/* buildResumeStageRequest — wire contract                                    */
/* -------------------------------------------------------------------------- */

test("buildResumeStageRequest emits the official System One envelope (model + state + questions)", () => {
    const req = buildResumeStageRequest({
        model: "jev-latest",
        stateHash: "a".repeat(64),
        lastJudgmentHash: "b".repeat(64),
        lastTriageAt: "2026-09-22T08:00:00Z",
        issue: {
            labels: ["ready-to-spec"],
            updatedAt: "2026-09-22T08:00:00Z",
            commentsCount: 2,
        },
    });

    assert.equal(req.model, "jev-latest");
    const stateObj = req.state as Record<string, unknown>;
    assert.equal(typeof stateObj, "object");
    assert.notEqual(stateObj, null);
    assert.equal(typeof req.questions, "object");

    // `state_hash` is NOT on the wire (per the 2026-09-21 erratum);
    // the previous / new hashes travel inside `state`.
    assert.equal((req as unknown as { state_hash?: string }).state_hash, undefined);
    assert.equal(stateObj.stateHash, "a".repeat(64));
    assert.equal(stateObj.lastJudgmentHash, "b".repeat(64));
    assert.equal(stateObj.lastTriageAt, "2026-09-22T08:00:00Z");
});

test("buildResumeStageRequest defaults optional state fields to null", () => {
    const req = buildResumeStageRequest({
        model: "jev-latest",
        stateHash: "a".repeat(64),
        // `lastJudgmentHash` is the empty string in the typical
        // "brand-new issue" case — we still surface it verbatim so
        // the model can see the absence.
        lastJudgmentHash: "",
        issue: {
            labels: [],
            commentsCount: 0,
        },
    });

    const stateObj = req.state as Record<string, unknown>;
    assert.equal(stateObj.lastJudgmentHash, "");
    // Truly optional fields (lastTriageAt / updatedAt) collapse to
    // null so the model sees an explicit "no value".
    assert.equal(stateObj.lastTriageAt, null);
    assert.equal(stateObj.updatedAt, null);
    assert.deepEqual(stateObj.labels, []);
});

test("buildResumeStageRequest normalises an absent lastJudgmentHash to null", () => {
    const req = buildResumeStageRequest({
        model: "jev-latest",
        stateHash: "a".repeat(64),
        // The signature marks lastJudgmentHash as required but
        // undefined should still fall through the `?? null` guard.
        lastJudgmentHash: undefined as unknown as string,
        issue: { labels: [], commentsCount: 0 },
    });
    const stateObj = req.state as Record<string, unknown>;
    assert.equal(stateObj.lastJudgmentHash, null);
});

test("buildResumeStageRequest exposes a single closed choice question with the 7 expected criteria", () => {
    const req = buildResumeStageRequest({
        model: "jev-latest",
        stateHash: "a".repeat(64),
        lastJudgmentHash: "b".repeat(64),
        issue: { labels: [], commentsCount: 0 },
    });

    const questionIds = Object.keys(req.questions);
    assert.deepEqual(questionIds, ["resume_stage"]);

    const q = req.questions.resume_stage;
    assert.equal(q.type, "choice");
    assert.equal(typeof q.instructions, "string");
    assert.match(q.instructions as string, /state\.stateHash/);

    // The closed set MUST stay in sync with the parser whitelist.
    const expectedCriteria = new Set<string>(RESUME_STAGE_WHITELIST);
    const actualCriteria = new Set(Object.keys(q.criteria ?? {}));
    assert.deepEqual([...actualCriteria].sort(), [...expectedCriteria].sort());
});

/* -------------------------------------------------------------------------- */
/* parseResumeStageDecision — happy + failure paths                            */
/* -------------------------------------------------------------------------- */

test("parseResumeStageDecision returns ok=true for every whitelisted stage", () => {
    for (const stage of RESUME_STAGE_WHITELIST) {
        const decision = parseResumeStageDecision([
            { id: "resume_stage", value: stage, confidence: 0.9 },
        ]);
        assert.equal(decision.ok, true, `stage ${stage} should parse as ok`);
        assert.equal(decision.stage, stage);
        assert.equal(decision.confidence, 0.9);
        assert.equal(decision.reason, "ok");
    }
});

test("parseResumeStageDecision clamps confidence to [0, 1]", () => {
    const decision = parseResumeStageDecision([
        { id: "resume_stage", value: "spec", confidence: 1.7 },
    ]);
    assert.equal(decision.confidence, 1);

    const negative = parseResumeStageDecision([
        { id: "resume_stage", value: "spec", confidence: -0.4 },
    ]);
    assert.equal(negative.confidence, 0);
});

test("parseResumeStageDecision defaults confidence to 0 when NaN / undefined / non-numeric", () => {
    const cases: Array<unknown> = [
        { id: "resume_stage", value: "spec", confidence: Number.NaN },
        { id: "resume_stage", value: "spec", confidence: Number.POSITIVE_INFINITY },
        { id: "resume_stage", value: "spec", confidence: "0.9" as unknown as number },
        { id: "resume_stage", value: "spec" }, // missing confidence
    ];
    for (const c of cases) {
        const decision = parseResumeStageDecision([c as never]);
        assert.equal(decision.confidence, 0);
        assert.equal(decision.ok, true);
    }
});

test("parseResumeStageDecision collapses invalid stage values to ok=false, triage fallback", () => {
    const decision = parseResumeStageDecision([
        { id: "resume_stage", value: "bogus-stage", confidence: 0.5 },
    ]);
    assert.equal(decision.ok, false);
    assert.equal(decision.stage, "triage");
    assert.equal(decision.confidence, 0);
    assert.equal(decision.reason, "invalid-stage");
});

test("parseResumeStageDecision returns parse-miss when the array is empty or missing the expected id", () => {
    assert.deepEqual(parseResumeStageDecision([]), {
        ok: false,
        stage: "triage",
        confidence: 0,
        reason: "parse-miss",
    });
    assert.deepEqual(
        parseResumeStageDecision([{ id: "other_primitive", value: "spec", confidence: 0.5 }]),
        {
            ok: false,
            stage: "triage",
            confidence: 0,
            reason: "parse-miss",
        },
    );
});

test("parseResumeStageDecision returns no-answer when value is not a string", () => {
    const decision = parseResumeStageDecision([
        { id: "resume_stage", value: 42 as unknown as string, confidence: 0.5 },
    ]);
    assert.equal(decision.ok, false);
    assert.equal(decision.stage, "triage");
    assert.equal(decision.reason, "no-answer");
});

test("parseResumeStageDecision ignores order — finds resume_stage anywhere in the array", () => {
    const decision = parseResumeStageDecision([
        { id: "freshness", value: true, confidence: 0.2 },
        { id: "resume_stage", value: "review", confidence: 0.7 },
    ]);
    assert.equal(decision.ok, true);
    assert.equal(decision.stage, "review");
    assert.equal(decision.confidence, 0.7);
});

/* -------------------------------------------------------------------------- */
/* Type surface — whitelist export pins the closed set                        */
/* -------------------------------------------------------------------------- */

test("RESUME_STAGE_WHITELIST is frozen with 7 entries in pipeline order", () => {
    assert.equal(Object.isFrozen(RESUME_STAGE_WHITELIST), true);
    assert.deepEqual([...RESUME_STAGE_WHITELIST], [
        "wait",
        "triage",
        "spec",
        "implementation",
        "review",
        "verify",
        "merge",
    ] satisfies ReadonlyArray<ResumeStage>);
});