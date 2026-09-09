/**
 * LLM adapter entry points. The provider layer is abstracted in
 * `model-adapter.ts`; this file is the thin public API the rest of the
 * factory uses.
 *
 * Reads:
 *   ANTHROPIC_BASE_URL             (required by the Anthropic adapter)
 *   ANTHROPIC_AUTH_TOKEN / _API_KEY
 *   ANTHROPIC_MODEL                (or ANTHROPIC_DEFAULT_HAIKU_MODEL)
 *   FACTORY_MODEL_ADAPTER          (default "anthropic"; plug your own)
 *   FACTORY_MODEL_NAME             (override the default model id)
 *   FACTORY_LLM_TIMEOUT_MS         (request timeout)
 *   ANTHROPIC_MAX_RETRIES          (transport retries)
 *   ANTHROPIC_MAX_TOKENS            (override the per-request max)
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { resolveAdapter, type ModelAdapter, type StreamFn } from "./model-adapter.js";
import type { AgentContext } from "./types.js";

export function isLlmConfigured(): boolean {
    return resolveAdapter().isConfigured();
}

export function getModelAdapter(): ModelAdapter {
    return resolveAdapter();
}

export { type ModelAdapter, type StreamFn };

/**
 * Convert our internal AgentTool shape (record args) to pi-agent-core's
 * AgentTool shape. We use a permissive schema and let the LLM pass
 * arbitrary JSON; the tool wrapper does runtime validation.
 */
export function toAgentTools(
    tools: Array<{ name: string; description: string; execute: (args: Record<string, unknown>, ctx: AgentContext) => Promise<unknown> }>,
    ctx: AgentContext,
): AgentTool[] {
    return tools.map((t) => ({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: {
            type: "object",
            properties: toolSchema(t.name).properties,
            required: toolSchema(t.name).required,
            additionalProperties: false,
        } as any,
        execute: async (_id, params) => {
            const result = await t.execute(params as Record<string, unknown>, ctx);
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return {
                content: [{ type: "text", text } as TextContent],
                details: result,
            };
        },
    }));
}

export interface LlmRunResult {
    text: string;
    messages: unknown[];
    stopReason: string;
}

function toolSchema(name: string) {
    const s = { type: 'string' };
    const n = { type: 'number' };
    const strings = { type: 'array', items: s };
    const definitions: Record<string, [Record<string, unknown>, string[]]> = {
        read_file: [{ path: s }, ['path']],
        write_file: [{ path: s, content: s }, ['path', 'content']],
        list_dir: [{ path: s }, []],
        grep_repo: [{ pattern: s, glob: s, max: n }, ['pattern']],
        fetch_issue: [{ issueNumber: n }, []],
        run_shell: [{ command: s, cwd: s, timeoutMs: n }, ['command']],
        run_validation: [{ command: s }, ['command']],
        run_acceptance_test: [{ command: s }, ['command']],
        browser: [{ action: { type: 'string', enum: ['open', 'click', 'fill', 'assert_text', 'assert_visible', 'screenshot'] }, selector: s, value: s }, ['action']],
        collect_feedback: [{}, []],
        post_issue_comment: [{ body: s }, ['body']],
        update_issue_labels: [{ add: strings, remove: strings }, []],
        commit_and_push: [{ branch: s, message: s, files: strings }, ['branch', 'message', 'files']],
        open_pull_request: [{ branch: s, baseBranch: s, title: s, body: s }, ['branch', 'title', 'body']],
    };
    const definition = definitions[name];
    if (!definition) throw new Error(`Missing tool schema: ${name}`);
    return { properties: definition[0], required: definition[1] };
}
