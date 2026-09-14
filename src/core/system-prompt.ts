/**
 * System-prompt composition.
 *
 * Every agent's system prompt is assembled from exactly four parts, in
 * this order:
 *
 *   1. **Role** — who the agent is, what it may not do. Written by the
 *      agent module.
 *   2. **Required rules** — rubric bodies the controller pre-loaded
 *      before the run started (see `core/required-rules.ts`). Severity
 *      markers, acceptance-criteria review checks, and permission
 *      boundaries cannot be optional — if a future prompt omits them
 *      the orchestrator refuses to start the run.
 *   3. **Skill catalog** — the names and one-line descriptions of the
 *      supplementary skills the agent MAY pull on demand via the
 *      `load_skill` tool. Required rules are NOT in this catalog —
 *      they are already inlined in step 2.
 *   4. **Output contract** — the complete response format, including
 *      a worked example, from `core/output-contract.ts`.
 *
 * Composition happens in `runLlmAgent`, not in the agents, so part 4
 * can never be forgotten. That matters: the failure this design
 * replaces was an agent whose parser enforced a rule its prompt never
 * stated. Making the contract a required input to the LLM call turns
 * "state your output format" from a convention into a type error when
 * omitted.
 *
 * All four parts are static for a given agent (skill bodies are
 * content-hashed upstream), so the composed prompt is byte-stable
 * across turns and retries and stays prompt-cache friendly. Dynamic
 * content (prior attempts, corrections, approved artifacts) travels as
 * user turns instead — see `contextTurns` in `core/llm-agent.ts`.
 */
import { renderOutputContract, type OutputContract } from "./output-contract.js";
import type { RequiredRule } from "./required-rules.js";
import { renderRequiredRules } from "./required-rules.js";
import type { SkillRef } from "./types.js";

/**
 * Render the on-demand skill catalog.
 *
 * Only name + description. The bodies stay on disk until the agent asks
 * for one, which keeps the prompt's size independent of how much rubric
 * the repository happens to carry. Required rules are filtered out —
 * they have already been inlined into the system prompt by
 * `composeSystemPrompt`, and the catalog would only confuse the model
 * into thinking they were still optional.
 */
export function renderSkillCatalog(skills: SkillRef[], required: RequiredRule[] = []): string {
  const requiredNames = new Set(required.map((rule) => rule.name));
  const optional = skills.filter((skill) => !requiredNames.has(skill.name));
  if (!optional.length) return "";
  const lines = [
    "## Available skills",
    "",
    "Call the `load_skill` tool with one of these names to read its full guidance. Load a skill when you need its detail; do not guess at its contents.",
    "",
    ...optional.map((skill) => `- \`${skill.name}\` — ${skill.description || "(no description)"}`),
  ];
  return lines.join("\n");
}

/** Assemble role + required rules + skill catalog + output contract into one system prompt. */
export function composeSystemPrompt(parts: {
  role: string;
  skills: SkillRef[];
  contract: OutputContract;
  requiredRules?: RequiredRule[];
}): string {
  const required = parts.requiredRules ?? [];
  return [
    parts.role.trim(),
    renderRequiredRules(required),
    renderSkillCatalog(parts.skills, required),
    renderOutputContract(parts.contract),
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
}