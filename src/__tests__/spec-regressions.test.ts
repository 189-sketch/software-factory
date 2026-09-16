import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveTechBody,
  formatSpecRevisionPrompt,
  specBodiesChanged,
} from "../agents/spec.js";
import {
  ALL_FACTORY_LABELS,
  FACTORY_LABELS_TO_CLEAR,
  RETIRED_FACTORY_LABELS,
  type SpecPair,
} from "../core/types.js";

test("complete TECH.md bodies are preserved verbatim", () => {
  const body = [
    "# Tech Spec",
    "",
    "## Approach",
    "",
    "Use the repository's existing TypeScript stack.",
    "",
    "## Validation plan",
    "",
    "- Run the focused unit suite.",
  ].join("\n");

  // resolveTechBody is the new name for what used to be finalizeTechBody:
  // it no longer rewrites or asserts on sections, it returns the LLM-authored
  // body as-is when present. Test that the contract holds.
  const result = resolveTechBody({
    approach: "Use TypeScript and preserve the existing architecture.",
    affectedAreas: ["src/app.ts"],
    dataModel: "No changes.",
    apiChanges: [],
    migrationPlan: "No migration.",
    validationPlan: ["Execute npm test for the affected package."],
    alternatives: [],
    openQuestions: [],
    body,
  });

  assert.equal(result, body);
});

test("missing TECH.md body is synthesized from structured fields", () => {
  // When the LLM emits no body (token budget exhausted mid-stream) the
  // synthesized markdown is what downstream review and validate-changes-
  // match-specs will inspect. Triage judges whether this is acceptable
  // for the issue — code no longer blocks on it.
  const result = resolveTechBody({
    approach: "Use TypeScript.",
    affectedAreas: [],
    dataModel: "No changes.",
    apiChanges: [],
    migrationPlan: "No migration.",
    validationPlan: ["npm test"],
    alternatives: [],
    openQuestions: [],
    body: "",
  });

  assert.match(result, /## Approach/);
  assert.match(result, /Use TypeScript\./);
  assert.match(result, /## Validation plan/);
  assert.match(result, /npm test/);
});

test("TECH.md with duplicate canonical sections is NOT rejected by the parser", () => {
  // The previous finalizeTechBody threw on duplicate sections. That kind
  // of structural judgment now belongs to triage — the parser is a
  // transport layer and must not block publication over formatting.
  assert.doesNotThrow(() => resolveTechBody({
    approach: "Use TypeScript.",
    affectedAreas: [],
    dataModel: "No changes.",
    apiChanges: [],
    migrationPlan: "No migration.",
    validationPlan: ["npm test"],
    alternatives: [],
    openQuestions: [],
    body: [
      "## Approach",
      "First.",
      "## Approach",
      "Second.",
      "## Validation plan",
      "- npm test",
      "## Validation plan",
      "- npm test",
    ].join("\n"),
  }));
});

test("spec revision prompt explicitly carries the rejected files and review", () => {
  const prompt = formatSpecRevisionPrompt({
    feedback: "CRITICAL: remove the duplicate Validation plan.",
    previousProductBody: "# Previous PRODUCT",
    previousTechBody: "# Previous TECH",
  }, "product");

  assert.match(prompt, /revise the previous PRODUCT\.md/i);
  assert.match(prompt, /CRITICAL: remove the duplicate Validation plan/);
  assert.match(prompt, /# Previous PRODUCT/);
  assert.doesNotMatch(prompt, /# Previous TECH/);
});

test("a rejected spec cannot be resubmitted without material file changes", () => {
  const previous = makeSpec("same product", "same tech");
  assert.equal(specBodiesChanged(previous, makeSpec("same product", "same tech")), false);
  assert.equal(specBodiesChanged(previous, makeSpec("revised product", "same tech")), true);
  assert.equal(specBodiesChanged(previous, makeSpec("same product", "revised tech")), true);
});

test("retired lifecycle labels remain cleanup-only", () => {
  assert.deepEqual(RETIRED_FACTORY_LABELS, ["spec-ready-for-review"]);
  assert.equal(ALL_FACTORY_LABELS.includes("spec-ready-for-review" as never), false);
  assert.equal(FACTORY_LABELS_TO_CLEAR.includes("spec-ready-for-review"), true);
});

function makeSpec(productBody: string, techBody: string): SpecPair {
  return {
    product: {
      slug: "issue-1-test",
      title: "Test",
      problem: "Test",
      goals: ["Test"],
      nonGoals: [],
      stories: [{ id: "US-1", title: "Test", asA: "user", iWant: "test", soThat: "works", checks: ["passes"] }],
      acceptanceCriteria: ["passes"],
      openQuestions: [],
      body: productBody,
    },
    tech: {
      slug: "issue-1-test",
      approach: "Test",
      affectedAreas: [],
      dataModel: "None",
      apiChanges: [],
      migrationPlan: "None",
      validationPlan: ["npm test"],
      alternatives: [],
      openQuestions: [],
      body: techBody,
    },
    specBranch: "spec/issue-1-test",
    specPrUrl: "",
  };
}
