/**
 * Acceptance tests for the R-series spec-review rubric (issue #39
 * convergence fix).
 *
 * Covers:
 *   - reviewRubricInputFromSpec   positional ids + previous-finding carry
 *   - buildReviewRubricRequest    one question per point, correct kinds, shared state
 *   - parseRubricAnswer           tolerant parse, malformed drops, null contract
 *   - deriveRubricVerdict         per-rule polarity, thresholds, fixed severity, R7 carry-over
 *   - updateRubricFailureCounts   increment / clear-on-pass / repeated detection
 *   - synthesizeRubricReview      publishable SpecReviewResult shape, validateFinding-clean
 *   - deriveReviewVerdict floor   LLM-exploration downweight (exploreBlockFloor)
 *   - resolveExploreBlockFloor    env parsing / clamping / disable
 *   - SpecRubricRepeatedFailureError message classifies as USER_INPUT_REQUIRED
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_RUBRIC_THRESHOLDS,
    RUBRIC_RATCHET_LIMIT,
    countRubricPoints,
    deriveRubricVerdict,
    parseRubricAnswer,
    reviewRubricInputFromSpec,
    synthesizeRubricReview,
    updateRubricFailureCounts,
    type ReviewRubricInput,
} from "../core/spec-review-rubric.js";
import { buildReviewRubricRequest, buildReviewRubricState } from "../agents/spec-review-rubric.js";
import { deriveReviewVerdict, resolveExploreBlockFloor } from "../core/spec-verdict.js";
import { validateFinding } from "../core/findings.js";
import { classifyError } from "../core/failure-classifier.js";
import { SpecRubricRepeatedFailureError } from "../orchestrator/index.js";
import type {
    Finding,
    ReviewSpecTypesafeBatchAnswer,
    SpecPair,
    SpecReviewResult,
    SpecRubricAnswerEntry,
    SpecRubricBatchAnswer,
} from "../core/types.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeIssue() {
    return {
        number: 39,
        title: "upgrade ui",
        body: "现在前端ui效果太差，需要使用apple 设计风格进行优化",
        labels: [],
        author: "189-sketch",
        url: "https://github.com/acme/demo/issues/39",
        createdAt: "2026-09-21T08:27:44Z",
        comments: [],
    } as unknown as Parameters<typeof buildReviewRubricState>[0];
}

function makeSpec(): SpecPair {
    return {
        product: {
            slug: "issue-39-upgrade-ui",
            title: "Upgrade UI",
            problem: "UI is plain",
            goals: ["Apple design language"],
            nonGoals: ["No backend changes"],
            stories: [
                {
                    id: "US-1",
                    title: "Nav refresh",
                    asA: "user",
                    iWant: "a translucent nav bar",
                    soThat: "the app feels modern",
                    checks: ["nav uses blur", "active route is highlighted"],
                },
                {
                    id: "US-2",
                    title: "Card motion",
                    asA: "user",
                    iWant: "spring transitions on cards",
                    soThat: "interactions feel alive",
                    checks: ["cards transition transform, opacity, background and box-shadow"],
                },
            ],
            acceptanceCriteria: [
                "AC-1: nav bar renders with a translucent surface",
                "AC-2: card transition includes at least one of transform/opacity/background/box-shadow",
            ],
            openQuestions: ["Should the sidebar follow Big Sur style?"],
            body: "# PRODUCT.md body",
        },
        tech: {
            slug: "issue-39-upgrade-ui",
            approach: "Introduce a token layer and rewrite module CSS",
            affectedAreas: ["template/src/tokens.css"],
            dataModel: "none",
            apiChanges: [],
            migrationPlan: "Add tokens.css, then migrate modules",
            validationPlan: ["grep the module CSS for legacy hex values"],
            alternatives: ["Runtime theme provider — rejected"],
            openQuestions: ["Which cubic-bezier curve is 'spring-feel'?"],
            body: "# TECH.md body",
        },
        specBranch: "spec/issue-39-upgrade-ui",
        specPrUrl: "",
    } as unknown as SpecPair;
}

function makePreviousFindings(): Finding[] {
    return [
        {
            id: "prev-f-1",
            ruleId: "severity-important-0",
            severity: "important",
            requirementIds: ["AC-2"],
            summary: "AC-2 quantifier mismatches US-2 (at least one of vs all four)",
            evidence: {},
            sourceStage: "review-spec",
            sourceRunId: "run-1",
            registeredAt: "2026-09-21T08:43:00Z",
            status: "open",
        },
        {
            id: "prev-f-2",
            ruleId: "typesafe-veto",
            severity: "blocking",
            requirementIds: [],
            summary: "B3: unverifiable acceptance criteria (AC-9)",
            evidence: {},
            sourceStage: "spec",
            sourceRunId: "run-0",
            registeredAt: "2026-09-21T08:34:00Z",
            status: "open",
        },
    ];
}

/** Adapter-normalised noul entry: value = p ≥ 0.5, confidence = raw p. */
function noul(id: string, p: number): SpecRubricAnswerEntry {
    const parsed = /^(R[1-7])-(.+)$/.exec(id)!;
    return { id, rule: parsed[1], target: parsed[2], value: p >= 0.5, confidence: p };
}

function score(id: string, value: number, confidence = 0.9): SpecRubricAnswerEntry {
    const parsed = /^(R[1-7])-(.+)$/.exec(id)!;
    return { id, rule: parsed[1], target: parsed[2], value, confidence };
}

function batch(entries: SpecRubricAnswerEntry[]): SpecRubricBatchAnswer {
    const mean = entries.reduce((s, e) => s + e.confidence, 0) / (entries.length || 1);
    return { entries, meanConfidence: mean };
}

/** All-pass answer batch for the makeSpec fixture. */
function passingBatch(input: ReviewRubricInput): SpecRubricBatchAnswer {
    const entries: SpecRubricAnswerEntry[] = [];
    for (const ac of input.acceptanceCriteria) entries.push(noul(`R1-${ac.id}`, 0.95));
    for (const s of input.stories) {
        entries.push(score(`R2-${s.id}`, 1.0));
        entries.push(noul(`R5-${s.id}`, 0.95));
    }
    for (const vp of input.validationPlan) entries.push(noul(`R3-${vp.id}`, 0.95));
    for (const oq of input.openQuestions) entries.push(noul(`R4-${oq.id}`, 0.1));
    for (const ng of input.nonGoals) entries.push(noul(`R6-${ng.id}`, 0.05));
    for (const pf of input.previousFindings) entries.push(noul(`R7-${pf.id}`, 0.95));
    return batch(entries);
}

/* -------------------------------------------------------------------------- */
/* reviewRubricInputFromSpec                                                   */
/* -------------------------------------------------------------------------- */

test("reviewRubricInputFromSpec: positional ids and previous-finding carry", () => {
    const spec = makeSpec();
    const input = reviewRubricInputFromSpec(spec, makePreviousFindings());
    assert.deepEqual(input.acceptanceCriteria.map((a) => a.id), ["AC-1", "AC-2"]);
    assert.deepEqual(input.stories.map((s) => s.id), ["US-1", "US-2"]);
    assert.deepEqual(input.validationPlan.map((v) => v.id), ["VP-1"]);
    assert.deepEqual(input.openQuestions.map((o) => o.id), ["OQ-P-1", "OQ-T-1"]);
    assert.deepEqual(input.nonGoals.map((n) => n.id), ["NG-1"]);
    assert.equal(input.previousFindings.length, 2);
    assert.equal(input.previousFindings[0].id, "PF-1");
    assert.equal(input.previousFindings[0].findingId, "prev-f-1");
    assert.deepEqual(input.previousFindings[0].requirementIds, ["AC-2"]);
    // 2 AC (R1) + 2 stories (R2) + 1 VP (R3) + 2 OQ (R4) + 2 stories (R5) + 1 NG (R6) + 2 PF (R7) = 12
    assert.equal(countRubricPoints(input), 12);
});

test("reviewRubricInputFromSpec: story id falls back to positional US-n", () => {
    const spec = makeSpec();
    (spec.product.stories as Array<{ id: string }>)[0].id = "  ";
    const input = reviewRubricInputFromSpec(spec, undefined);
    assert.equal(input.stories[0].id, "US-1");
    assert.deepEqual(input.previousFindings, []);
});

/* -------------------------------------------------------------------------- */
/* buildReviewRubricRequest / buildReviewRubricState                           */
/* -------------------------------------------------------------------------- */

test("buildReviewRubricRequest: one question per judgment point, correct kinds", () => {
    const spec = makeSpec();
    const input = reviewRubricInputFromSpec(spec, makePreviousFindings());
    const state = buildReviewRubricState(makeIssue(), spec, input);
    const request = buildReviewRubricRequest(state, input);

    assert.equal(Object.keys(request.questions).length, countRubricPoints(input));
    assert.equal(typeof request.model, "string");
    assert.ok(request.model.length > 0);

    // R2 is the only score family; 4 ordered levels.
    const r2 = request.questions["R2-US-2"];
    assert.equal(r2.type, "score");
    assert.equal((r2.criteria as string[]).length, 4);

    // Noul families carry true/false criteria.
    for (const id of ["R1-AC-1", "R3-VP-1", "R4-OQ-P-1", "R5-US-1", "R6-NG-1", "R7-PF-1"]) {
        const q = request.questions[id];
        assert.equal(q.type, "noul", `${id} should be noul`);
        assert.ok(q.criteria && typeof q.criteria === "object");
        assert.ok("true" in (q.criteria as object) && "false" in (q.criteria as object));
    }

    assert.match(request.questions["R3-VP-1"].instructions as string, /document-content requirements/);
    assert.match(request.questions["R3-VP-1"].instructions as string, /explicit manual checklist/);
    // R2 instructions pin the quantifier-alignment rule (issue #39 root cause).
    assert.match(r2.instructions as string, /quantifier/i);
    // R1 instructions enumerate the three pass forms (calibrated to user
    // intent per the "ask for what the user asked for" feedback): automated
    // assertion / named reference system / explicit default table + override.
    assert.match(
        request.questions["R1-AC-1"].instructions as string,
        /named reference system/i,
    );
    assert.match(request.questions["R1-AC-1"].instructions as string, /default table/i);
    // R3 instructions enumerate the three pass forms and keep the raw-grep
              // guard so style/content assertions don't false-positive on comments.
    assert.match(request.questions["R3-VP-1"].instructions as string, /named tool/i);
    assert.match(request.questions["R3-VP-1"].instructions as string, /checklist/i);
    assert.match(request.questions["R3-VP-1"].instructions as string, /raw grep/i);
    // R7 instructions carry the previous severity + summary.
    assert.match(request.questions["R7-PF-1"].instructions as string, /\[important\]/);

    // Shared state slice is present for backticked path references.
    assert.equal(state.spec.acceptanceCriteria.length, 2);
    assert.equal(state.spec.stories.length, 2);
    assert.equal(state.spec.previousFindings.length, 2);
    assert.equal(state.spec.techBody, "# TECH.md body");
});

test("rubric revision state preserves finding evidence and observed document terminators", () => {
    const spec = makeSpec();
    spec.product.body += '\n';
    const findings = makePreviousFindings();
    findings[0].evidence = { path: 'TECH.md', line: 12, excerpt: 'Detailed defect omitted from the short summary' };
    const input = reviewRubricInputFromSpec(spec, findings);
    const state = buildReviewRubricState(makeIssue(), spec, input);
    assert.deepEqual(state.spec.previousFindings[0].evidence, findings[0].evidence);
    assert.deepEqual(state.spec.documentFacts, { productEndsWithNewline: true, techEndsWithNewline: false });
    const request = buildReviewRubricRequest(state, input);
    assert.match(request.questions['R7-PF-1'].instructions as string, /spec.documentFacts/);
    assert.match(request.questions['R7-PF-1'].instructions as string, /spec.previousFindings/);
});

test('rubric state preserves author decisions without duplicate bodies or factory history', () => {
    const spec = makeSpec();
    const issue = makeIssue();
    issue.comments = [
        { author: 'author', body: 'Keep the documented commands local', createdAt: '2026-09-30T00:00:00Z' },
        { author: 'factory', body: 'Old review history <!-- pi-software-factory:spec-review:39:old -->', createdAt: '2026-09-30T00:01:00Z' },
    ];
    const state = buildReviewRubricState(issue, spec, reviewRubricInputFromSpec(spec, makePreviousFindings()));
    assert.equal(state.specBody, undefined);
    assert.equal(state.spec.productBody, spec.product.body);
    assert.equal(state.spec.techBody, spec.tech.body);
    assert.deepEqual(state.issue.comments.map((comment) => comment.body), ['Keep the documented commands local']);
    assert.equal(state.spec.previousFindings.length, 2);
    assert.equal(issue.comments.length, 2, 'The authoritative issue is not modified by prompt projection');
});

/* -------------------------------------------------------------------------- */
/* parseRubricAnswer                                                           */
/* -------------------------------------------------------------------------- */

test("parseRubricAnswer: tolerant parse; malformed entries dropped; null when unusable", () => {
    const wire = [
        { id: "R1-AC-1", value: true, confidence: 0.93 },
        { id: "R2-US-1", value: 0.67, confidence: 0.88 },
        { id: "R1-AC-2", value: "yes", confidence: 0.9 }, // wrong value type → dropped
        { id: "R2-US-2", value: true, confidence: 0.9 }, // wrong value type → dropped
        { id: "R9-XX-1", value: true, confidence: 0.9 }, // unknown rule → dropped
        { id: "R3-VP-1", value: false, confidence: "high" }, // bad confidence → dropped
        { id: "R4-OQ-P-1", value: false, confidence: 0.2 },
        null, // junk → dropped
    ];
    const answer = parseRubricAnswer(wire);
    assert.ok(answer);
    assert.deepEqual(answer.entries.map((e) => e.id), ["R1-AC-1", "R2-US-1", "R4-OQ-P-1"]);
    assert.equal(answer.entries[0].rule, "R1");
    assert.equal(answer.entries[0].target, "AC-1");
    assert.ok(answer.meanConfidence > 0);

    assert.equal(parseRubricAnswer([]), null);
    assert.equal(parseRubricAnswer(undefined), null);
    assert.equal(parseRubricAnswer([{ id: "R9-X", value: true, confidence: 1 }]), null);
});

/* -------------------------------------------------------------------------- */
/* deriveRubricVerdict                                                         */
/* -------------------------------------------------------------------------- */

test("deriveRubricVerdict: all points pass → verdict pass, no findings", () => {
    const input = reviewRubricInputFromSpec(makeSpec(), makePreviousFindings());
    const out = deriveRubricVerdict(passingBatch(input), input);
    assert.equal(out.verdict, "pass");
    assert.deepEqual(out.findings, []);
    assert.deepEqual(out.failedPoints, []);
});

test("deriveRubricVerdict: R1 unverifiable AC (issue #39 AC-6 pattern) → important + reject", () => {
    const input = reviewRubricInputFromSpec(makeSpec(), undefined);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => (e.id === "R1-AC-2" ? noul("R1-AC-2", 0.3) : e));
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "reject");
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].rule, "R1");
    assert.equal(out.findings[0].severity, "important");
    assert.equal(out.findings[0].ruleId, "rubric-ac-unobservable");
    assert.match(out.findings[0].summary, /at least one of/); // quotes the AC text
    // failedPoints is identity-hashed (issue #46, 2026-09-24) so the
    // ratchet survives positional renumbering across rounds. Format:
    // `R{n}-<hash>` (no positional prefix — identity-only).
    assert.equal(out.failedPoints.length, 1);
    assert.match(out.failedPoints[0], /^R1-[0-9a-f]{16}$/);
});

test("deriveRubricVerdict: R2 coverage bands (none/weak → important, strong → suggestion, full → pass)", () => {
    const input = reviewRubricInputFromSpec(makeSpec(), undefined);
    const weak = passingBatch(input);
    weak.entries = weak.entries.map((e) => (e.id === "R2-US-2" ? score("R2-US-2", 0.33) : e));
    const outWeak = deriveRubricVerdict(weak, input);
    assert.equal(outWeak.verdict, "reject");
    assert.equal(outWeak.findings[0].severity, "important");
    assert.match(outWeak.findings[0].summary, /US-2/);

    const strong = passingBatch(input);
    strong.entries = strong.entries.map((e) => (e.id === "R2-US-2" ? score("R2-US-2", 0.67) : e));
    const outStrong = deriveRubricVerdict(strong, input);
    assert.equal(outStrong.verdict, "pass"); // suggestion never blocks
    assert.equal(outStrong.findings.length, 1);
    assert.equal(outStrong.findings[0].severity, "suggestion");
    // failedPoints is identity-hashed (`R2-<hash>`) — same rationale
    // as the R1 test above.
    assert.equal(outStrong.failedPoints.length, 1);
    assert.match(outStrong.failedPoints[0], /^R2-[0-9a-f]{16}$/);
});

test("deriveRubricVerdict: R4/R6 negative polarity — high yes-probability is the defect", () => {
    const input = reviewRubricInputFromSpec(makeSpec(), undefined);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => {
        if (e.id === "R4-OQ-P-1") return noul("R4-OQ-P-1", 0.91); // blocks implementation
        if (e.id === "R6-NG-1") return noul("R6-NG-1", 0.85); // non-goal leaked
        return e;
    });
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "reject");
    const r4 = out.findings.find((f) => f.rule === "R4");
    const r6 = out.findings.find((f) => f.rule === "R6");
    assert.ok(r4 && r4.severity === "important" && r4.ruleId === "rubric-blocking-open-question");
    assert.ok(r6 && r6.severity === "blocking" && r6.ruleId === "rubric-non-goal-implemented");
});

test("deriveRubricVerdict: R3 brittle grep validation item → important", () => {
    const input = reviewRubricInputFromSpec(makeSpec(), undefined);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => (e.id === "R3-VP-1" ? noul("R3-VP-1", 0.15) : e));
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "reject");
    assert.equal(out.findings[0].ruleId, "rubric-validation-not-runnable");
    assert.match(out.findings[0].summary, /grep the module CSS/);
});

test("deriveRubricVerdict: R1 named-reference AC at high p → pass (calibrated to user intent)", () => {
    // Issue body asks "use Apple style" — the AC names Apple HIG as
    // the reference system plus the artifact to compare against, and
    // declares the override channel. R1 must accept this without
    // requiring per-token author sign-off.
    const spec = makeSpec();
    spec.product.acceptanceCriteria = [
        "AC-1: rendered output conforms to Apple Human Interface Guidelines light-mode (named reference + compare artifact: https://developer.apple.com/design/human-interface-guidelines/); default token table at §6; author override channel is PR comments before auto-merge.",
    ];
    const input = reviewRubricInputFromSpec(spec, undefined);
    const answer = passingBatch(input);
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "pass");
    assert.equal(out.findings.length, 0);
});

test("deriveRubricVerdict: R1 default-token-table AC at high p → pass", () => {
    // AC references the spec body's own default token table — author
    // override is via PR comments, not per-token sign-off.
    const spec = makeSpec();
    spec.product.acceptanceCriteria = [
        "AC-1: every component stylesheet consumes tokens from `specs/<slug>/tokens.md` (the default table declared in §6); tokens are defined once. Visual conformance reviewed against Apple HIG light-mode.",
    ];
    const input = reviewRubricInputFromSpec(spec, undefined);
    const answer = passingBatch(input);
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "pass");
    assert.equal(out.findings.length, 0);
});

test("deriveRubricVerdict: R1 bare-qualitative AC with no reference + no defaults → still fails", () => {
    // An AC that names no reference system, references no default
    // table, and provides no override channel is NOT satisfiable as
    // written — the rubric still catches this (the user didn't ask
    // for hex codes, but they also didn't ask for a hand-wave).
    const spec = makeSpec();
    spec.product.acceptanceCriteria = ["AC-1: looks polished."];
    const input = reviewRubricInputFromSpec(spec, undefined);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => (e.id === "R1-AC-1" ? noul("R1-AC-1", 0.4) : e));
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "reject");
    assert.equal(out.findings[0].ruleId, "rubric-ac-unobservable");
});

test("deriveRubricVerdict: R3 named-tool VP at high p → pass (e.g. axe-core)", () => {
    // "axe-core --tags wcag2aa" is a named tool with specific input
    // args — satisfies R3 without bespoke interpretation.
    const spec = makeSpec();
    spec.tech.validationPlan = ["axe-core --tags wcag2aa against the rendered dev server (npm run preview)"];
    const input = reviewRubricInputFromSpec(spec, undefined);
    const answer = passingBatch(input);
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "pass");
});

test("deriveRubricVerdict: R3 manual-review-with-checklist VP at high p → pass", () => {
    const spec = makeSpec();
    spec.tech.validationPlan = [
        "manual visual review against Apple HIG (checklist: 1. typography hierarchy, 2. spacing scale, 3. corner radii, 4. shadow depth, 5. focus indicator visibility on every interactive element)",
    ];
    const input = reviewRubricInputFromSpec(spec, undefined);
    const answer = passingBatch(input);
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "pass");
});

test("deriveRubricVerdict: R7 carries previous severity and summary; suggestion stays non-blocking", () => {
    const prev: Finding[] = [
        { ...makePreviousFindings()[0], severity: "suggestion" },
    ];
    const input = reviewRubricInputFromSpec(makeSpec(), prev);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => (e.id === "R7-PF-1" ? noul("R7-PF-1", 0.08) : e));
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "pass"); // carried suggestion does not block
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].severity, "suggestion");
    assert.equal(out.findings[0].carriedFindingId, "prev-f-1");
    assert.match(out.findings[0].summary, /quantifier mismatches US-2/);
});

test("deriveRubricVerdict: R7 carried blocking with empty requirementIds falls back to the point target", () => {
    const prev = [makePreviousFindings()[1]]; // blocking, requirementIds: []
    const input = reviewRubricInputFromSpec(makeSpec(), prev);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => (e.id === "R7-PF-1" ? noul("R7-PF-1", 0.02) : e));
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.findings[0].severity, "blocking");
    assert.deepEqual(out.findings[0].requirementIds, ["PF-1"]);
});

test("deriveRubricVerdict: missing entries are skipped, malformed values ignored", () => {
    const input = reviewRubricInputFromSpec(makeSpec(), undefined);
    // Only one of two R1 points answered; a malformed R2 sneaks in.
    const answer = batch([
        noul("R1-AC-1", 0.9),
        { id: "R2-US-1", rule: "R2", target: "US-1", value: true as unknown as number, confidence: 0.9 },
    ]);
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "pass");
    assert.deepEqual(out.findings, []);
});

test("deriveRubricVerdict: deterministic — same input produces identical output", () => {
    const input = reviewRubricInputFromSpec(makeSpec(), makePreviousFindings());
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => (e.id === "R1-AC-2" ? noul("R1-AC-2", 0.3) : e));
    const a = deriveRubricVerdict(answer, input);
    const b = deriveRubricVerdict(answer, input);
    assert.deepEqual(a, b);
});

test("deriveRubricVerdict: custom noulMin threshold tightens the gate", () => {
    const input = reviewRubricInputFromSpec(makeSpec(), undefined);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => (e.id === "R1-AC-1" ? noul("R1-AC-1", 0.55) : e));
    assert.equal(deriveRubricVerdict(answer, input).verdict, "pass"); // default 0.5
    const strict = deriveRubricVerdict(answer, input, { noulMin: 0.6 });
    assert.equal(strict.verdict, "reject");
});

/* -------------------------------------------------------------------------- */
/* updateRubricFailureCounts (convergence ratchet)                             */
/* -------------------------------------------------------------------------- */

test("updateRubricFailureCounts: increment, clear-on-pass, repeated detection", () => {
    // Use identity-hashed keys (issue #46, 2026-09-24) — the ratchet
    // tracks points by content hash, not by position.
    const pointA = "R1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pointB = "R2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const first = updateRubricFailureCounts(undefined, [pointA, pointB]);
    assert.deepEqual(first.counts, { [pointA]: 1, [pointB]: 1 });
    assert.deepEqual(first.repeated, []);

    const second = updateRubricFailureCounts(first.counts, [pointA]);
    assert.deepEqual(second.counts, { [pointA]: 2 }); // pointB passed → cleared
    assert.deepEqual(second.repeated, [pointA]);

    const clean = updateRubricFailureCounts(second.counts, []);
    assert.deepEqual(clean.counts, {});
    assert.deepEqual(clean.repeated, []);

    assert.equal(RUBRIC_RATCHET_LIMIT, 2);
});

/* -------------------------------------------------------------------------- */
/* synthesizeRubricReview                                                      */
/* -------------------------------------------------------------------------- */

test("synthesizeRubricReview: publishable REJECT shape with valid findings", () => {
    const input = reviewRubricInputFromSpec(makeSpec(), undefined);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => {
        if (e.id === "R1-AC-2") return noul("R1-AC-2", 0.3);
        if (e.id === "R6-NG-1") return noul("R6-NG-1", 0.9);
        return e;
    });
    const verdict = deriveRubricVerdict(answer, input);
    const review = synthesizeRubricReview(verdict, answer, "run-42", "rev-1");

    assert.equal(review.verdict, "REJECT");
    assert.deepEqual(review.comments, []);
    assert.equal(review.revisionId, "rev-1");
    assert.equal(review.confidence, answer.meanConfidence);
    assert.equal(review.rubricBatch, answer);
    assert.match(review.body, /^Found: 1 critical, 1 important, 0 suggestions, 0 nits\./);
    assert.match(review.body, /\*\*\[CRITICAL\]\*\*/);
    assert.match(review.body, /\*\*\[IMPORTANT\]\*\*/);
    assert.match(review.body, /R-series spec-review rubric batch/);
    assert.match(review.notes, /rubric reasons:/);

    assert.equal(review.findings?.length, 2);
    for (const f of review.findings ?? []) {
        assert.deepEqual(validateFinding(f), [], `finding invalid: ${JSON.stringify(f)}`);
        assert.equal(f.sourceStage, "review-spec");
        assert.equal(f.sourceRunId, "run-42");
        assert.equal(f.status, "open");
    }
});

/* -------------------------------------------------------------------------- */
/* R3 author override (issue #46, 2026-09-24)                                  */
/* -------------------------------------------------------------------------- */

test("deriveRubricVerdict: R3 with author override + non-empty rationale → no finding", () => {
    // Issue #46 root cause: the author explicitly told the factory to
    // retain the brittle regex-based VP. The spec agent records this in
    // `product.authorOverrides` and the rubric must NOT raise a finding.
    const spec = makeSpec();
    spec.product.authorOverrides = [
        { requirementId: "VP-1", rationale: "Author has directed the spec to retain this regex-based static guard as-is." },
    ];
    const input = reviewRubricInputFromSpec(spec, undefined);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => (e.id === "R3-VP-1" ? noul("R3-VP-1", 0.15) : e));
    const out = deriveRubricVerdict(answer, input);
    // Override should swallow the R3 finding — the verdict passes.
    assert.equal(out.verdict, "pass");
    assert.equal(out.findings.length, 0);
    assert.equal(out.failedPoints.length, 0);
});

test("deriveRubricVerdict: R3 with EMPTY rationale override → still raises finding", () => {
    // Rationale must be non-empty. Bare overrides (no explanation) are
    // dropped by the parser; the rubric still demands a real reason.
    const spec = makeSpec();
    spec.product.authorOverrides = [{ requirementId: "VP-1", rationale: "   " }];
    const input = reviewRubricInputFromSpec(spec, undefined);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => (e.id === "R3-VP-1" ? noul("R3-VP-1", 0.15) : e));
    const out = deriveRubricVerdict(answer, input);
    assert.equal(out.verdict, "reject");
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].ruleId, "rubric-validation-not-runnable");
});

test("deriveRubricVerdict: R3 override only applies to R3, not R1/R4/R5/R6/R7", () => {
    // Defensive: the override must NOT silently relax other rubric
    // rules — those check different invariants.
    const spec = makeSpec();
    spec.product.authorOverrides = [
        { requirementId: "VP-1", rationale: "Author explicitly retains the validation item." },
        { requirementId: "AC-1", rationale: "Should not apply outside R3." },
        { requirementId: "NG-1", rationale: "Should not apply outside R3." },
    ];
    const input = reviewRubricInputFromSpec(spec, undefined);
    const answer = passingBatch(input);
    answer.entries = answer.entries.map((e) => {
        if (e.id === "R3-VP-1") return noul("R3-VP-1", 0.15);
        if (e.id === "R1-AC-1") return noul("R1-AC-1", 0.15);
        if (e.id === "R6-NG-1") return noul("R6-NG-1", 0.95);
        return e;
    });
    const out = deriveRubricVerdict(answer, input);
    // R1 + R6 should still produce findings despite the override.
    assert.equal(out.verdict, "reject");
    assert.ok(out.findings.some((f) => f.rule === "R1"));
    assert.ok(out.findings.some((f) => f.rule === "R6"));
    assert.equal(out.findings.find((f) => f.rule === "R3"), undefined);
});

/* -------------------------------------------------------------------------- */
/* Ratchet identity hash survival (issue #46, 2026-09-24)                      */
/* -------------------------------------------------------------------------- */

test("deriveRubricVerdict: ratchet key survives positional renumbering of identical content", () => {
    // Round 1: validation plan has VP-1 with text X.
    const spec1 = makeSpec();
    const input1 = reviewRubricInputFromSpec(spec1, undefined);
    const answer1 = passingBatch(input1);
    answer1.entries = answer1.entries.map((e) => (e.id === "R3-VP-1" ? noul("R3-VP-1", 0.15) : e));
    const out1 = deriveRubricVerdict(answer1, input1);
    const ratchetKey1 = out1.failedPoints[0];
    // Identity-only format: `R3-<hash>` (no positional prefix).
    assert.match(ratchetKey1, /^R3-[0-9a-f]{16}$/);

    // Round 2: spec agent's revision moves the SAME validation plan
    // item into a new position. The positional id changes (VP-2) but
    // the content hash must stay the same — the ratchet should keep
    // counting and escalate to needs-info.
    const spec2 = makeSpec();
    spec2.tech.validationPlan = ["grep the module CSS for legacy hex values"]; // identical text
    // Re-number to position 2 by injecting a no-op item before it.
    spec2.tech.validationPlan = ["placeholder VP at position 1", ...spec2.tech.validationPlan];
    const input2 = reviewRubricInputFromSpec(spec2, undefined);
    const answer2 = passingBatch(input2);
    answer2.entries = answer2.entries.map((e) => (e.id === "R3-VP-2" ? noul("R3-VP-2", 0.15) : e));
    const out2 = deriveRubricVerdict(answer2, input2);
    assert.equal(out2.failedPoints.length, 1);
    // Same content ⇒ same hash ⇒ same ratchet key.
    assert.equal(out2.failedPoints[0], ratchetKey1);

    // Findings carry the positional context for human reading, but
    // both findings share the same ratchet key.
    const findingId1 = out1.findings[0].pointId;
    const findingId2 = out2.findings[0].pointId;
    assert.match(findingId1, /^R3-VP-1-[0-9a-f]{16}$/);
    assert.match(findingId2, /^R3-VP-2-[0-9a-f]{16}$/);
    assert.notEqual(findingId1, findingId2);
});

/* -------------------------------------------------------------------------- */
/* deriveReviewVerdict — exploreBlockFloor (LLM exploration downweight)        */
/* -------------------------------------------------------------------------- */

function makeLlmReview(severity: "important" | "suggestion"): SpecReviewResult {
    return {
        verdict: severity === "important" ? "REJECT" : "APPROVE",
        body: "Found: 0 critical, 1 important, 0 suggestions, 0 nits.",
        comments: [],
        notes: "",
        findings: [
            {
                id: "llm-f-1",
                ruleId: "severity-important-0",
                severity,
                requirementIds: ["AC-1"],
                summary: "AC-6 accent chroma clause is qualitative",
                evidence: {},
                sourceStage: "review-spec",
                sourceRunId: "run-9",
                registeredAt: "2026-09-21T08:55:00Z",
                status: "open",
            },
        ],
    } as SpecReviewResult;
}

function b4b5(verdict: "APPROVE" | "REJECT", severity: "important", confidence: number): ReviewSpecTypesafeBatchAnswer {
    return {
        b4: { id: "B4", value: verdict, confidence: 0.9 },
        b5: [{ id: "B5-llm-f-1", findingId: "llm-f-1", value: severity, confidence }],
        meanConfidence: 0.9,
    };
}

test("exploreBlockFloor: low-confidence important is downgraded to suggestion (verdict can stay APPROVE)", () => {
    const review = makeLlmReview("important");
    review.verdict = "APPROVE"; // reviewer body flagged important but verdict said approve — B5 decides
    const out = deriveReviewVerdict(review, b4b5("APPROVE", "important", 0.7), { exploreBlockFloor: 0.9 });
    assert.equal(out.severityOverrides.get("llm-f-1"), "suggestion");
    assert.equal(out.verdict, "APPROVE");
    assert.ok(out.reasons.some((r) => r.includes("explore floor")));
});

test("exploreBlockFloor: high-confidence important keeps blocking power", () => {
    const review = makeLlmReview("important");
    const out = deriveReviewVerdict(review, b4b5("REJECT", "important", 0.98), { exploreBlockFloor: 0.9 });
    assert.equal(out.verdict, "REJECT");
    assert.equal(out.severityOverrides.has("llm-f-1"), false); // reviewer and B5 agree — no override
});

test("exploreBlockFloor: absent option preserves legacy behaviour exactly", () => {
    const review = makeLlmReview("important");
    review.verdict = "APPROVE";
    const legacy = deriveReviewVerdict(review, b4b5("APPROVE", "important", 0.7));
    assert.equal(legacy.severityOverrides.has("llm-f-1"), false);
    assert.ok(!legacy.reasons.some((r) => r.includes("explore floor")));
});

/* -------------------------------------------------------------------------- */
/* resolveExploreBlockFloor                                                    */
/* -------------------------------------------------------------------------- */

test("resolveExploreBlockFloor: default, disable, clamp, garbage", () => {
    assert.equal(resolveExploreBlockFloor({}), 0.9);
    assert.equal(resolveExploreBlockFloor({ FACTORY_REVIEW_EXPLORE_BLOCK_CONF: "" }), 0.9);
    assert.equal(resolveExploreBlockFloor({ FACTORY_REVIEW_EXPLORE_BLOCK_CONF: "0" }), undefined);
    assert.equal(resolveExploreBlockFloor({ FACTORY_REVIEW_EXPLORE_BLOCK_CONF: "off" }), undefined);
    assert.equal(resolveExploreBlockFloor({ FACTORY_REVIEW_EXPLORE_BLOCK_CONF: "0.75" }), 0.75);
    assert.equal(resolveExploreBlockFloor({ FACTORY_REVIEW_EXPLORE_BLOCK_CONF: "5" }), 1);
    assert.equal(resolveExploreBlockFloor({ FACTORY_REVIEW_EXPLORE_BLOCK_CONF: "-1" }), 0);
    assert.equal(resolveExploreBlockFloor({ FACTORY_REVIEW_EXPLORE_BLOCK_CONF: "garbage" }), 0.9);
    assert.ok(DEFAULT_RUBRIC_THRESHOLDS.noulMin === 0.5);
});

/* -------------------------------------------------------------------------- */
/* Ratchet escalation classification                                           */
/* -------------------------------------------------------------------------- */

test("SpecRubricRepeatedFailureError message routes deterministically to needs-info", () => {
    const error = new SpecRubricRepeatedFailureError(
        `Spec rubric convergence ratchet: judgment point(s) R1-AC-2, R7-PF-1 failed ${RUBRIC_RATCHET_LIMIT} consecutive review rounds despite targeted revision — needs-info: the spec agent could not resolve these structured rubric points, and another automated spec cycle would repeat the same defect. Author or operator input is required (answer the blocking questions, or relax/adjust the affected acceptance criteria).`,
    );
    const classified = classifyError(error);
    assert.equal(classified.class, "USER_INPUT_REQUIRED");
    assert.equal(classified.maxAttempts, 0);
    assert.equal(classified.defaultAction, "needs-info");
    assert.equal(classified.confident, true);
});
