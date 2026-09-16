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
 *   FACTORY_MODEL_CONTEXT_WINDOW   (compaction threshold; default 512k)
 *   FACTORY_LLM_TIMEOUT_MS         (request timeout)
 *   ANTHROPIC_MAX_RETRIES          (transport retries)
 *   ANTHROPIC_MAX_TOKENS           (override the per-request max)
 */
import { resolveAdapter, type ModelAdapter, type StreamFn } from "./model-adapter.js";

export function isLlmConfigured(): boolean {
    return resolveAdapter().isConfigured();
}

export function getModelAdapter(): ModelAdapter {
    return resolveAdapter();
}

export { type ModelAdapter, type StreamFn };
