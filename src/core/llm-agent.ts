/**
 * LlmAgent: an LLM-backed implementation of the agent loop using
 * @earendil-works/pi-agent-core. The factory runs agents exclusively in
 * `llm` mode against the configured ModelAdapter.
 *
 * Robustness contract:
 *   - If the LLM returns text that the caller's `parse` can't handle,
 *     we send one corrective follow-up that re-asserts the expected
 *     JSON shape and retry the parse. This catches the common case
 *     where the model drifts into prose on the first response but
 *     complies when reminded.
 *   - If `requireTools` is set, the agent must have inspected at least
 *     one piece of evidence via a tool call. When it isn't set (the
 *     default), the agent can produce a direct text answer; this is
 *     important for LLM modes that prefer to answer instead of
 *     call tools (most non-frontier models).
 */
import { isLlmConfigured } from "./llm.js";
import type { LlmEngine } from "./harness.js";
import type { AgentContext } from "./types.js";
import { defaultTools } from "./tools.js";
import { contractShapeHint, type OutputContract } from "./output-contract.js";
import { composeSystemPrompt } from "./system-prompt.js";
import { loadRequiredRules, type RequiredRule } from "./required-rules.js";
import type { SkillLoader } from "./skill.js";
import { getDefaultAgentRuntime, type AgentRuntime, type StageRunRequest } from "./agent-runtime.js";

export type AgentMode = "llm";

export interface LlmAgentOpts<TResult> {
    name: string;
    ctx: AgentContext;
    /**
     * Immutable role definition: who the agent is and what it must not
     * do. Injected once at agent start and never mutated during the run —
     * keeping it byte-stable maximizes provider prompt-cache hits across
     * turns and attempts.
     *
     * This is the ROLE ONLY. The skill catalog and the output contract
     * are appended by `composeSystemPrompt`; do not restate them here.
     * Dynamic content (prior-attempt feedback, revision payloads, staged
     * artifacts) must NOT be concatenated here — use `userPrompt` (task
     * definition) or `contextTurns` (follow-up user turns) instead.
     */
    systemPrompt: string;
    /**
     * The response format this agent requires, stated so the model can
     * satisfy it on the FIRST attempt.
     *
     * Required, not optional, and deliberately so. Every output rule the
     * pipeline depends on has to be expressible here; a rule that cannot
     * be written into `requirements` is a rule the model cannot be
     * expected to follow. The contract is rendered into the system prompt
     * and reused verbatim by the corrective retry, so the two can never
     * disagree.
     */
    outputContract: OutputContract;
    /**
     * Turn 1 of the conversation: the task definition (issue identity +
     * what to produce). Should be stable for a given issue so repeated
     * attempts share the cached prefix.
     */
    userPrompt: string;
    /**
     * Additional user turns appended to the conversation after
     * `userPrompt`, in order. Each turn is a separate `agent.prompt()`
     * round-trip, so the LLM can react to (and call tools on) earlier
     * turns before seeing the next one. Use for dynamic, attempt-specific
     * context: prior-attempt diffs, approved intermediate artifacts.
     * Empty/whitespace entries are skipped.
     *
     * Triage-authored corrections (`ctx.correction`) are appended after
     * these automatically — see `resolveContextTurns`.
     */
    contextTurns?: string[];
    /** Parse the final assistant text into a typed result. */
    parse: (text: string) => TResult;
    /** Tool registry the LLM can call. Defaults to defaultTools(ctx). */
    extraTools?: ReturnType<typeof defaultTools>;
    /** When true, the agent must inspect at least one tool result. Defaults to false. */
    requireTools?: boolean;
    /**
     * Optional skill loader used to pre-load required rules for this
     * stage. The loader's root is `ctx.skillsRoot`; the loader itself
     * is what `load_skill` would have used on demand.
     *
     * Required rules are inlined into the system prompt so the agent
     * sees severity / acceptance / permission rules on turn 1 instead
     * of being trusted to fetch them. If this is omitted, the run
     * falls back to the legacy "everything is optional" mode — kept
     * here so the existing call sites keep working while new code
     * adopts `loader`.
     */
    loader?: Pick<SkillLoader, "load">;
}

/**
 * Assemble the follow-up user turns for a run.
 *
 * A triage-authored correction always lands LAST. It is the operative
 * instruction for this attempt — "here is what went wrong and what to do
 * differently" — and recency makes it the most salient context the model
 * carries into its answer.
 */
function resolveContextTurns<TResult>(opts: LlmAgentOpts<TResult>): string[] {
    const correction = opts.ctx.correction;
    return [...(opts.contextTurns ?? []), ...(correction?.turns ?? [])];
}

/**
 * Run the LLM-backed agent loop and return the parsed result.
 *
 * Slice C thin shim: when the resolved backend is `claude-code`, the
 * call goes through `agentRuntime.runStage` so the dispatcher owns
 * the prompt assembly, parse-miss retry, and `usage` reporting. Other
 * backends (`codex-cli`, `pi-cli`, or any future `embedded` revival)
 * still route through `runHarness` until Group 7 removes the
 * fallback entirely.
 */
export async function runLlmAgent<TResult>(opts: LlmAgentOpts<TResult>): Promise<TResult> {
    if (!isLlmConfigured()) {
        throw new Error(
            "LLM not configured: install @earendil-works/pi-ai and set ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL, or supply your own ModelAdapter",
        );
    }
    const runtime = getDefaultAgentRuntime();
    const resolved = runtime.selectBackend(opts.name);
    if (resolved.selection.backend === "claude-code") {
        return runViaDispatcher<TResult>(opts, runtime);
    }
    return runHarness(opts);
}

/**
 * Dispatch an `LlmAgentOpts` request through the unified runtime and
 * parse the child output with the caller's `parse` function.
 *
 * The runtime's parse-miss corrective retry (Slice C Group 5 task
 * 5.1) lives in `claudeCodeHarnessAdapter`; this wrapper just plumbs
 * the agent's required-rules + output-contract through `StageRunRequest`
 * and feeds the child output back into the agent's parser so the
 * downstream behaviour matches the previous `runHarness + driveEngine`
 * contract byte-for-byte.
 */
async function runViaDispatcher<TResult>(
    opts: LlmAgentOpts<TResult>,
    runtime: AgentRuntime,
): Promise<TResult> {
    let requiredRules: RequiredRule[] = [];
    if (opts.loader) {
        requiredRules = (await loadRequiredRules(opts.name, opts.loader)).rules;
    }
    const stageRequest: StageRunRequest = {
        role: opts.name,
        runId: opts.ctx.runId,
        issue: { number: opts.ctx.issue.number, repo: { workdir: opts.ctx.repo.workdir } },
        inputManifest: {
            systemPrompt: opts.systemPrompt,
            userPrompt: opts.userPrompt,
            contextTurns: resolveContextTurns(opts),
            outputContract: opts.outputContract,
            requiredRules,
        },
        timeoutMs: undefined,
        abortSignal: undefined,
    };
    const result = await runtime.runStage(stageRequest, opts.ctx);
    if (result.status === "succeeded") {
        try {
            return opts.parse(result.output);
        } catch (error) {
            throw new Error(
                `${opts.name} parse failed via dispatcher: ${String((error as Error).message ?? error)}\n` +
                    `--- response ---\n${truncate(result.output, 2000)}\n--- end ---`,
            );
        }
    }
    if (result.status === "format-error") {
        throw new Error(
            `${opts.name} child returned format-error: ${result.warnings.join("; ") || "(no warnings)"}`,
        );
    }
    if (result.status === "cancelled" || result.status === "interrupted") {
        throw new Error(`${opts.name} run was ${result.status}`);
    }
    throw new Error(
        `${opts.name} dispatcher run failed: ${result.warnings.join("; ") || `status=${result.status}`}`,
    );
}

/**
 * Engine-agnostic conversation driver: deliver turn 1, then each
 * contextTurn, then collect the final assistant text and parse it. On a
 * parse miss, send one corrective turn and re-parse. Always closes the
 * engine (which persists the transcript) in `finally`.
 */
async function driveEngine<TResult>(engine: LlmEngine, opts: LlmAgentOpts<TResult>, engineLabel: string): Promise<TResult> {
    const logger = opts.ctx.logger;
    let promptIndex = 0;
    try {
        // Turn 1: the task definition. Stable for a given issue so the
        // provider can cache the systemPrompt + turn-1 prefix across
        // retries and attempts.
        logger.info(`[agent.${opts.name}.prompt]`, {
            agent: opts.name,
            index: ++promptIndex,
            kind: "task",
            bytes: opts.userPrompt.length,
            preview: truncate(opts.userPrompt, 2048),
        });
        await promptWithEmptyRetry(engine, opts.userPrompt, opts.name);

        // Follow-up user turns: attempt-specific context (prior diffs,
        // approved artifacts) followed by any triage-authored correction.
        // Delivered in order; the contract is only complete once every
        // turn has been sent.
        for (const turn of resolveContextTurns(opts)) {
            if (!turn || !turn.trim()) continue;
            logger.info(`[agent.${opts.name}.prompt]`, {
                agent: opts.name,
                index: ++promptIndex,
                kind: "context",
                bytes: turn.length,
                preview: truncate(turn, 2048),
            });
            await promptWithEmptyRetry(engine, turn, opts.name);
        }

        let finalText = await engine.finalText();
        // Slice C: the corrective retry moved to
        // `claudeCodeHarnessAdapter` (Group 5 task 5.1). Harness path
        // no longer retries on parse miss — once the harness fallback
        // is removed in Group 7, the harness engine will go away too.
        if (!finalText) {
            const detail = await engine.diagnostics().catch(() => "");
            throw new Error([
                `LLM returned no assistant text`,
                `engine=${engineLabel}`,
                detail,
            ].filter(Boolean).join("; "));
        }
        let parsed: TResult;
        try {
            parsed = opts.parse(finalText);
        } catch (error) {
            throw new Error(
                `${opts.name} parse failed: ${String((error as Error).message ?? error)}\n` +
                `--- response ---\n${truncate(finalText, 2000)}\n--- end ---`,
            );
        }
        logger.info(`[agent.${opts.name}.finish]`, {
            agent: opts.name,
            finalResponseBytes: finalText.length,
            finalResponsePreview: truncate(finalText, 4096),
            parsed: summarize(parsed),
        });
        return parsed;
    } catch (error) {
        logger.warn(`[agent.${opts.name}.error]`, {
            agent: opts.name,
            error: String((error as Error).message ?? error),
        });
        throw error;
    } finally {
        await engine.close();
    }
}

/**
 * Project a parsed agent result into a JSON-safe preview so the
 * lifecycle log line is informative without dumping the whole structure.
 * Falls back to a short stringification when the shape is exotic.
 */
function summarize(value: unknown): unknown {
    if (value == null) return value;
    if (typeof value === "string") return truncate(value, 512);
    if (typeof value !== "object") return value;
    try {
        return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "string" ? truncate(v, 512) : v));
    } catch {
        return "<unserializable>";
    }
}

/**
 * Harness engine: one durable Session per issue, one Lane per agent. The
 * harness modules are imported lazily so a misconfigured process never
 * pays for the pi-agent-core harness/session/env imports before the
 * configuration guard above has run.
 */
async function runHarness<TResult>(opts: LlmAgentOpts<TResult>): Promise<TResult> {
    const { HarnessLlmEngine, buildHarnessModels, getIssueSession } = await import("./harness.js");
    const { Type } = await import("@earendil-works/pi-ai");
    const { models, model } = await buildHarnessModels();
    const session = await getIssueSession(opts.ctx);
    // Pre-load required rules when the caller supplied a loader. The
    // orchestrator's existing call sites can pass the same SkillLoader
    // it hands to the `load_skill` tool; this is the seam the F10 fix
    // uses to make severity / acceptance / permission rubrics
    // non-optional. Missing rubric files throw HERE — the engine never
    // starts — so a missing rule is a configuration error visible in
    // the daemon lifecycle log, not a silent runtime omission.
    let requiredRules: RequiredRule[] = [];
    if (opts.loader) {
        const result = await loadRequiredRules(opts.name, opts.loader);
        requiredRules = result.rules;
        if (result.hasRules) {
            opts.ctx.logger.info(`[agent.${opts.name}.required_rules]`, {
                agent: opts.name,
                count: requiredRules.length,
                names: requiredRules.map((rule) => rule.name),
                hashes: requiredRules.map((rule) => rule.hash),
            });
        }
    }
    const engine = new HarnessLlmEngine({
        ctx: opts.ctx,
        laneName: opts.name,
        // Role + required rules + on-demand skill catalog + output
        // contract. Composed here rather than in the agent so no agent
        // can ship without stating its output format, and so required
        // rules can never silently regress to optional reference.
        systemPrompt: composeSystemPrompt({
            role: opts.systemPrompt,
            skills: opts.ctx.skills,
            contract: opts.outputContract,
            requiredRules,
        }),
        tools: [...(opts.extraTools ?? defaultTools(opts.ctx))],
        Type,
        models,
        model,
        session,
    });
    await engine.start();
    return driveEngine(engine, opts, `harness:${model.id}`);
}

/**
 * Cheap check: try the caller's parser on the text. If it returns a
 * value, the response is good enough; if it throws, we will retry.
 * Used to decide whether to send a corrective follow-up.
 */
function parseError<T>(text: string, parse: (t: string) => T): string | null {
    try {
        parse(text);
        return null;
    } catch (error) {
        return String((error as Error).message ?? error);
    }
}

/**
 * Send one user turn to the engine, retrying once on the specific
 * "empty response" error raised by the harness when a provider returns
 * 200 with no body (observed on MiniMax-M3 and similar Anthropic-
 * compatible endpoints). One retry, no backoff — if the second attempt
 * also produces nothing we surface the original error to the caller
 * so the orchestrator can fall back instead of silently retrying
 * forever.
 */
async function promptWithEmptyRetry(engine: LlmEngine, text: string, agentName: string): Promise<void> {
    try {
        await engine.prompt(text);
    } catch (error) {
        if (!isEmptyResponseError(error)) throw error;
        try {
            await engine.prompt(text);
        } catch (retryError) {
            throw new Error(
                `${agentName} prompt produced an empty response twice in a row; first=${String((error as Error).message ?? error)}; second=${String((retryError as Error).message ?? retryError)}`,
            );
        }
    }
}

/**
 * Match the harness's "settled without producing any entry" error so
 * the one-shot retry in `promptWithEmptyRetry` only fires on transient
 * empty responses, not on every kind of harness failure.
 *
 * Exported as a test hook (`__isEmptyResponseErrorForTest`) so unit
 * tests can lock the regex shape to the harness's actual error text.
 */
export function isEmptyResponseError(error: unknown): boolean {
    const message = String((error as Error)?.message ?? error);
    return /settled without producing any entry|returned empty response/i.test(message);
}

/** Test hook alias — see `isEmptyResponseError`. */
export const __isEmptyResponseErrorForTest = isEmptyResponseError;

function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Returns the agent mode. The factory runs exclusively in `llm` mode; legacy
 *  `FACTORY_AGENT_MODE=stub` is rejected so a forgotten test variable can't
 *  silently downgrade production runs to a no-op simulation. */
export function resolveAgentMode(): AgentMode {
    const explicit = process.env.FACTORY_AGENT_MODE;
    if (explicit === "stub") throw new Error("FACTORY_AGENT_MODE=stub is no longer supported; the factory runs in llm mode only");
    if (explicit && explicit !== "llm") throw new Error(`Unknown agent mode: ${explicit}`);
    return "llm";
}
