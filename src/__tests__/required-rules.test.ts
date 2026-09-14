/**
 * Required-rules coverage tests (M1, F10).
 *
 * Issue #20's review loop drifted because the canonical severity /
 * acceptance rubric was reachable only through the optional
 * `load_skill` tool — the model could (and did) skip it. The plan
 * calls for severity / acceptance / permission rubrics to be
 * pre-loaded and inlined into the system prompt, not pulled on
 * demand. These tests lock that contract.
 *
 *   - The required-rules map names a skill for every severity-bearing
 *     stage.
 *   - `loadRequiredRules` throws on a missing skill (no silent
 *     omission).
 *   - `renderRequiredRules` includes the hash so the orchestrator can
 *     attest to the rubric version it actually drove.
 *   - `composeSystemPrompt` inlines the required rules and removes
 *     them from the on-demand catalog so they aren't shown twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { composeSystemPrompt } from "../core/system-prompt.js";
import {
  loadRequiredRules,
  renderRequiredRules,
  requiredSkillsFor,
  type RequiredRule,
} from "../core/required-rules.js";
import type { OutputContract } from "../core/output-contract.js";
import type { SkillRef } from "../core/types.js";

function makeLoader(bodies: Record<string, { name: string; description: string; body: string }>) {
  return {
    async load(name: string) {
      const value = bodies[name];
      if (!value) throw new Error(`Skill '${name}' not found in test loader`);
      return value;
    },
  };
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

test("requiredSkillsFor names a rule for every severity-bearing stage", () => {
  // Stages that must enforce severity / acceptance / permission rules.
  // Each one missing would be a regression to F10.
  const expectedStages = [
    "spec",
    "review-spec",
    "review-pr",
    "verify-behavior",
    "implementation",
    "triage",
  ];
  for (const stage of expectedStages) {
    assert.ok(
      requiredSkillsFor[stage] && requiredSkillsFor[stage]!.length > 0,
      `requiredSkillsFor[${stage}] must declare at least one rubric`,
    );
  }
});

test("loadRequiredRules returns the declared rules in declaration order", async () => {
  const reviewSpec = {
    name: "review-spec",
    description: "Spec review rubric",
    body: "Severity: CRITICAL / IMPORTANT / SUGGESTION / NIT",
  };
  const loader = makeLoader({ "review-spec": reviewSpec });
  const result = await loadRequiredRules("review-spec", loader);
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0]?.name, "review-spec");
  assert.equal(result.rules[0]?.body, reviewSpec.body);
  assert.equal(result.rules[0]?.hash, hashOf(reviewSpec.body));
  assert.equal(result.hasRules, true);
});

test("loadRequiredRules hashes body content so the checkpoint can attest to rubric version", async () => {
  const loader = makeLoader({
    "review-pr": {
      name: "review-pr",
      description: "Code review rubric",
      body: "Block on [CRITICAL] only. Be lenient with [SUGGESTION].",
    },
  });
  const { rules } = await loadRequiredRules("review-pr", loader);
  const expected = createHash("sha256")
    .update("Block on [CRITICAL] only. Be lenient with [SUGGESTION].", "utf-8")
    .digest("hex");
  assert.equal(rules[0]?.hash, expected, "hash must be sha256 of the loaded body");
});

test("loadRequiredRules throws when a required skill is missing (F10 guard)", async () => {
  const loader = makeLoader({}); // empty: every required skill is missing
  await assert.rejects(
    () => loadRequiredRules("review-spec", loader),
    /Required rule "review-spec" for stage "review-spec" could not be loaded/,
  );
});

test("loadRequiredRules returns empty for stages without required rules", async () => {
  // `some-other-stage` is not in the map; the loader is irrelevant.
  const loader = makeLoader({});
  const result = await loadRequiredRules("some-other-stage", loader);
  assert.deepEqual(result.rules, []);
  assert.equal(result.hasRules, false);
});

test("renderRequiredRules includes the hash so the model can reference it", () => {
  const rules: RequiredRule[] = [
    {
      name: "review-spec",
      description: "Spec review rubric",
      body: "Severity rules here.",
      hash: "deadbeef",
    },
  ];
  const rendered = renderRequiredRules(rules);
  assert.match(rendered, /Required rule: `review-spec` \(sha256:deadbeef\)/);
  assert.match(rendered, /Severity rules here\./);
});

test("composeSystemPrompt inlines required rules and removes them from the catalog", () => {
  const contract: OutputContract = {
    requirements: ["verdict is APPROVE or REJECT"],
    example: { verdict: "APPROVE" },
  };
  const skills: SkillRef[] = [
    { name: "review-spec", description: "Spec review rubric" },
    { name: "implementation", description: "Implementation guidance" },
  ];
  const rules: RequiredRule[] = [
    {
      name: "review-spec",
      description: "Spec review rubric",
      body: "Inline severity rules.",
      hash: "abc123",
    },
  ];
  const prompt = composeSystemPrompt({
    role: "You are a reviewer.",
    skills,
    contract,
    requiredRules: rules,
  });
  // Required rule must appear inlined with its hash.
  assert.match(prompt, /Required rule: `review-spec` \(sha256:abc123\)/);
  assert.match(prompt, /Inline severity rules\./);
  // The catalog should still list `implementation` (not required) but
  // must NOT show `review-spec` again — that would suggest the rule
  // is still optional after the controller decided otherwise.
  assert.match(prompt, /- `implementation` — Implementation guidance/);
  assert.doesNotMatch(prompt, /- `review-spec` — Spec review rubric/);
});

test("composeSystemPrompt tolerates missing requiredRules for legacy callers", () => {
  const contract: OutputContract = { requirements: ["x"], example: { x: 1 } };
  const prompt = composeSystemPrompt({
    role: "role",
    skills: [{ name: "a", description: "b" }],
    contract,
  });
  // No required-rules block; the catalog shows every skill.
  assert.match(prompt, /- `a` — b/);
  assert.doesNotMatch(prompt, /Required rule:/);
});