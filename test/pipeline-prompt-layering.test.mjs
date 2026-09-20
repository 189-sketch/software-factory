/**
 * Contract tests for the prompt-layering discipline.
 *
 * Every agent must keep three context classes strictly separate so the
 * provider prompt cache survives retries and attempts:
 *
 *   1. systemPrompt — immutable role definition. The skill catalog
 *      (name + description) and the output contract are appended by
 *      `composeSystemPrompt` in `core/system-prompt.ts` — agents do NOT
 *      interpolate them themselves.
 *   2. userPrompt (turn 1) — the task definition: issue identity +
 *      stable task framing. Stable for a given issue across attempts.
 *   3. contextTurns / tool results — attempt-specific dynamic context
 *      (prior diffs, revision feedback, approved artifacts, triage-
 *      authored corrections), appended as follow-up user turns.
 *
 * Skill bodies are NO LONGER concatenated into the system prompt. The
 * agent sees only `name + description` and fetches the body via the
 * `load_skill` tool when (and if) it actually needs the rubric.
 *
 * The regressions these tests prevent:
 *   - agents inlining dynamic revision payloads into turn 1 instead of
 *     follow-up turns;
 *   - agents inlining skill bodies into the systemPrompt, blowing up
 *     prompt size and busting the cache.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

test("runLlmAgent supports multi-turn user context via contextTurns", async () => {
  const source = await readFile(
    path.join(root, "src/core/llm-agent.ts"),
    "utf8",
  );
  assert.ok(
    /contextTurns\?:\s*string\[\]/.test(source),
    "LlmAgentOpts no longer declares contextTurns",
  );
  assert.ok(
    /for \(const turn of (opts\.contextTurns|resolveContextTurns\(opts\))/.test(source),
    "runLlmAgent no longer iterates contextTurns as follow-up prompts",
  );
});

test("systemPrompt composition is centralized in core/system-prompt.ts", async () => {
  // Every agent must use the centralized composeSystemPrompt helper
  // (in core/llm-agent.ts's runHarness) rather than concatenating
  // skill + contract + role into the systemPrompt literal itself.
  // Static check: no agent source file should still reference skillBody
  // or inlined skill markdown.
  for (const file of [
    "src/agents/spec.ts",
    "src/agents/triage.ts",
    "src/agents/implementation.ts",
    "src/agents/review-pr.ts",
    "src/agents/review-spec.ts",
    "src/agents/verify-behavior.ts",
    "src/agents/improve-review-pr.ts",
  ]) {
    const source = await readFile(path.join(root, file), "utf8");
    assert.equal(
      /skillBody/.test(source),
      false,
      `${file} still references ctx.skillBody; the new model loads skill bodies on demand via the load_skill tool`,
    );
  }
  const llmAgent = await readFile(path.join(root, "src/core/llm-agent.ts"), "utf8");
  assert.ok(/composeSystemPrompt\(/.test(llmAgent), "runHarness no longer composes the system prompt");
});

test("implementation agent delivers prior-attempt context as a follow-up turn", async () => {
  const source = await readFile(
    path.join(root, "src/agents/implementation.ts"),
    "utf8",
  );
  assert.ok(
    /contextTurns:\s*priorBlock/.test(source),
    "implementation agent no longer routes priorBlock through contextTurns",
  );
  // Turn 1 must not embed the prior-attempt block.
  const userPromptMatch = source.match(/userPrompt: `Implement issue[\s\S]*?`,/);
  assert.ok(userPromptMatch, "implementation userPrompt not found");
  assert.equal(
    userPromptMatch[0].includes("priorBlock"),
    false,
    "implementation turn 1 embeds priorBlock; keep turn 1 stable across attempts",
  );
});

test("spec agent delivers revision feedback as follow-up turns", async () => {
  const source = await readFile(
    path.join(root, "src/agents/spec.ts"),
    "utf8",
  );
  // Both the product and tech calls must route revision prompts through
  // contextTurns rather than inlining them into turn 1.
  const contextTurnUses = source.match(/contextTurns:/g) ?? [];
  assert.ok(
    contextTurnUses.length >= 2,
    `expected contextTurns on both spec phases, found ${contextTurnUses.length}`,
  );
  assert.ok(
    /contextTurns:\s*this\.revision\s*\?\s*\[formatSpecRevisionPrompt\(this\.revision,\s*"product"\)\]/.test(source),
    "product phase no longer routes the revision prompt through contextTurns",
  );
  assert.ok(
    /formatSpecRevisionPrompt\(this\.revision,\s*"tech"\)/.test(source),
    "tech phase no longer routes the revision prompt through contextTurns",
  );
  // Turn 1 of the tech phase must not embed the dynamic product body.
  const techPromptMatch = source.match(/userPrompt: `Write the technical spec[\s\S]*?`,/);
  assert.ok(techPromptMatch, "tech userPrompt not found");
  assert.equal(
    techPromptMatch[0].includes("productResult.product.body"),
    false,
    "tech turn 1 embeds the approved product body; deliver it as a context turn",
  );
});

test("every agent declares an output contract (system-prompt rendering source of truth)", async () => {
  // Every runLlmAgent call site must pass an outputContract. This is the
  // typing enforcement of "the contract must appear in the system prompt"
  // — runLlmAgent requires the field, so omitting it is a type error, not
  // a style error.
  for (const file of [
    "src/agents/spec.ts",
    "src/agents/triage.ts",
    "src/agents/implementation.ts",
    "src/agents/review-pr.ts",
    "src/agents/review-spec.ts",
    "src/agents/verify-behavior.ts",
    "src/agents/improve-review-pr.ts",
  ]) {
    const source = await readFile(path.join(root, file), "utf8");
    const llmCalls = source.match(/runLlmAgent[\s\S]*?\n\s*\}\)/g) ?? [];
    assert.ok(llmCalls.length > 0, `${file}: no runLlmAgent calls found`);
    for (const call of llmCalls) {
      assert.ok(
        /outputContract:/.test(call),
        `${file}: a runLlmAgent call is missing outputContract — every agent must declare its response shape`,
      );
    }
  }
});
