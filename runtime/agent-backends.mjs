export const AGENT_ROLES = Object.freeze([
  'triage', 'triage-supervisor', 'spec-product', 'spec-tech', 'review-spec',
  'implementation', 'review-pr', 'verify-behavior', 'improve-review-pr',
]);
const BACKENDS = new Set(['embedded', 'claude-code', 'codex-cli', 'pi-cli']);

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
    if (!AGENT_ROLES.includes(role)) throw new Error(`Invalid FACTORY_AGENT_OVERRIDES role: ${role}`);
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
    defaultBackend: backend(env.FACTORY_AGENT_BACKEND || 'embedded'),
    overrides: Object.freeze(overrides), timeoutMs,
    backends: Object.freeze({
      'claude-code': cli('CLAUDE', 'claude'),
      'codex-cli': cli('CODEX', 'codex'),
      'pi-cli': cli('PI', 'pi'),
    }),
  });
}

export function selectAgentBackend(config, role) {
  const selected = config.overrides[role] || { backend: config.defaultBackend };
  const options = config.backends[selected.backend];
  return Object.freeze({ ...options, ...selected, timeoutMs: config.timeoutMs });
}

export function usesEmbeddedBackend(config) {
  return AGENT_ROLES.some(role => selectAgentBackend(config, role).backend === 'embedded');
}

// Forward only configuration and credentials used by configured agent backends.
export function agentWorkerEnvironment(env, config) {
  const result = {};
  for (const key of ['FACTORY_AGENT_BACKEND', 'FACTORY_AGENT_OVERRIDES', 'FACTORY_AGENT_TIMEOUT_MS',
    'FACTORY_CLAUDE_COMMAND', 'FACTORY_CLAUDE_MODEL', 'FACTORY_CODEX_COMMAND', 'FACTORY_CODEX_MODEL',
    'FACTORY_PI_COMMAND', 'FACTORY_PI_MODEL', 'FACTORY_MODEL_ADAPTER', 'FACTORY_MODEL_NAME',
    'FACTORY_MODEL_CONTEXT_WINDOW', 'FACTORY_LLM_TIMEOUT_MS']) {
    if (env[key]) result[key] = env[key];
  }
  const selected = new Set(AGENT_ROLES.map(role => selectAgentBackend(config, role).backend));
  const keys = [];
  if (selected.has('claude-code')) keys.push('CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL');
  if (selected.has('codex-cli')) keys.push('CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL');
  if (selected.has('pi-cli')) keys.push('PI_CODING_AGENT_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY');
  for (const key of keys) if (env[key]) result[key] = env[key];
  return result;
}
