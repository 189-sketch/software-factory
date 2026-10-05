import path from "node:path";
import { resolveAgentConfig } from './agent-backends.mjs';

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const EXECUTION_ADAPTERS = new Set(["local", "docker", "vm"]);

/**
 * Supported values for `FACTORY_EXECUTION_ADAPTER`:
 *
 *   - `local`  — run implementation/verify directly in the issue worktree.
 *                Requires `FACTORY_TRUSTED_EXECUTION=1`.
 *   - `docker` — run inside the image named by `FACTORY_DOCKER_IMAGE`
 *                (must include Node.js, Git, GitHub CLI, and pipeline deps).
 *   - `vm`     — run through the wrapper command named by `FACTORY_VM_COMMAND`
 *                (must transport the worktree and run the command).
 *
 * Aliases (deprecated, retained for backwards compatibility with
 * installations written against the original spec):
 *
 *   - `FACTORY_EXECUTION_MODE` is a legacy alias for
 *     `FACTORY_EXECUTION_ADAPTER`. Setting it surfaces a WARN log on
 *     boot so an operator can update their `.env`. The alias will be
 *     removed in a future release.
 */

function booleanValue(env, name, defaultValue) {
  const raw = env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} (expected true/false or 1/0)`);
}

function integerValue(env, name, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} (expected integer ${min}..${max})`);
  }
  return parsed;
}

function optionalIntegerValue(env, name, options) {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  return integerValue(env, name, undefined, options);
}

function resolvePath(cwd, value, fallback) {
  return path.resolve(cwd, value || fallback);
}

/**
 * Parse every factory runtime option once.
 *
 * Callers receive typed values and must not reinterpret environment strings.
 * CLI overrides win for process-local paths and ports. Shell environment wins
 * for repository identity and credentials so wrapper-provided values remain
 * authoritative.
 */
export function resolveFactoryConfig({ env = process.env, cwd = process.cwd(), cli = {} } = {}) {
  const adapter = String(env.FACTORY_EXECUTION_ADAPTER || env.FACTORY_EXECUTION_MODE || "local").trim().toLowerCase();
  if (env.FACTORY_EXECUTION_MODE && !env.FACTORY_EXECUTION_ADAPTER) {
    // WARN-only deprecation hint. The alias still resolves so older
    // .env files continue to work; this log line tells operators to
    // migrate before the alias is removed.
    try {
      process.stderr.write(
        `[WARN] FACTORY_EXECUTION_MODE is deprecated; set FACTORY_EXECUTION_ADAPTER=${adapter} instead.\n`,
      );
    } catch {}
  }
  if (!EXECUTION_ADAPTERS.has(adapter)) {
    throw new Error(`Invalid FACTORY_EXECUTION_ADAPTER: ${JSON.stringify(adapter)} (expected local, docker, or vm)`);
  }

  const localDirRaw = cli.localDir ?? env.FACTORY_LOCAL_DIR ?? "";
  const localDir = localDirRaw ? path.resolve(cwd, String(localDirRaw)) : "";
  const stateDir = resolvePath(cwd, cli.stateDir ?? env.FACTORY_STATE_DIR, ".factory");
  const workdir = resolvePath(cwd, cli.workdir ?? env.FACTORY_WORKDIR, "factory-workdir");
  const repository = String(env.FACTORY_GH_REPO || cli.repo || "");
  const runTimeoutMs = integerValue(env, "FACTORY_RUN_TIMEOUT_MS", 3_600_000, { min: 10_000, max: 7_200_000 });

  return Object.freeze({
    agents: resolveAgentConfig(env),
    autoMerge: booleanValue(env, "FACTORY_AUTO_MERGE", false),
    state: Object.freeze({
      backend: localDir || !repository ? "fixture" : "github",
      leaseSha: String(env.FACTORY_ISSUE_LEASE_SHA || ""),
      writers: String(env.FACTORY_STATE_WRITERS || "").split(",").map((value) => value.trim()).filter(Boolean),
    }),
    syncLabels: booleanValue(env, "FACTORY_SYNC_LABELS", localDir ? false : true),
    syncProjects: booleanValue(env, "FACTORY_SYNC_PROJECTS", localDir ? false : true),
    github: Object.freeze({
      repository,
      token: String(env.GH_TOKEN || env.GITHUB_TOKEN || ""),
      defaultBranch: String(env.FACTORY_DEFAULT_BRANCH || "main"),
      remotePath: String(env.FACTORY_REMOTE_PATH || ""),
    }),
    model: Object.freeze({
      adapter: String(env.FACTORY_MODEL_ADAPTER || "anthropic"),
      apiKey: String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || ""),
      baseUrl: String(env.ANTHROPIC_BASE_URL || ""),
      id: String(env.FACTORY_MODEL_NAME || env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_HAIKU_MODEL || ""),
      contextWindow: integerValue(env, "FACTORY_MODEL_CONTEXT_WINDOW", 512_000, { min: 1 }),
      requestTimeoutMs: optionalIntegerValue(env, "FACTORY_LLM_TIMEOUT_MS", { min: 1 }),
      maxRetries: optionalIntegerValue(env, "ANTHROPIC_MAX_RETRIES", { min: 0 }),
      maxTokens: integerValue(env, "ANTHROPIC_MAX_TOKENS", 16_384, { min: 1 }),
    }),
    daemon: Object.freeze({
      pollIntervalSec: Number(cli.interval ?? env.FACTORY_POLL_INTERVAL ?? 30),
      webhookPort: Number(cli.webhookPort ?? env.FACTORY_WEBHOOK_PORT ?? 0),
      webhookSecret: String(env.FACTORY_WEBHOOK_SECRET || ""),
      runTimeoutMs,
      // Number of concurrent worker pipelines the daemon runs. Each
      // worker owns its own lease/worktree/session, so the limit is
      // effectively bounded by disk + LLM-token budget, not by code.
      // 1 (default) reproduces the legacy single-worker behaviour; 2
      // doubles throughput for multi-issue repos at the cost of
      // doubled LLM quota per cycle.
      workerPoolSize: integerValue(env, "FACTORY_WORKER_POOL_SIZE", 1, { min: 1, max: 8 }),
    }),
    limits: Object.freeze({
      agentFailures: integerValue(env, "FACTORY_MAX_AGENT_FAILURES", 50, { min: 1 }),
      implementationAttempts: integerValue(env, "FACTORY_MAX_IMPL_ATTEMPTS", 10, { min: 1 }),
      commandTimeoutMs: integerValue(env, "FACTORY_COMMAND_TIMEOUT_MS", Math.min(120_000, runTimeoutMs), { min: 1, max: runTimeoutMs }),
    }),
    lease: Object.freeze({
      staleMs: integerValue(env, "FACTORY_LEASE_STALE_MS", 0, { min: 0, max: 7 * 24 * 60 * 60 * 1000 }),
    }),
    execution: Object.freeze({
      adapter,
      trusted: booleanValue(env, "FACTORY_TRUSTED_EXECUTION", false),
      dockerImage: String(env.FACTORY_DOCKER_IMAGE || ""),
      vmCommand: String(env.FACTORY_VM_COMMAND || ""),
    }),
    paths: Object.freeze({
      stateDir,
      workdir,
      localDir,
      reviewDir: env.FACTORY_REVIEW_DIR ? path.resolve(cwd, env.FACTORY_REVIEW_DIR) : "",
    }),
    verify: Object.freeze({
      command: String(env.FACTORY_VERIFY_COMMAND || ""),
      url: String(env.FACTORY_VERIFY_URL || ""),
    }),
  });
}
