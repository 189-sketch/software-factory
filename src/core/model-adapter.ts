/**
 * ModelAdapter — a thin abstraction over the LLM provider layer.
 *
 * Why this exists: the factory's agent loop (pi-agent-core) only needs
 * `streamFn` and a Model. Different model providers (Anthropic, OpenAI,
 * Bedrock, vLLM, custom) all expose that surface but their SDKs are
 * different. By funnelling everything through this interface, the agent
 * loop can run against any provider, and `@mariozechner/pi-ai` becomes
 * a peer dependency instead of a hard one.
 *
 * Built-in adapters:
 *   - `anthropicAdapter()`  — uses pi-ai for the Anthropic Messages API
 *   - `echoAdapter()`       — for tests; returns a fixed assistant message
 *
 * Plug your own:
 *   ```ts
 *   class MyOpenAIAdapter implements ModelAdapter { ... }
 *   registerAdapter("openai", () => new MyOpenAIAdapter())
 *   ```
 *
 * Env wiring:
 *   FACTORY_MODEL_ADAPTER=anthropic (default) | openai | <your-key>
 *   FACTORY_MODEL_NAME=claude-3-7-sonnet  (passed to the adapter)
 */
import type { Model } from "@mariozechner/pi-ai";
import type { AgentTool, StreamFn } from "@mariozechner/pi-agent-core";

export { type StreamFn };

/**
 * The single object a ModelAdapter needs to expose for the agent loop
 * to drive it. The factory only calls `buildModel()` and `streamFn`; if
 * your adapter needs more, extend the interface in a sibling module
 * and cast at the call site.
 */
export interface ModelAdapter {
    /** Human-readable name, e.g. "anthropic" or "openai". */
    readonly name: string;

    /** True if the runtime has everything needed to call the model. */
    isConfigured(): boolean;

    /**
     * Build a Model object compatible with pi-agent-core. The agent
     * loop never reads Model fields directly; this is purely for
     * passing into `streamFn`.
     *
     * Async because the Anthropic adapter lazy-loads `@mariozechner/pi-ai`
     * via dynamic `import()` (pi-ai is pure ESM, so a CJS `require` cannot
     * resolve it). Non-Anthropic adapters can return `Promise.resolve(...)`.
     */
    buildModel(modelId?: string): Promise<Model<string>>;

    /** Stream function matching pi-agent-core's `streamFn` signature. */
    streamFn: StreamFn;
}

/* -------------------------------------------------------------------------- */
/* Public re-exports (kept here so test/import sites don't have to chase      */
/* multiple files)                                                            */
/* -------------------------------------------------------------------------- */

export { isLlmConfigured, getModelAdapter } from "./llm.js";

/* -------------------------------------------------------------------------- */
/* Adapter registry                                                           */
/* -------------------------------------------------------------------------- */

const registry = new Map<string, () => ModelAdapter>();

export function registerAdapter(key: string, factory: () => ModelAdapter): void {
    registry.set(key, factory);
}

export function resolveAdapter(): ModelAdapter {
    const explicit = process.env.FACTORY_MODEL_ADAPTER;
    const key = explicit || "anthropic";
    if (!registry.has(key)) throw new Error(`Unknown model adapter: ${key}`);
    if (key === 'echo') throw new Error("Echo adapter is test-only; use a production adapter for the factory (FACTORY_MODEL_ADAPTER=anthropic or your own key)");
    const factory = registry.get(key)!;
    return factory();
}

export function listAdapterKeys(): string[] {
    return Array.from(registry.keys());
}

/* -------------------------------------------------------------------------- */
/* Anthropic adapter (built-in)                                              */
/* -------------------------------------------------------------------------- */

/**
 * The Anthropic adapter wraps pi-ai's `streamSimple` so users who only
 * want the Anthropic-compatible endpoint get a working setup out of
 * the box. Endpoints like MiniMax-M3, OpenRouter, or any other
 * Anthropic-Messages-compatible base URL are supported by setting
 * `ANTHROPIC_BASE_URL`.
 */
class AnthropicAdapter implements ModelAdapter {
    readonly name = "anthropic";

    isConfigured(): boolean {
        return Boolean(getApiKey() && getBaseUrl() && getModelId());
    }

    buildModel(modelId?: string): Promise<Model<string>> {
        // Validate env first so the test suite can assert on the synchronous
        // "ANTHROPIC_BASE_URL required" error without waiting for pi-ai to load.
        const resolvedModelId = modelId || getModelId();
        const baseUrl = getBaseUrl();
        if (!baseUrl || !resolvedModelId) {
            return Promise.reject(
                new Error(
                    "Anthropic adapter requires ANTHROPIC_BASE_URL and ANTHROPIC_MODEL (or ANTHROPIC_DEFAULT_HAIKU_MODEL)",
                ),
            );
        }
        // Lazy-import pi-ai so a project that supplies a non-Anthropic
        // adapter doesn't need to install it. pi-ai is pure ESM, so we use
        // dynamic import rather than require/createRequire.
        return import("@mariozechner/pi-ai").then(({ getModels }) => {
            const base = getModels("anthropic").find((c) => c.api === "anthropic-messages");
            if (!base) throw new Error("pi-ai has no Anthropic capability schema registered");
            const requestOptions = getLlmRequestOptions();
            return {
                ...base,
                id: resolvedModelId,
                name: resolvedModelId,
                baseUrl,
                maxTokens: requestOptions.maxTokens ?? base.maxTokens,
                headers: {
                    "x-api-key": getApiKey() ?? "",
                    "anthropic-version": "2023-06-01",
                },
            } as unknown as Model<string>;
        });
    }

    streamFn = ((model: any, context: any, options: Record<string, unknown> = {}) => {
        // streamSimple is itself async (returns an AsyncIterable), so it's
        // safe to await the dynamic load inside it.
        return import("@mariozechner/pi-ai").then(({ streamSimple }) => {
            const configured = getLlmRequestOptions();
            return streamSimple(model, context, {
                ...options,
                ...(configured.timeoutMs === undefined ? {} : { timeoutMs: configured.timeoutMs }),
                ...(configured.maxRetries === undefined ? {} : { maxRetries: configured.maxRetries }),
                ...(configured.maxTokens === undefined ? {} : { maxTokens: configured.maxTokens }),
            });
        });
    }) as unknown as StreamFn;
}

/* -------------------------------------------------------------------------- */
/* Echo adapter (built-in, for tests)                                        */
/* -------------------------------------------------------------------------- */

/**
 * EchoAdapter: returns a deterministic assistant message without making
 * any network call. Used by tests that need to assert routing without
 * hitting the LLM. Picks a response by inspecting the system prompt.
 */
class EchoAdapter implements ModelAdapter {
    readonly name = "echo";

    isConfigured(): boolean {
        return true;
    }

    buildModel(): Promise<Model<string>> {
        return Promise.resolve({
            api: "anthropic-messages",
            provider: "echo",
            id: "echo-model",
            name: "echo-model",
            baseUrl: "echo://local",
            maxTokens: 1024,
        } as Model<string>);
    }

    streamFn = (async function* (model: unknown, context: any) {
        const sys = String((context.systemPrompt ?? "")).toLowerCase();
        const userText = (context.messages ?? [])
            .map((m: { content?: unknown }) => (typeof m.content === "string" ? m.content : ""))
            .join(" ");
        const text = echo(sys, userText);
        yield {
            type: "text",
            text,
        } as unknown;
    }) as unknown as StreamFn;
}

function echo(sys: string, user: string): string {
    const usr = user.toLowerCase();
    if (sys.includes("triage") || /triage|readiness/.test(usr)) {
        const isUnclear = /unclear|ambiguous|maybe|kind of|\?$/.test(usr);
        const isOff = /blockchain|nft|off-topic/.test(usr);
        const isArch = /architect|redesign|migration|state management|provider/.test(usr);
        if (isUnclear) return JSON.stringify({ state: "Needs info", label: "needs-info", remove_labels: [], comment: "echo: needs info" });
        if (isOff) return JSON.stringify({ state: "Wait to implement", label: "wait-to-implement", remove_labels: [], comment: "echo: off topic" });
        if (isArch) return JSON.stringify({ state: "Ready to spec", label: "ready-to-spec", remove_labels: [], comment: "echo: needs spec" });
        return JSON.stringify({ state: "Ready to implement", label: "ready-to-implement", remove_labels: [], comment: "echo: ready" });
    }
    if (sys.includes("implementation") || sys.includes("implement a fix")) {
        return JSON.stringify({
            filesChanged: [],
            testCommand: "node --test",
            prUrl: "https://github.com/echo/repo/pull/1",
            branch: "feature/echo",
        });
    }
    if (sys.includes("review") || sys.includes("annotated diff")) {
        return JSON.stringify({ verdict: "APPROVE", body: "echo: no findings", comments: [] });
    }
    if (sys.includes("spec") || sys.includes("product.md")) {
        return JSON.stringify({
            product: { slug: "echo", title: "echo product", problem: "echo", goals: [], nonGoals: [], stories: [], acceptanceCriteria: [], openQuestions: [], body: "# echo" },
            tech: { slug: "echo", approach: "echo", affectedAreas: [], dataModel: "in-memory", apiChanges: [], migrationPlan: "none", validationPlan: ["node --test"], alternatives: [], openQuestions: [], body: "# echo" },
            specBranch: "spec/echo",
            specPrUrl: "https://github.com/echo/repo/pull/0",
        });
    }
    if (sys.includes("verify") || sys.includes("behavior")) {
        return JSON.stringify({ mode: "verify", status: "verified", channel: "browser", ozRunUrl: "https://oz.echo/run/1", evidence: [] });
    }
    return "OK";
}

/* -------------------------------------------------------------------------- */
/* env helpers                                                               */
/* -------------------------------------------------------------------------- */

export function getApiKey(): string | undefined {
    return process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || undefined;
}

export function getModelId(): string | undefined {
    return process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
        || process.env.FACTORY_MODEL_NAME;
}

export function getBaseUrl(): string | undefined {
    return process.env.ANTHROPIC_BASE_URL;
}

export function getLlmRequestOptions(): {
    timeoutMs?: number;
    maxRetries?: number;
    maxTokens?: number;
} {
    return {
        timeoutMs: positiveInteger(process.env.FACTORY_LLM_TIMEOUT_MS ?? process.env.API_TIMEOUT_MS),
        maxRetries: nonNegativeInteger(process.env.ANTHROPIC_MAX_RETRIES),
        maxTokens: positiveInteger(process.env.ANTHROPIC_MAX_TOKENS),
    };
}

function positiveInteger(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* Register built-ins on module load                                        */
/* -------------------------------------------------------------------------- */

registerAdapter("anthropic", () => new AnthropicAdapter());
registerAdapter("echo", () => new EchoAdapter());
registerAdapter("default", () => new AnthropicAdapter());
