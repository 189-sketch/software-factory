import { AGENT_ROLES as PIPELINE_AGENT_ROLES } from "./pipeline-definition.mjs";

// Single source of truth: `pipeline-definition.mjs` declares the
// authoritative role list (id / stage / label). This module re-uses
// it directly for `FACTORY_AGENT_OVERRIDES` validation and the
// `agentWorkerEnvironment` whitelist walk. Adding a role now means
// editing exactly one place.
//
// `INTERNAL_AGENT_ROLES` was removed in 2026-09 (issue #36 fix): the
// old `triage-supervisor` hat was the only internal role, and the
// orchestrator now uses the deterministic `decideRouting` pure
// function instead of an LLM supervisor stage. With no internal
// hats remaining, every role in `PIPELINE_AGENT_ROLES` is overridable
// via `FACTORY_AGENT_OVERRIDES`.

const AGENT_ROLES_SET = Object.freeze(new Set(PIPELINE_AGENT_ROLES.map(r => r.id)));
const OVERRIDEABLE_ROLES = Object.freeze(PIPELINE_AGENT_ROLES.map(r => r.id));

export const AGENT_ROLES = OVERRIDEABLE_ROLES;

const BACKENDS = new Set(['claude-code']);

function backend(value) {
  if (!BACKENDS.has(value)) throw new Error(`Invalid FACTORY_AGENT backend: ${String(value)}`);
  return value;
}

export function resolveAgentConfig(env = process.env) {
  let raw;
  try { raw = JSON.parse(env.FACTORY_AGENT_OVERRIDES || '{}'); }
  catch { throw new Error('Invalid FACTORY_AGENT_OVERRIDES: expected a JSON object'); }
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('Invalid FACTORY_AGENT_OVERRIDES: expected a JSON object');
  const overrides = {};
  for (const [role, value] of Object.entries(raw)) {
    if (!AGENT_ROLES_SET.has(role)) {
      throw new Error(`Invalid FACTORY_AGENT_OVERRIDES role: ${role}`);
    }
    const entry = typeof value === 'string' ? { backend: value } : value;
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['backend', 'model'].includes(key)) ||
        (entry.model !== undefined && (typeof entry.model !== 'string' || !entry.model.trim()))) {
      throw new Error(`Invalid FACTORY_AGENT_OVERRIDES entry: ${role}`);
    }
    overrides[role] = Object.freeze({ backend: backend(entry.backend), ...(entry.model ? { model: entry.model } : {}) });
  }
  const timeoutMs = Number(env.FACTORY_AGENT_TIMEOUT_MS || 900_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 7_200_000) throw new Error('Invalid FACTORY_AGENT_TIMEOUT_MS');
  const cli = (prefix, command) => Object.freeze({
    executable: env[`FACTORY_${prefix}_COMMAND`] || command,
    model: env[`FACTORY_${prefix}_MODEL`] || '',
  });
  return Object.freeze({
    defaultBackend: backend(env.FACTORY_AGENT_BACKEND || 'claude-code'),
    overrides: Object.freeze(overrides), timeoutMs,
    backends: Object.freeze({
      'claude-code': cli('CLAUDE', 'claude'),
      'codex-cli': cli('CODEX', 'codex'),
      'pi-cli': cli('PI', 'pi'),
      'typesafe': cli('TYPESAFE', 'typesafe'),
    }),
  });
}

export function selectAgentBackend(config, role) {
  const selected = config.overrides[role] || { backend: config.defaultBackend };
  const options = config.backends[selected.backend];
  return Object.freeze({ ...options, ...selected, timeoutMs: config.timeoutMs });
}

export function usesEmbeddedBackend(config) {
  // Slice C removed the `embedded` backend; the dispatcher is the
  // only LLM entry point. This helper stays so existing callers
  // compile, but it always returns false.
  void config;
  return false;
}

// Forward only configuration and credentials used by configured agent backends.
export function agentWorkerEnvironment(env, config) {
  const result = {};
  for (const key of ['FACTORY_AGENT_BACKEND', 'FACTORY_AGENT_OVERRIDES', 'FACTORY_AGENT_TIMEOUT_MS',
    'FACTORY_CLAUDE_COMMAND', 'FACTORY_CLAUDE_MODEL', 'FACTORY_CODEX_COMMAND', 'FACTORY_CODEX_MODEL',
    'FACTORY_PI_COMMAND', 'FACTORY_PI_MODEL', 'FACTORY_TYPESAFE_COMMAND', 'FACTORY_TYPESAFE_MODEL',
    'FACTORY_TYPESAFE_OFF', 'FACTORY_MODEL_ADAPTER', 'FACTORY_MODEL_NAME',
    'FACTORY_MODEL_CONTEXT_WINDOW', 'FACTORY_LLM_TIMEOUT_MS']) {
    if (env[key]) result[key] = env[key];
  }
  const selected = new Set(AGENT_ROLES.map(role => selectAgentBackend(config, role).backend));
  const keys = [];
  if (selected.has('claude-code')) keys.push('CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL');
  if (selected.has('codex-cli')) keys.push('CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL');
  if (selected.has('pi-cli')) keys.push('PI_CODING_AGENT_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY');
  // Spec `2026-09-21` (issue #36 follow-up): forward `TYPESAFE_API_KEY`
  // to every worker regardless of the role's selected backend. The
  // typesafe verdict layer (SpecAgent.trySpecTypesafeBatch,
  // ReviewSpecAgent.tryReviewSpecTypesafeBatch, triage.runTypesafeBatch,
  // etc.) calls typesafe as an INDEPENDENT judgment bypass — not as
  // the agent's runtime backend — so a per-role
  // `selected.has('typesafe')` gate incorrectly excludes every worker
  // that does not also use typesafe as its primary backend. The net
  // effect was that `TYPESAFE_API_KEY` was never forwarded by default,
  // and every typesafe verdict call fell through to
  // `TYPESAFE_API_KEY missing` even though the daemon loaded the key
  // from `.factory-daemon/.env` at startup.
  keys.push('TYPESAFE_API_KEY');
  for (const key of keys) if (env[key]) result[key] = env[key];
  return result;
}
