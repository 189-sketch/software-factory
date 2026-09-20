/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T10.1.
 *
 * Unit tests for `runtime/decisions-loader.mjs` — the plain-JS port of
 * the `src/core/decisions.ts` parser/validator used by the panel API's
 * `GET /api/decisions` route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    DEFAULT_DECISIONS_PATH,
    loadDecisionsJson,
    parseDecisionsYaml,
    validateDecisions,
} from "../runtime/decisions-loader.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shippedYaml = path.join(repoRoot, "runtime", "decisions.yaml");

async function withTempFile(contents, fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "decisions-loader-"));
    const file = path.join(dir, "decisions.yaml");
    await fs.writeFile(file, contents, "utf-8");
    try {
        return await fn(file);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

test("default path resolves to the shipped runtime/decisions.yaml", () => {
    assert.equal(DEFAULT_DECISIONS_PATH, shippedYaml);
});

test("parses the shipped runtime/decisions.yaml to the expected JSON shape", async () => {
    const parsed = await loadDecisionsJson(shippedYaml);

    assert.equal(parsed.version, 1);
    assert.ok(Array.isArray(parsed.decisions));
    assert.equal(parsed.decisions.length, 5);
    assert.deepEqual(
        parsed.decisions.map((d) => d.action),
        [
            "freshness.skip",
            "triage.apply_label",
            "review-pr.merge_pr",
            "supervisor.retry",
            "operator.escalate",
        ],
    );

    // freshness.skip — Noul thresholds, no confirm tier.
    const freshness = parsed.decisions[0];
    assert.deepEqual(freshness.auto, { noul_yes_max: 0.2 });
    assert.deepEqual(freshness.escalate, { noul_yes_min: 0.2, target: "full_triage_batch" });
    assert.equal(freshness.confirm, undefined);

    // review-pr.merge_pr — numeric + integer thresholds and a quoted prompt.
    const merge = parsed.decisions[2];
    assert.deepEqual(merge.auto, { confidence_min: 0.9, blocking_findings_max: 0 });
    assert.equal(merge.confirm.confidence_min, 0.65);
    assert.equal(merge.confirm.prompt, "PR <n> has <k> blocking. Merge?");
    assert.deepEqual(merge.escalate, { confidence_max: 0.65, target: "human" });

    // supervisor.retry — boolean threshold.
    const retry = parsed.decisions[3];
    assert.deepEqual(retry.auto, { confidence_min: 0.85, retryable_class_only: true });

    // operator.escalate — channel keys.
    const operator = parsed.decisions[4];
    assert.equal(operator.auto.channel, "pager");
    assert.equal(operator.confirm.channel, "dashboard_banner");
    assert.equal(operator.escalate.target, "log_only");

    // Composite weights.
    assert.deepEqual(parsed.composite, { spec: 0.3, impl: 0.25, review: 0.2, verify: 0.25 });
    const sum = Object.values(parsed.composite).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) <= 0.01, `composite sum ${sum} not within 1.0 ± 0.01`);

    // CJK fallback block.
    assert.equal(parsed.fallback.cjk.trigger, "any_of");
    assert.equal(parsed.fallback.cjk.fallback_backend, "claude-code");
    assert.equal(parsed.fallback.cjk.log_warning, "typesafe_fallback_to_claude");
    assert.deepEqual(parsed.fallback.cjk.conditions, [
        "typesafe_unreachable",
        { typesafe_confidence_below: { action: "triage.apply_label", threshold: 0.85 } },
        "typesafe_status_5xx",
    ]);

    // JSON-serialisable (the panel API stringifies it directly).
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
});

test("loadDecisionsJson() with no argument loads the shipped file", async () => {
    const parsed = await loadDecisionsJson();
    assert.equal(parsed.version, 1);
    assert.equal(parsed.decisions.length, 5);
});

test("parse and validator agree with the TS reference on the shipped file", () => {
    const result = validateDecisions(parseDecisionsYaml("version: 1\n"));
    assert.equal(result.ok, false, "version-only file must fail validation");
    assert.ok(result.errors.some((e) => e.includes("`decisions` must be a list")));
});

test("malformed YAML rejects with a clear Invalid decisions.yaml error", async () => {
    await withTempFile(
        "version: 1\nthis line has no colon\n",
        async (file) => {
            await assert.rejects(
                () => loadDecisionsJson(file),
                (err) => {
                    assert.ok(err instanceof Error);
                    assert.match(err.message, /^Invalid decisions\.yaml:/);
                    assert.match(err.message, /expected "key: value"/);
                    return true;
                },
            );
        },
    );
});

test("empty file rejects with a clear error", async () => {
    await withTempFile("# only a comment\n", async (file) => {
        await assert.rejects(
            () => loadDecisionsJson(file),
            /Invalid decisions\.yaml: decisions\.yaml is empty/,
        );
    });
});

test("missing file rejects with a clear error, no throw-through", async () => {
    const missing = path.join(os.tmpdir(), "decisions-loader-missing-404.yaml");
    await assert.rejects(
        () => loadDecisionsJson(missing),
        (err) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /^Invalid decisions\.yaml: cannot read /);
            return true;
        },
    );
});

test("schema violations reject: unknown action", async () => {
    await withTempFile(
        [
            "version: 1",
            "decisions:",
            "  - action: not.a.real.action",
            "    auto: { confidence_min: 0.9 }",
            "composite:",
            "  spec: 0.30",
            "  impl: 0.25",
            "  review: 0.20",
            "  verify: 0.25",
            "fallback:",
            "  cjk:",
            "    trigger: any_of",
            "    conditions: [ typesafe_unreachable ]",
            "    fallback_backend: claude-code",
            "    log_warning: typesafe_fallback_to_claude",
            "",
        ].join("\n"),
        async (file) => {
            await assert.rejects(
                () => loadDecisionsJson(file),
                /Invalid decisions\.yaml: .*not in READ_ONLY_ACTIONS/,
            );
        },
    );
});

test("schema violations reject: composite weights not summing to 1.0", async () => {
    await withTempFile(
        [
            "version: 1",
            "decisions: []",
            "composite:",
            "  spec: 0.90",
            "  impl: 0.90",
            "  review: 0.90",
            "  verify: 0.90",
            "fallback:",
            "  cjk:",
            "    trigger: any_of",
            "    conditions: [ typesafe_unreachable ]",
            "    fallback_backend: claude-code",
            "    log_warning: typesafe_fallback_to_claude",
            "",
        ].join("\n"),
        async (file) => {
            await assert.rejects(
                () => loadDecisionsJson(file),
                /Invalid decisions\.yaml: .*composite weights sum to/,
            );
        },
    );
});
