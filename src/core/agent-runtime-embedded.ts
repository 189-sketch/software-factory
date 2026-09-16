/**
 * Embedded backend adapter (Slice A.2 / Group 2).
 *
 * Drives `HarnessLlmEngine` for the `embedded` backend selection so
 * the existing six-agent pipeline can route through
 * `AgentRuntime.runStage` without losing tool handling, session
 * continuity, or compaction.
 *
 * What this adapter owns:
 *   - Constructing the engine from `ctx` + `StageRunRequest`.
 *   - Sending the user prompt(s) and pulling the lane's final text.
 *   - Translating `HarnessLlmEngine` errors into the documented
 *     `StageRunStatus` union (succeeded / failed / interrupted /
 *     cancelled / format-error).
 *   - Surfacing the engine's log tail and abort reason verbatim in
 *     `StageRunResult.logTail` so the panel read-model keeps working.
 *
 * What this adapter does NOT own (still in `runLlmAgent`):
 *   - System prompt composition with required rules and the output
 *     contract (the orchestrator already composes that).
 *   - Output parsing and the one-shot corrective retry on parse miss.
 *   - Tool catalog assembly beyond the factory-default set.
 *
 * The split is deliberate: parsing/contract validation is the agent
 * layer's job (it is what gives a typed result), while the runtime is
 * a backend-agnostic execution surface that returns raw output text.
 */
import type { AgentContext } from "./types.js";
import type {
  StageRunRequest,
  StageRunResult,
} from "./agent-runtime.js";
import type { ResolvedBackend } from "./agent-runtime.js";

/**
 * Run the embedded backend for a stage request.
 *
 * Returns a `StageRunResult` whose `output` is the latest assistant
 * text from the lane and whose `status` reflects whether the run
 * settled, was cancelled, or failed.
 *
 * Token usage and warnings are emitted when the engine exposes them
 * (the harness usage event lands via the harness event bus; for this
 * slice we surface what the engine reports in `diagnostics()`).
 */
export async function embeddedAdapter(
  request: StageRunRequest,
  ctx: AgentContext,
  resolved: ResolvedBackend,
): Promise<StageRunResult> {
  // Lazily import the harness module so the agent-runtime contract
  // does not pull pi-agent-core into a process that only uses CLI
  // backends. The harness module also lazy-imports pi-ai internally,
  // so the cost is paid only when an embedded run actually starts.
  const harness = await import("./harness.js");
  const { defaultTools } = await import("./tools.js");
  const { Type } = await import("@earendil-works/pi-ai");

  const { models, model } = await harness.buildHarnessModels();
  const session = await harness.getIssueSession(ctx);

  const engine = new harness.HarnessLlmEngine({
    ctx,
    laneName: request.role,
    systemPrompt: request.inputManifest.systemPrompt,
    // The factory default tool set is the contract the existing
    // pipeline uses; per-stage tool overrides are not surfaced in
    // `StageRunRequest` yet and can be added when an agent actually
    // needs them (Slice C in the follow-on roadmap).
    tools: [...defaultTools(ctx)],
    Type,
    models,
    model,
    session,
  });

  await engine.start();
  const abort = request.abortSignal;
  if (abort) {
    if (abort.aborted) {
      await engine.close().catch(() => {});
      return {
        status: "cancelled",
        output: "",
        usage: null,
        backend: "embedded",
        warnings: ["stage run aborted before prompt dispatch"],
        retryable: false,
      };
    }
    abort.addEventListener(
      "abort",
      () => {
        // Engine has its own turn-cap watchdog; we surface the cancel
        // by closing the lane so subsequent `finalText()` reflects
        // the truncated transcript.
        void engine.close().catch(() => {});
      },
      { once: true },
    );
  }

  try {
    await engine.prompt(request.inputManifest.userPrompt);
    for (const turn of request.inputManifest.contextTurns ?? []) {
      if (!turn || !turn.trim()) continue;
      await engine.prompt(turn);
    }
    const output = await engine.finalText();
    const diagnostics = await engine.diagnostics();
    return {
      status: abort?.aborted ? "cancelled" : "succeeded",
      output,
      usage: null,
      backend: "embedded",
      logTail: diagnostics,
      warnings: [],
      retryable: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: classifyError(message),
      output: "",
      usage: null,
      backend: "embedded",
      logTail: message,
      warnings: [message],
      retryable: classifyRetryable(message),
    };
  } finally {
    await engine.close().catch(() => {});
  }
}

/** Map a harness-level error message to a `StageRunStatus`.
 *
 * The harness surfaces three categories we care about:
 *   - `no assistant entries` → `format-error` (parse miss upstream)
 *   - anything mentioning `aborted` → `interrupted` (turn cap / cancel)
 *   - everything else → `failed`
 *
 * Exported for the unit-test surface in
 * `src/__tests__/agent-runtime-embedded.test.ts` so the
 * classification can be exercised without spinning up a full
 * harness lane.
 */
export function classifyError(message: string): StageRunResult["status"] {
  if (/no assistant entries/i.test(message)) return "format-error";
  if (/aborted|cancelled|killed/i.test(message)) return "interrupted";
  return "failed";
}

/** Decide whether a transient retry is sensible.
 *
 * Conservative defaults: only infrastructure-flavored messages
 * (timeout, abort) are retryable. Content / format errors are not —
 * a retry that hits the same parse path will fail the same way.
 */
export function classifyRetryable(message: string): boolean {
  if (/timeout|ETIMEDOUT|aborted/i.test(message)) return true;
  return false;
}