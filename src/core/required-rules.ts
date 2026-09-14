/**
 * Required rules: rubric content the controller MUST inject into the
 * system prompt before an agent's first tool call.
 *
 * ## Why this module exists
 *
 * Issue #20's review loop failed repeatedly in part because the rubric
 * that defines severity levels and required-vs-suggestion semantics
 * was reachable only through the optional `load_skill` tool. The model
 * could (and did) skip loading it. The plan calls this out as F10:
 * "审查严重性规则、需求优先级和副作用权限不是可选材料" — the
 * canonical review rubric, the canonical spec rubric, and the
 * canonical review-pr rubric are required, not on-demand.
 *
 * This module:
 *   1. Declares the per-stage list of required skills.
 *   2. Loads every entry upfront; refuses to proceed on a missing
 *      skill (configuration failure, not a runtime guess).
 *   3. Hashes each loaded body so the orchestrator can record what
 *      version of the rubric actually drove the run.
 *   4. Returns a render-ready block that the system-prompt composer
 *      inlines verbatim — the model sees the rules on turn 1 instead
 *      of being trusted to fetch them.
 *
 * On-demand skills (anything not in `requiredSkillsFor`) continue to
 * flow through the `load_skill` tool — this split keeps the prompt
 * size bounded while making sure the rules the pipeline cannot
 * succeed without are never optional.
 */
import { createHash } from "node:crypto";
import type { SkillLoader } from "./skill.js";

/**
 * Names of the rubric skills that MUST be inlined into the system prompt
 * for each stage before the agent is allowed to run. The values are
 * taken from the existing `skills/<name>/SKILL.md` set; if the rubric
 * moves, this map must move with it.
 *
 * Stages listed here are exactly the ones the plan calls out as
 * carrying severity / acceptance / permission rules that are not
 * optional reference material.
 */
export const requiredSkillsFor: Readonly<Record<string, readonly string[]>> = {
  /** The spec agent's two sub-rubrics are both required for PRODUCT
   * and TECH halves; the wrapper `spec` rubric is a guidance hint and
   * stays optional. */
  spec: ["write-product-spec", "write-tech-spec"],
  /** The review-spec rubric defines severity markers and the
   * acceptance-criteria review checklist. Without it the model
   * invents severity conventions and the orchestrator cannot tell
   * "suggests renaming" from "blocks merging". */
  "review-spec": ["review-spec"],
  /** The review-pr rubric carries severity and verdict semantics for
   * code review comments. Same reasoning. */
  "review-pr": ["review-pr"],
  /** The verify-behavior rubric defines how to mark a behavior
   * verification PASS / FAIL and what evidence is required. */
  "verify-behavior": ["verify-behavior"],
  /** The implementation rubric carries the repo-edit and validation
   * contract (clean worktree, run_validation before claiming a test
   * passed, etc.). */
  implementation: ["implementation"],
  /** Triage carries the readiness decision contract. */
  triage: ["triage"],
};

export interface RequiredRule {
  /** Skill name as registered with the loader. */
  name: string;
  /** One-line description (frontmatter `description`). */
  description: string;
  /** Full body inlined into the system prompt. */
  body: string;
  /** SHA-256 hex digest of `body`. Recorded for auditability so the
   * checkpoint can attest to which rubric version drove the run. */
  hash: string;
}

export interface RequiredRulesLoadResult {
  /** Loaded rules in the order declared by `requiredSkillsFor`. */
  rules: RequiredRule[];
  /** True when the stage has at least one required rule. Stages
   * without required rules still resolve cleanly (empty array). */
  hasRules: boolean;
}

/**
 * Load every required rule for `stage` and return them in declaration
 * order. Throws on the first missing or unloadable skill — the
 * controller must surface that as a configuration failure, NOT fall
 * through and let the agent run without the rubric.
 *
 * @param stage  Stage identifier (matches keys of `requiredSkillsFor`).
 * @param loader Skill loader whose root contains the rubric files.
 */
export async function loadRequiredRules(
  stage: string,
  loader: Pick<SkillLoader, "load">,
): Promise<RequiredRulesLoadResult> {
  const names = requiredSkillsFor[stage];
  if (!names || names.length === 0) return { rules: [], hasRules: false };

  const rules: RequiredRule[] = [];
  for (const name of names) {
    let loaded;
    try {
      loaded = await loader.load(name);
    } catch (error) {
      throw new Error(
        `Required rule "${name}" for stage "${stage}" could not be loaded: ${String((error as Error).message ?? error)}`,
      );
    }
    rules.push({
      name: loaded.name,
      description: loaded.description,
      body: loaded.body,
      hash: sha256(loaded.body),
    });
  }
  return { rules, hasRules: true };
}

/**
 * Render the loaded rules as a deterministic system-prompt section.
 * Each rule becomes one fenced block with its name, hash, and body so
 * the model can reference a rule by name in its output and the
 * orchestrator can verify what was actually injected.
 */
export function renderRequiredRules(rules: RequiredRule[]): string {
  if (rules.length === 0) return "";
  const blocks: string[] = [];
  for (const rule of rules) {
    blocks.push([
      "## Required rule: `" + rule.name + "` (sha256:" + rule.hash + ")",
      "",
      rule.description ? rule.description : "",
      "",
      rule.body.trim(),
    ].filter((line) => line !== "").join("\n"));
  }
  return blocks.join("\n\n");
}

/** Hash helper: hex SHA-256 over the UTF-8 bytes of the body. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}