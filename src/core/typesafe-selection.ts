/**
 * Spec `2026-09-20-decision-architecture` / Phase C / T9.1.
 *
 * Two small shared helpers the per-agent typesafe migrations need:
 *
 *   1. `isTypesafeSelectedForRole(role)` — true when the resolved
 *      backend for `role` (per-role override, else the
 *      `FACTORY_AGENT_BACKEND` default) is `typesafe`. Agents gate
 *      their primitive-batch path on this so a claude-code deployment
 *      keeps its exact pre-migration behaviour: no typesafe call is
 *      attempted, no synthetic fallback shape can leak into the
 *      pipeline, and the existing `dispatchAgentStage` envelope is
 *      the only path.
 *
 *   2. `claudeFallbackRuntime(role)` — an `AgentRuntime` whose
 *      selection for `role` is forced to `claude-code`. This is the
 *      CJK contract's `fallback_backend: claude-code` made concrete:
 *      when a typesafe-selected agent hits a format-error / parse
 *      miss, the retry goes through the existing claude-code harness
 *      (with the agent's preserved `OutputContract` parser) even
 *      though the global default points at typesafe.
 *
 * Both helpers read a caller-supplied `env` (default `process.env`)
 * so tests can inject a closed environment without mutating global
 * state.
 */
import { buildAgentRuntime, type AgentRuntime } from "./agent-runtime.js";
import { resolveAgentConfig, selectAgentBackend } from "../../runtime/agent-backends.mjs";

/**
 * True when the runtime resolves `role` to the `typesafe` backend.
 * Malformed `FACTORY_AGENT_OVERRIDES` surface as a throw from
 * `resolveAgentConfig` (same startup pre-check behaviour as every
 * other selection call site).
 */
export function isTypesafeSelectedForRole(
    role: string,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const config = resolveAgentConfig(env);
    return selectAgentBackend(config, role).backend === "typesafe";
}

/**
 * Build an `AgentRuntime` that forces `role` onto `claude-code`
 * regardless of the ambient `FACTORY_AGENT_BACKEND` /
 * `FACTORY_AGENT_OVERRIDES`. Existing per-role overrides for OTHER
 * roles are preserved (the operator's configuration is respected);
 * only the fallback role's entry is replaced.
 *
 * Used by the typesafe-migrated agents as the `runtimeOverride`
 * argument of `dispatchAgentStage` on the format-error / parse-miss
 * branch.
 */
export function claudeFallbackRuntime(
    role: string,
    env: NodeJS.ProcessEnv = process.env,
): AgentRuntime {
    let overrides: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(env.FACTORY_AGENT_OVERRIDES || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            overrides = parsed as Record<string, unknown>;
        }
    } catch {
        // Malformed overrides: the forced claude-code entry below is
        // the only one that matters for the fallback dispatch.
        overrides = {};
    }
    overrides[role] = { backend: "claude-code" };
    return buildAgentRuntime({
        ...env,
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_AGENT_OVERRIDES: JSON.stringify(overrides),
    } as NodeJS.ProcessEnv);
}