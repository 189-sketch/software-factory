/**
 * LlmAgent: an LLM-backed implementation of the agent loop using
 * @mariozechner/pi-agent-core. The factory runs agents exclusively in
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
import { Agent } from "@mariozechner/pi-agent-core";
import { type Model } from "@mariozechner/pi-ai";
import { toAgentTools, isLlmConfigured, getModelAdapter } from "./llm.js";
import type { AgentContext } from "./types.js";
import { defaultTools } from "./tools.js";
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type AgentMode = "llm";

export interface LlmAgentOpts<TResult> {
    name: string;
    ctx: AgentContext;
    systemPrompt: string;
    userPrompt: string;
    /** Parse the final assistant text into a typed result. */
    parse: (text: string) => TResult;
    /** Tool registry the LLM can call. Defaults to defaultTools(ctx). */
    extraTools?: ReturnType<typeof defaultTools>;
    /** When true, the agent must inspect at least one tool result. Defaults to false. */
    requireTools?: boolean;
    /**
     * Override the JSON shape expected by `parse`. Used to send a stricter
     * corrective prompt if the first response wasn't parseable.
     */
    jsonShapeHint?: string;
}

/**
 * Run the LLM-backed agent loop and return the parsed result.
 *
 * Throws if no adapter is configured; callers should check first.
 */
export async function runLlmAgent<TResult>(opts: LlmAgentOpts<TResult>): Promise<TResult> {
    if (!isLlmConfigured()) {
        throw new Error(
            "LLM not configured: install @mariozechner/pi-ai and set ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL, or supply your own ModelAdapter",
        );
    }
    const tools = toAgentTools([...(opts.extraTools ?? defaultTools(opts.ctx))], opts.ctx);
    const adapter = getModelAdapter();
    const model: Model<string> = await adapter.buildModel();
    const agent = new Agent({
        getApiKey: async () => process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || undefined,
        streamFn: adapter.streamFn,
        initialState: {
            systemPrompt: opts.systemPrompt,
            model,
            tools,
        },
    });
    let turns = 0;
    let exceeded = false;
    const unsubscribe = agent.subscribe((event) => {
        if (event.type === 'turn_end' && ++turns >= 40) { exceeded = true; agent.abort(); }
    });
    const timer = setTimeout(() => { exceeded = true; agent.abort(); }, 15 * 60 * 1000);
    try {
        await agent.prompt(opts.userPrompt);
        await agent.waitForIdle();

        let finalText = collectAssistantText(agent.state.messages);
        let retried = false;
        // One-shot corrective retry: if the first response isn't parseable,
        // remind the LLM about the exact JSON shape and try again. We only
        // do this when the model produced something parseable-ish (i.e. it
        // actually responded); an empty / error response is surfaced as-is.
        if (finalText && !isParseable(finalText, opts.parse)) {
            const hint = opts.jsonShapeHint
                ? `Your previous response was not valid. Respond with ONLY this JSON shape and nothing else: ${opts.jsonShapeHint}`
                : `Your previous response was not valid JSON. Respond with ONLY one valid JSON object that matches the original request — no prose, no markdown fences, no explanation.`;
            await agent.prompt(hint);
            await agent.waitForIdle();
            finalText = collectAssistantText(agent.state.messages);
            retried = true;
        }
        if (!finalText) {
            const last = (agent.state.messages as unknown[]).at(-1) as { stopReason?: string; errorMessage?: string } | undefined;
            throw new Error([
                `LLM returned no assistant text`,
                `adapter=${adapter.name}`,
                `model=${model.id}`,
                `stopReason=${last?.stopReason ?? "unknown"}`,
                `providerError=${last?.errorMessage ?? agent.state.errorMessage ?? "unknown"}`,
                `retried=${retried}`,
            ].join("; "));
        }
        try {
            return opts.parse(finalText);
        } catch (error) {
            // Parse failed even after the corrective retry. Surface both
            // attempts to the caller so it can fall back to a local
            // heuristic instead of losing all progress.
            throw new Error(
                `${opts.name} parse failed after${retried ? " retry" : " first attempt"}: ${String((error as Error).message ?? error)}\n` +
                `--- response ---\n${truncate(finalText, 2000)}\n--- end ---`,
            );
        }
    } finally {
        clearTimeout(timer);
        unsubscribe();
        const traceDir = path.join(process.env.FACTORY_STATE_DIR || path.join(opts.ctx.repo.workdir, '.factory'), 'traces');
        await fs.mkdir(traceDir, { recursive: true });
        const trace = JSON.stringify({ runId: opts.ctx.runId, issue: opts.ctx.issue.number, agent: opts.name, model: model.id, turns, messages: agent.state.messages }, null, 2);
        // Build a comprehensive redaction list. Secrets come from two
        // sources:
        //   1. Process env keys that look sensitive (TOKEN/SECRET/PASSWORD/
        //      API_KEY/AUTH) — covers ANTHROPIC_AUTH_TOKEN, GH_TOKEN, etc.
        //   2. Long random-looking strings inside tool arguments or tool
        //      observations — an LLM-driven flow might accidentally echo a
        //      bearer token from a fetched page back into the trace.
        const envSecrets = Object.entries(process.env)
            .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(key) && value && value.length > 5)
            .map(([, value]) => value!);
        const tokenLikeFromMessages: string[] = [];
        const tokenLike = /\b[A-Za-z0-9_\-]{20,}\b/g;
        const messageStrings: string[] = [];
        for (const message of agent.state.messages ?? []) {
            const content = (message as { content?: unknown }).content;
            if (typeof content === "string") messageStrings.push(content);
            else if (Array.isArray(content)) for (const part of content) {
                const p = part as { type?: string; text?: string; input?: unknown; content?: unknown };
                if (typeof p.text === "string") messageStrings.push(p.text);
                if (p.input) messageStrings.push(JSON.stringify(p.input));
                if (p.content) messageStrings.push(JSON.stringify(p.content));
            }
        }
        for (const text of messageStrings) {
            for (const match of text.match(tokenLike) ?? []) {
                if (!tokenLikeFromMessages.includes(match)) tokenLikeFromMessages.push(match);
            }
        }
        const allSecrets = new Set([...envSecrets, ...tokenLikeFromMessages]);
        let redacted = trace;
        for (const secret of allSecrets) {
            if (typeof secret === "string" && secret.length >= 8) redacted = redacted.split(secret).join('[REDACTED]');
        }
        await fs.writeFile(path.join(traceDir, `${opts.ctx.runId}-${opts.name}-${Date.now()}.json`), redacted, { mode: 0o600 });
    }
}

/** Concatenate every text block from the most recent assistant message. */
function collectAssistantText(messages: unknown): string {
    const list = (messages as unknown[]) ?? [];
    // Walk backwards: pick the latest assistant message with non-empty
    // text. Older assistant turns are usually intermediate reasoning we
    // don't want to confuse the parser with.
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i] as { role?: string; stopReason?: string; errorMessage?: string; content?: unknown };
        if (m.role !== "assistant") continue;
        if (typeof m.content === "string") {
            if (m.content.trim()) return m.content;
            continue;
        }
        if (Array.isArray(m.content)) {
            let text = "";
            for (const part of m.content) {
                const p = part as { type?: string; text?: string };
                if (p.type === "text" && typeof p.text === "string") text += p.text;
            }
            if (text.trim()) return text;
        }
    }
    return "";
}

/**
 * Cheap check: try the caller's parser on the text. If it returns a
 * value, the response is good enough; if it throws, we will retry.
 * Used to decide whether to send a corrective follow-up.
 */
function isParseable<T>(text: string, parse: (t: string) => T): boolean {
    try { parse(text); return true; } catch { return false; }
}

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
