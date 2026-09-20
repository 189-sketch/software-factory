/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T8.3 acceptance tests.
 *
 * Covers:
 *   1. The shipped `runtime/decisions.yaml` passes validation.
 *   2. `confidence_min > confidence_max` fails validation.
 *   3. Composite weights not summing to `1.0 ± 0.01` fail validation.
 *   4. Unknown actions fail validation.
 *   5. Unknown keys at any level fail validation.
 *   6. `computeHealth` returns the expected value for sample inputs.
 *   7. `healthBand` returns the correct band for each documented range.
 *
 * Plus a handful of supplementary checks so the tiny YAML parser,
 * the loader, and the pre-check all stay honest:
 *   - `loadDecisions()` reads the shipped file end-to-end.
 *   - `runDecisionsPreCheck()` throws an `Error` whose message starts
 *     with `Invalid decisions.yaml:` (same severity / log-key prefix
 *     shape as the F01 `load_skill` regression / `Invalid FACTORY_AGENT
 *     backend: ...` pre-checks in `runtime/agent-backends.mjs`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync as fsSyncExistsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    DEFAULT_DECISIONS_PATH,
    READ_ONLY_ACTIONS,
    loadDecisions,
    parseDecisionsYaml,
    runDecisionsPreCheck,
    validateDecisions,
} from "../core/decisions.js";
import {
    computeHealth,
    healthBand,
    primeDefaultWeights,
    __clearDefaultWeightsCacheForTest,
} from "../orchestrator/composite.js";

/* -------------------------------------------------------------------------- */
/* YAML parser sanity                                                        */
/* -------------------------------------------------------------------------- */

test("READ_ONLY_ACTIONS lists the five example rows from requirements.md", () => {
    assert.deepEqual(
        [...READ_ONLY_ACTIONS].sort(),
        ["freshness.skip", "operator.escalate", "review-pr.merge_pr", "supervisor.retry", "triage.apply_label"],
    );
});

test("parseDecisionsYaml handles the shipped schema end-to-end", () => {
    const parsed = parseDecisionsYaml(SAMPLE_YAML);
    assert.equal((parsed as { version: unknown }).version, 1);
    const decisions = (parsed as { decisions: unknown[] }).decisions;
    assert.equal(decisions.length, 5);
    const actions = decisions.map((d) => (d as { action: unknown }).action);
    assert.deepEqual(actions, [
        "freshness.skip",
        "triage.apply_label",
        "review-pr.merge_pr",
        "supervisor.retry",
        "operator.escalate",
    ]);
});

/* -------------------------------------------------------------------------- */
/* Validator                                                                  */
/* -------------------------------------------------------------------------- */

test("the shipped runtime/decisions.yaml passes validation", async () => {
    const decisions = await loadDecisions(DEFAULT_DECISIONS_PATH);
    const result = validateDecisions(decisions);
    assert.deepEqual(result, { ok: true }, `expected ok, got ${JSON.stringify(result)}`);
});

test("DEFAULT_DECISIONS_PATH is independent of process.cwd()", async () => {
    // Bug 3 regression: the orchestrator runs INSIDE the issue
    // worktree (a clone of the target repo, NOT the factory package
    // root). A path resolved against `process.cwd()` resolves against
    // the target repo, which doesn't ship `runtime/decisions.yaml`
    // and the orchestrator's startup pre-check crashed with
    // `Invalid decisions.yaml: ENOENT` on the first poll. The fix
    // resolves the path via `import.meta.url` (the module's own
    // location), so the path is stable regardless of where the
    // orchestrator is invoked from. Switch cwd to a tmp dir that
    // does NOT contain runtime/decisions.yaml and assert the path
    // STILL resolves to a real file.
    const originalCwd = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), "decisions-cwd-"));
    try {
        process.chdir(dir);
        assert.ok(
            fsSyncExistsSync(DEFAULT_DECISIONS_PATH),
            `DEFAULT_DECISIONS_PATH must resolve to a real file even when cwd=${dir}; got ${DEFAULT_DECISIONS_PATH}`,
        );
        const decisions = await loadDecisions(DEFAULT_DECISIONS_PATH);
        assert.equal(decisions.decisions.length, 5);
    } finally {
        process.chdir(originalCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runDecisionsPreCheck returns the parsed file on success and throws Invalid decisions.yaml on bad input", async () => {
    const good = await runDecisionsPreCheck(DEFAULT_DECISIONS_PATH);
    assert.equal(good.version, 1);
    assert.equal(good.decisions.length, 5);
    // The shipped file is the canonical happy path; we test the error
    // path with a fixture written to a temp directory.
    const dir = mkdtempSync(path.join(tmpdir(), "decisions-validate-"));
    try {
        const fixture = path.join(dir, "decisions.yaml");
        writeFileSync(fixture, SAMPLE_BAD_VERSION);
        await assert.rejects(
            () => runDecisionsPreCheck(fixture),
            /unsupported version/,
            "pre-check must surface schema violations with the Invalid decisions.yaml prefix",
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("confidence_min > confidence_max fails validation (rule 2)", () => {
    const parsed = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    const decisions = parsed.decisions as Array<Record<string, unknown>>;
    decisions[1].auto = { confidence_min: 0.95 };
    decisions[1].escalate = { confidence_max: 0.10, target: "needs-info" };
    const result = validateDecisions(parsed);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(
        result.errors.some((msg) => /confidence_min .* confidence_max/.test(msg)),
        `expected confidence_min > confidence_max error, got: ${result.errors.join("; ")}`,
    );
});

test("composite weights not summing to 1.0 ± 0.01 fail validation (rule 3)", () => {
    const parsed = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    parsed.composite = { spec: 0.5, impl: 0.5, review: 0.5, verify: 0.5 };
    const result = validateDecisions(parsed);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(
        result.errors.some((msg) => /composite weights sum to/.test(msg)),
        `expected composite-weights-sum error, got: ${result.errors.join("; ")}`,
    );
});

test("composite weights summing to 1.0 within ±0.01 pass validation (boundary)", () => {
    const parsed = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    parsed.composite = { spec: 0.3, impl: 0.2, review: 0.2, verify: 0.3 };
    const result = validateDecisions(parsed);
    assert.deepEqual(result, { ok: true });
});

test("unknown action fails validation (rule 1)", () => {
    const parsed = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    const decisions = parsed.decisions as Array<Record<string, unknown>>;
    decisions[0].action = "totally.bogus.action";
    const result = validateDecisions(parsed);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(
        result.errors.some((msg) => /not in READ_ONLY_ACTIONS/.test(msg)),
        `expected READ_ONLY_ACTIONS error, got: ${result.errors.join("; ")}`,
    );
});

test("unknown keys fail validation at every level (rule 4)", () => {
    // Tier-level unknown key
    const tierVariant = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    const decisions = tierVariant.decisions as Array<Record<string, unknown>>;
    decisions[0].auto = { noul_yes_max: 0.2, surprise: 42 };
    const tierResult = validateDecisions(tierVariant);
    assert.equal(tierResult.ok, false);
    if (!tierResult.ok) {
        assert.ok(tierResult.errors.some((msg) => /surprise/.test(msg)));
    }

    // Rule-level unknown key
    const ruleVariant = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    const decisions2 = ruleVariant.decisions as Array<Record<string, unknown>>;
    decisions2[0].mystery_key = { foo: "bar" };
    const ruleResult = validateDecisions(ruleVariant);
    assert.equal(ruleResult.ok, false);
    if (!ruleResult.ok) {
        assert.ok(ruleResult.errors.some((msg) => /mystery_key/.test(msg)));
    }

    // Top-level unknown key
    const topVariant = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    topVariant.mystery_top = { foo: "bar" };
    const topResult = validateDecisions(topVariant);
    assert.equal(topResult.ok, false);
    if (!topResult.ok) {
        assert.ok(topResult.errors.some((msg) => /mystery_top/.test(msg)));
    }

    // Composite-level unknown key
    const compVariant = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    (compVariant.composite as Record<string, unknown>).bogus_dim = 0.1;
    const compResult = validateDecisions(compVariant);
    assert.equal(compResult.ok, false);
    if (!compResult.ok) {
        assert.ok(compResult.errors.some((msg) => /bogus_dim/.test(msg)));
    }

    // Fallback-level unknown key
    const fbVariant = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    (fbVariant.fallback as Record<string, unknown>).mystery_fb = "value";
    const fbResult = validateDecisions(fbVariant);
    assert.equal(fbResult.ok, false);
    if (!fbResult.ok) {
        assert.ok(fbResult.errors.some((msg) => /mystery_fb/.test(msg)));
    }

    // CJK-level unknown key
    const cjkParsed = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    const cjkObj = ((cjkParsed.fallback as Record<string, unknown>).cjk as Record<string, unknown>);
    cjkObj.mystery_cjk = true;
    const cjkResult = validateDecisions(cjkParsed);
    assert.equal(cjkResult.ok, false);
    if (!cjkResult.ok) {
        assert.ok(cjkResult.errors.some((msg) => /mystery_cjk/.test(msg)));
    }
});

test("duplicate action fails validation", () => {
    const parsed = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    const decisions = parsed.decisions as Array<Record<string, unknown>>;
    decisions[1].action = "freshness.skip";
    const result = validateDecisions(parsed);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.ok(result.errors.some((msg) => /duplicate action/.test(msg)));
    }
});

test("CJK condition of unknown kind fails validation", () => {
    const parsed = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    const conditions = ((parsed.fallback as Record<string, unknown>).cjk as Record<string, unknown>).conditions as unknown[];
    conditions.push("not_a_real_condition");
    const result = validateDecisions(parsed);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.ok(result.errors.some((msg) => /unknown condition/.test(msg)));
    }
});

test("confidence bounds outside [0, 1] fail validation", () => {
    const parsed = parseDecisionsYaml(SAMPLE_YAML) as Record<string, unknown>;
    const decisions = parsed.decisions as Array<Record<string, unknown>>;
    decisions[0].auto = { confidence_min: 1.5 };
    const result = validateDecisions(parsed);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.ok(result.errors.some((msg) => /confidence_min must be a number in \[0\.0, 1\.0\]/.test(msg)));
    }
});

test("validateDecisions rejects non-object top-level", () => {
    const result = validateDecisions("not an object");
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.ok(result.errors.some((msg) => /top-level must be a YAML mapping/.test(msg)));
    }
});

test("runDecisionsPreCheck throws with the F01-style Invalid decisions.yaml prefix on schema violation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "decisions-precheck-"));
    try {
        const fixture = path.join(dir, "decisions.yaml");
        writeFileSync(fixture, SAMPLE_UNKNOWN_ACTION);
        await assert.rejects(
            () => runDecisionsPreCheck(fixture),
            (err: Error) => err.message.startsWith("Invalid decisions.yaml: "),
            "pre-check failure must use the Invalid decisions.yaml: prefix (same severity / shape as F01)",
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runDecisionsPreCheck throws with the F01-style Invalid decisions.yaml prefix on missing file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "decisions-missing-"));
    try {
        const fixture = path.join(dir, "decisions.yaml");
        await assert.rejects(
            () => runDecisionsPreCheck(fixture),
            (err: Error) => err.message.startsWith("Invalid decisions.yaml: "),
            "missing-file pre-check failure must use the same Invalid decisions.yaml: prefix",
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* Composite formula + health band                                            */
/* -------------------------------------------------------------------------- */

test("computeHealth returns the weighted sum clamped to [0, 1]", () => {
    __clearDefaultWeightsCacheForTest();
    primeDefaultWeights(parseDecisionsYaml(SAMPLE_YAML) as Awaited<ReturnType<typeof loadDecisions>>);
    // All dimensions at 1.0 → health = 1.0
    assert.equal(computeHealth({ spec: 1, impl: 1, review: 1, verify: 1 }), 1);
    // All dimensions at 0.0 → health = 0.0
    assert.equal(computeHealth({ spec: 0, impl: 0, review: 0, verify: 0 }), 0);
    // Half on each dimension with default weights
    // 0.30·0.5 + 0.25·0.5 + 0.20·0.5 + 0.25·0.5 = 0.5
    assert.equal(computeHealth({ spec: 0.5, impl: 0.5, review: 0.5, verify: 0.5 }), 0.5);
    // Skewed: spec=1.0, others 0.0 → 0.30
    assert.equal(computeHealth({ spec: 1, impl: 0, review: 0, verify: 0 }), 0.3);
    // Skewed: verify=1.0, others 0.0 → 0.25
    assert.equal(computeHealth({ spec: 0, impl: 0, review: 0, verify: 1 }), 0.25);
});

test("computeHealth honours explicit weight overrides", () => {
    const weights = { spec: 0.5, impl: 0.5, review: 0, verify: 0 };
    // spec=1, impl=0 → 0.5
    assert.equal(computeHealth({ spec: 1, impl: 0, review: 0, verify: 0 }, weights), 0.5);
    // spec=0, impl=1 → 0.5
    assert.equal(computeHealth({ spec: 0, impl: 1, review: 0, verify: 0 }, weights), 0.5);
    // Custom weights that sum to 2.0 (out of contract) are normalised:
    // spec=1, impl=0 → 0.5
    const heavyWeights = { spec: 2, impl: 2, review: 0, verify: 0 };
    assert.equal(computeHealth({ spec: 1, impl: 0, review: 0, verify: 0 }, heavyWeights), 0.5);
});

test("computeHealth clamps out-of-range scores", () => {
    primeDefaultWeights(parseDecisionsYaml(SAMPLE_YAML) as Awaited<ReturnType<typeof loadDecisions>>);
    // Negative scores clamp to 0.
    assert.equal(computeHealth({ spec: -0.5, impl: -0.5, review: -0.5, verify: -0.5 }), 0);
    // Scores > 1 clamp to 1.
    assert.equal(computeHealth({ spec: 1.5, impl: 1.5, review: 1.5, verify: 1.5 }), 1);
});

test("computeHealth throws when the default weights are not loaded and no override is passed", () => {
    __clearDefaultWeightsCacheForTest();
    assert.throws(
        () => computeHealth({ spec: 1, impl: 1, review: 1, verify: 1 }),
        /default weights not loaded/,
    );
});

test("computeHealth throws on missing or non-finite scores", () => {
    primeDefaultWeights(parseDecisionsYaml(SAMPLE_YAML) as Awaited<ReturnType<typeof loadDecisions>>);
    assert.throws(
        () => computeHealth({ spec: NaN, impl: 0, review: 0, verify: 0 }),
        /score for "spec"/,
    );
    // Missing dimension throws
    assert.throws(
        // @ts-expect-error: intentionally omit `verify`
        () => computeHealth({ spec: 0.5, impl: 0.5, review: 0.5 }),
        /score for "verify"/,
    );
});

test("healthBand returns the documented band for every documented range", () => {
    // alert: < 0.5
    assert.equal(healthBand(0), "alert");
    assert.equal(healthBand(0.25), "alert");
    assert.equal(healthBand(0.49), "alert");
    // banner: [0.5, 0.7]
    assert.equal(healthBand(0.5), "banner");
    assert.equal(healthBand(0.6), "banner");
    assert.equal(healthBand(0.7), "banner");
    // log_only: > 0.7
    assert.equal(healthBand(0.71), "log_only");
    assert.equal(healthBand(0.9), "log_only");
    assert.equal(healthBand(1), "log_only");
});

test("healthBand throws on non-finite input", () => {
    assert.throws(() => healthBand(NaN), /finite number/);
    assert.throws(() => healthBand(Infinity), /finite number/);
    assert.throws(() => healthBand("not a number" as unknown as number), /finite number/);
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Canonical sample mirroring `runtime/decisions.yaml` so each test
 * edits an in-memory clone rather than the shipped file on disk.
 * Kept in sync with `specs/2026-09-20-decision-architecture/requirements.md`
 * §"`decisions.yaml` Schema" (lines 306-358).
 */
const SAMPLE_YAML = `version: 1

decisions:
  - action: freshness.skip
    auto:     { noul_yes_max: 0.20 }
    escalate: { noul_yes_min: 0.20, target: full_triage_batch }

  - action: triage.apply_label
    auto:     { confidence_min: 0.85 }
    confirm:  { confidence_min: 0.50, prompt: "Triage suggests: <state>. Apply?" }
    escalate: { confidence_max: 0.50, target: needs-info }

  - action: review-pr.merge_pr
    auto:     { confidence_min: 0.90, blocking_findings_max: 0 }
    confirm:  { confidence_min: 0.65, prompt: "PR <n> has <k> blocking. Merge?" }
    escalate: { confidence_max: 0.65, target: human }

  - action: supervisor.retry
    auto:     { confidence_min: 0.85, retryable_class_only: true }
    escalate: { confidence_max: 0.85, target: needs-info }

  - action: operator.escalate
    auto:     { confidence_min: 0.95, channel: pager }
    confirm:  { confidence_min: 0.70, channel: dashboard_banner }
    escalate: { confidence_max: 0.70, target: log_only }

composite:
  spec:     0.30
  impl:     0.25
  review:   0.20
  verify:   0.25

fallback:
  cjk:
    trigger: any_of
    conditions:
      - typesafe_unreachable
      - typesafe_confidence_below: { action: triage.apply_label, threshold: 0.85 }
      - typesafe_status_5xx
    fallback_backend: claude-code
    log_warning: typesafe_fallback_to_claude
`;

/** Sample with an unsupported version (rule: top-level version check). */
const SAMPLE_BAD_VERSION = `version: 2

decisions:
  - action: freshness.skip
    auto: { noul_yes_max: 0.20 }

composite:
  spec:     0.30
  impl:     0.25
  review:   0.20
  verify:   0.25

fallback:
  cjk:
    trigger: any_of
    conditions:
      - typesafe_unreachable
    fallback_backend: claude-code
    log_warning: typesafe_fallback_to_claude
`;

/** Sample with an unknown action so the pre-check exercises the Invalid decisions.yaml prefix. */
const SAMPLE_UNKNOWN_ACTION = `version: 1

decisions:
  - action: not.a.known.action
    auto: { noul_yes_max: 0.20 }

composite:
  spec:     0.30
  impl:     0.25
  review:   0.20
  verify:   0.25

fallback:
  cjk:
    trigger: any_of
    conditions:
      - typesafe_unreachable
    fallback_backend: claude-code
    log_warning: typesafe_fallback_to_claude
`;