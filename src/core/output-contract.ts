/**
 * Output contracts: the single source of truth for what an agent must
 * return, expressed so that BOTH the model and the parser read the same
 * definition.
 *
 * ## Why this module exists
 *
 * The factory previously encoded output requirements in two places that
 * could not see each other:
 *
 *   1. Prose scattered through each agent's `userPrompt`.
 *   2. Hard `throw` statements inside each agent's inline `parse` closure.
 *
 * Nothing kept them in sync. The result was *invisible contracts* — rules
 * the parser enforced but the prompt never stated. The canonical failure:
 * the spec agent's parser required every `acceptanceCriteria` entry to
 * appear verbatim inside `body`, while the prompt never mentioned it. The
 * model could not comply, the corrective retry only re-asserted the JSON
 * *shape* (which was never wrong), and the pipeline hard-failed on every
 * attempt.
 *
 * A contract fixes this by construction:
 *
 *   - `requirements` is rendered into the **system prompt**, so the model
 *     sees every rule before it answers rather than after it fails.
 *   - `example` is a complete, realistic response that is asserted — by
 *     `output-contract.test.ts` — to pass the agent's own parser.
 *
 * That assertion is the anti-drift mechanism. If someone tightens a
 * parser without updating the contract, or writes an example the parser
 * rejects, the test fails at build time instead of at 3am in production.
 *
 * ## Prompt-cache safety
 *
 * Rendered output is a pure function of the contract literal, so it is
 * byte-stable across attempts. It belongs in `systemPrompt` (see the
 * layering contract in `core/llm-agent.ts`) and never in a dynamic turn.
 */

export interface OutputContract {
  /**
   * Per-field rules stated in plain language, one per line.
   *
   * Write these as instructions to the model, not as descriptions of the
   * parser. Every rule the pipeline actually depends on must appear here
   * — if a rule is worth relying on, it is worth telling the model.
   */
  requirements: string[];
  /**
   * A complete, valid response. Not a type sketch: real values, realistic
   * length, every required field populated.
   *
   * This value is fed through the agent's parser in the contract test, so
   * it doubles as executable documentation of the shape.
   */
  example: unknown;
}

/**
 * Render a contract as the `## Output format` section of a system prompt.
 *
 * Deterministic: same contract in, byte-identical string out. Two-space
 * JSON indentation keeps the example readable without inflating tokens
 * the way four-space would.
 */
export function renderOutputContract(contract: OutputContract): string {
  const lines = [
    "## Output format",
    "",
    "Return ONLY one JSON object. No prose before or after it, no markdown code fences, no explanation.",
    "",
    "Requirements:",
    ...contract.requirements.map((requirement) => `- ${requirement}`),
    "",
    "A valid response looks exactly like this:",
    "",
    JSON.stringify(contract.example, null, 2),
  ];
  return lines.join("\n");
}

/**
 * Compact single-line shape used by the corrective retry in
 * `core/llm-agent.ts`.
 *
 * Derived from the same `example` the system prompt showed, so the retry
 * can never contradict the original instruction — the previous
 * hand-written `jsonShapeHint` literals could, and did, drift.
 */
export function contractShapeHint(contract: OutputContract): string {
  return JSON.stringify(contract.example);
}
