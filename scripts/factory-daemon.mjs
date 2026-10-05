#!/usr/bin/env node
/**
 * Local factory daemon: polls a target GitHub repo for new issues and
 * processes them on the local machine. Secrets stay local; only finished
 * commits/PRs reach github.com.
 *
 * Usage:
 *   # Option 1: poll a remote GitHub repo
 *   FACTORY_GH_REPO=owner/name \
 *   GH_TOKEN=ghp_... \
 *   ANTHROPIC_AUTH_TOKEN=sk-... \
 *   node scripts/factory-daemon.mjs --interval 60
 *
 *   # Option 2: watch a local directory for issue JSON files (offline / dev)
 *   node scripts/factory-daemon.mjs --local-dir ./issues --interval 5
 *
 *   # Option 3: GitHub webhook (real-time, server required)
 *   node scripts/factory-daemon.mjs --webhook-port 8080
 *
 *   # Option 4: run the daily review improvement loop once
 *   node scripts/factory-daemon.mjs --daily
 *
 * Run modes can be combined: --local-dir + --webhook-port, etc.
 *
 * The daemon handles each issue end-to-end (triage → spec → implement →
 * review → verify → push). Durable issue checkpoints are stored under
 * <state-dir>/issues and execution summaries under <state-dir>/state-<n>.json.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { classifyPipelineOutcome } from "./pipeline-outcome.mjs";
import { clearNeedsInfoWakeIfTriageAdvanced } from "./needs-info-wake.mjs";
import { findStaleInFlight } from "./reconciler.mjs";
import { resolveFactoryConfig } from "../runtime/factory-config.mjs";
import { businessInputHash, isFactoryComment } from "../runtime/business-input.mjs";
import { ACTIVE_PIPELINE_LABELS, RETIRED_PIPELINE_LABELS } from "../runtime/pipeline-definition.mjs";
import { spawnWorker } from "../runtime/worker-executor.mjs";
import { workerFailure, isWorkerFailure } from "../runtime/worker-failure.mjs";
import { RecoveryScheduler, recoveryHash, recoveryNotice } from "../runtime/recovery-scheduler.mjs";
import { judgmentResumeStage } from "../runtime/judgment-recovery.mjs";
import { createLeaseManager } from "../runtime/lease-manager.mjs";
import { createFixtureLeaseManager } from "../runtime/fixture-state.mjs";
import { readIssueState } from "../runtime/issue-state.mjs";
import { listGitHubLeases } from "../runtime/github-leases.mjs";
import { recordReceipt as recordOperationReceipt } from "../runtime/operation-receipts.mjs";
import {
  fetchIssue as fetchIssueRest,
  fetchPullRequest as fetchPullRequestRest,
  listIssueComments as listIssueCommentsRest,
  listOpenIssues,
  listIssues,
  createIssueComment,
  fetchAuthenticatedUser,
} from "../runtime/github-rest.mjs";
import {
  commandErrorText,
  detectDefaultBranch,
  ensureIssueWorktree,
  formatUtc8Timestamp,
  isGitWorktree,
  runCommandWithRetry,
  shouldParkWaitingIssue,
} from "./daemon-support.mjs";
import {
  freshnessCheck,
  summariseFreshness,
} from "./freshness-poc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryRoot = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));

// Load env from .env file FIRST (before reading any process.env below).
// Default to .factory-daemon/.env so the installer-wrapped start.sh /
// start.cmd don't have to shell-parse dotenv files (which is brittle on
// Windows .cmd). Explicit --env-file=path wins; pass --no-env-file to skip.
const SKIP_ENV_FILE = args.noEnvFile === true || args.envFile === "-";
if (!SKIP_ENV_FILE) {
  const envPath = (typeof args.envFile === "string" && args.envFile.length)
    ? path.resolve(args.envFile)
    : path.resolve(process.cwd(), ".factory-daemon", ".env");
  if (fsSync.existsSync(envPath)) {
    loadDotEnv(envPath);
  }
}

const STATE_DIR = resolveFactoryConfig({ cwd: process.cwd(), cli: args }).paths.stateDir;
const activeIssueClaims = new Set();
fsSync.mkdirSync(STATE_DIR, { recursive: true });
const DAEMON_LOCK = acquireDaemonLock();
process.on("exit", () => releaseDaemonLock(DAEMON_LOCK));

// --------------------------------------------------------------------
// Death-recording hooks. The daemon's silent exits (no stack trace, no
// `process-issue-end` log) have been hard to diagnose — the most
// common reason on Windows is the parent shell closing the inherited
// stdin handle, which surfaces as a `SIGHUP` or an `uncaughtException`
// during a poll. Record the last heartbeat plus the exit reason in a
// sidecar file so the next invocation can show "died at HH:MM:SS with
// reason X" instead of "the log just stops".
// --------------------------------------------------------------------
const DEATH_LOG = path.join(STATE_DIR, "daemon-death.json");
function recordDeath(reason, extra = {}) {
  try {
    fsSync.writeFileSync(DEATH_LOG, JSON.stringify({
      pid: process.pid,
      reason,
      timestamp: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      ...extra,
    }, null, 2));
  } catch {}
}
function handleFatal(reason, error) {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  const detail = String(error?.message ?? error ?? "");
  recordDeath(reason, { message: detail, stack: String(error?.stack ?? "").slice(0, 1500) });
  try { log("ERROR", reason, { error: detail }); } catch {}
  process.exit(1);
}
process.on("uncaughtException", (err) => handleFatal("uncaughtException", err));
process.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason));
// Signal-driven shutdown. Registering a handler for SIGINT/SIGTERM/SIGHUP
// overrides Node.js's default "exit on signal" behaviour; without an
// explicit `process.exit()` the daemon will keep running after Ctrl+C,
// which made the daemon effectively unkillable without `taskkill /F`.
// Each handler records the death reason and exits with the conventional
// 128 + signal-number code so a wrapper script can distinguish signal
// shutdowns from crashes (`uncaughtException` keeps its own code path).
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
let shuttingDown = false;
function handleShutdown(signal) {
  if (shuttingDown) {
    // Repeated signal — bail hard instead of re-entering recordDeath.
    process.exit(1);
  }
  shuttingDown = true;
  recordDeath(signal);
  process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
}
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGHUP", () => handleShutdown("SIGHUP"));
process.on("exit", (code) => {
  // `exit` runs AFTER the uncaughtException handler above, so
  // recordDeath is already on disk for crashes. For graceful exits
  // we just append a short marker.
  try {
    const existing = JSON.parse(fsSync.readFileSync(DEATH_LOG, "utf8"));
    existing.exitCode = code;
    fsSync.writeFileSync(DEATH_LOG, JSON.stringify(existing, null, 2));
  } catch {}
  // releaseDaemonLock already wired above.
});

/**
 * Apply fallback env sources, in order, ONLY where the variable is not
 * already set. Real shell env wins. Caller can disable via --no-fallback-env.
 *
 *  1. ~/.claude/settings.json  → pulls ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL,
 *                                ANTHROPIC_MODEL (the user's local Claude Code
 *                                config — reuses credentials you've
 *                                already authorised there).
 *  2. gh CLI                   → if `gh auth status` succeeds, use the
 *                                authenticated account's token for GH_TOKEN.
 *                                Avoids forcing users to set GH_TOKEN when
 *                                they've already done `gh auth login`.
 *
 * The defaults are minimaxi (per project README) so the daemon is usable
 * with just `~/.claude/settings.json` or the env vars, no manual config.
 */
function applyEnvFallbacks() {
  const sources = [];

  // (1) ~/.claude/settings.json — only fill unset keys.
  const claudeSettings = path.join(os.homedir(), ".claude", "settings.json");
  if (fsSync.existsSync(claudeSettings)) {
    try {
      const json = JSON.parse(fsSync.readFileSync(claudeSettings, "utf-8"));
      if (json && typeof json.env === "object" && json.env !== null) {
        let loaded = 0;
        for (const [k, v] of Object.entries(json.env)) {
          if (process.env[k] === undefined && v !== undefined && v !== null) {
            process.env[k] = String(v);
            loaded++;
          }
        }
        if (loaded > 0) sources.push({ source: "claude-settings", count: loaded });
      }
    } catch (err) {
      // ignore — file may not be JSON
    }
  }

  // (2) gh CLI fallback for GH_TOKEN. Treat installer placeholders
  // (ghp_replace_me, sk-...) the same as missing so a token already
  // exported by `start.cmd` / `start.sh` doesn't silently override the
  // gh-cli credential the user actually wants to use.
  const isPlaceholderToken = (v) =>
    !v || /replace[_ ]?me|^ghp_$|^sk-(ant-)?$/i.test(v);
  if (
    isPlaceholderToken(process.env.GH_TOKEN) &&
    isPlaceholderToken(process.env.GITHUB_TOKEN)
  ) {
    try {
      const out = execFileSync("gh", ["auth", "token"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        process.env.GH_TOKEN = out;
        sources.push({ source: "gh-cli", count: 1 });
      }
    } catch {
      // gh CLI not installed or not logged in — fallback unavailable.
    }
  }

  return sources;
}

/**
 * Minimal .env loader. KEY=VALUE, lines starting with # are comments, empty
 * lines skipped, optional surrounding quotes trimmed, existing process.env
 * wins (so real shell env still overrides .env). Not exported; scoped here.
 */
function loadDotEnv(file) {
  const text = fsSync.readFileSync(file, "utf-8");
  let loaded = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      // Skip installer-style placeholder values (ghp_replace_me / sk-..._replace_me)
      // so fallback layers (gh-cli auth, ~/.claude/settings.json) still kick in.
      if (!val || /replace[_ ]?me|^ghp_$|^sk-(ant-)?$/i.test(val)) continue;
      process.env[key] = val;
      loaded++;
    }
  }
  return loaded;
}

const log = (level, msg, extra = {}) => {
  const ts = formatUtc8Timestamp();
  const line = `${ts} ${level} ${msg} ${JSON.stringify(extra)}`;
  console.log(line);
  fsSync.appendFileSync(path.join(STATE_DIR, "daemon.log"), line + "\n");
};

// Apply env fallbacks AFTER the .env load + AFTER log() is defined so we can
// record which sources actually contributed. --no-fallback-env disables.
const envSources = args.noFallbackEnv ? [] : applyEnvFallbacks();
if (envSources.length > 0) {
  log("INFO", "env-fallbacks-applied", { sources: envSources });
}

const FACTORY_CONFIG = resolveFactoryConfig({ cwd: process.cwd(), cli: args });
const GH_TOKEN = FACTORY_CONFIG.github.token;
const ANTHROPIC_AUTH_TOKEN = FACTORY_CONFIG.model.apiKey;
const ANTHROPIC_BASE_URL = FACTORY_CONFIG.model.baseUrl;
const ANTHROPIC_MODEL = FACTORY_CONFIG.model.id;
const LLM_CONFIGURED = Boolean(ANTHROPIC_AUTH_TOKEN && ANTHROPIC_BASE_URL && ANTHROPIC_MODEL);
const FACTORY_GH_REPO = FACTORY_CONFIG.github.repository;
const POLL_INTERVAL = FACTORY_CONFIG.daemon.pollIntervalSec;
const WEBHOOK_PORT = FACTORY_CONFIG.daemon.webhookPort;
const LOCAL_DIR = FACTORY_CONFIG.paths.localDir;
const WORKDIR = FACTORY_CONFIG.paths.workdir;
const DRY_RUN = args.dry || "";
const AGENT_MODE = "llm";
const WEBHOOK_SECRET = FACTORY_CONFIG.daemon.webhookSecret;
const RUN_TIMEOUT_MS = FACTORY_CONFIG.daemon.runTimeoutMs;
const MAX_CHILD_OUTPUT = 16 * 1024 * 1024;
const RECOVERY_SCHEDULER = new RecoveryScheduler({ stateDir: STATE_DIR,
  repository: FACTORY_GH_REPO || `fixture:${LOCAL_DIR || WORKDIR}`,
  baseDelayMs: FACTORY_CONFIG.daemon.infrastructureRetryBaseMs,
  maxDelayMs: FACTORY_CONFIG.daemon.infrastructureRetryMaxMs });
const loadedDaemonHash = recoveryHash(fsSync.readFileSync(fileURLToPath(import.meta.url), 'utf8'));
let noticeWriter;
const LEASE_OWNER = `${os.hostname()}:${process.pid}`;
/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T8.4.
 *
 * `freshness.skip.noul_yes_max` is read from
 * `runtime/decisions.yaml` (see T8.3) so operators can retune the
 * freshness `Noul` threshold without code changes. The file is
 * read once at startup with a tiny YAML 1.2 subset reader; any
 * parse failure or missing value falls back to the documented
 * `0.20` ceiling so a missing `decisions.yaml` does not silently
 * disable the optimisation.
 */
const FRESHNESS_NOUTH_YES_MAX = loadFreshnessNoulYesMax();
function loadFreshnessNoulYesMax() {
  const fallback = 0.20;
  const candidates = [
    path.resolve(factoryRoot, "runtime", "decisions.yaml"),
    path.resolve(process.cwd(), "runtime", "decisions.yaml"),
  ];
  for (const candidate of candidates) {
    try {
      const text = fsSync.readFileSync(candidate, "utf8");
      const match = text.match(/-\s*action:\s*freshness\.skip[\s\S]*?noul_yes_max:\s*([0-9.]+)/);
      if (match) {
        const parsed = Number.parseFloat(match[1]);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
          return parsed;
        }
      }
    } catch {}
  }
  return fallback;
}
/**
 * Spec `2026-09-20-decision-architecture` / Phase E / T11.1.
 *
 * Production-flip gate. Decision routing (the freshness `Noul` skip in
 * the polling loop, `judgment.skip` logs and the `daemon-tick` health
 * line) is LIVE BY DEFAULT — no opt-in flag is required. Operators who
 * need the pre-Phase-B behaviour set `FACTORY_DECISIONS_ENABLED=0`,
 * which bypasses the freshnessCheck step entirely and restores the
 * original `fetchNextIssue → enqueueIssue` flow (escape hatch per
 * plan.md R10). The daemon reads `process.env` directly here (after the
 * .env load above), so `runtime/agent-backends.mjs::agentWorkerEnvironment`
 * needs no change — the gate is a daemon-local decision, not a worker
 * credential/config forwarding concern.
 */
const DECISIONS_ENABLED = String(process.env.FACTORY_DECISIONS_ENABLED ?? "1") !== "0";
const LEASE_MANAGER = FACTORY_CONFIG.state.backend === "fixture" ? createFixtureLeaseManager() : createLeaseManager({
  stateDir: STATE_DIR,
  repository: FACTORY_GH_REPO,
  token: GH_TOKEN,
  defaultBranch: FACTORY_CONFIG.github.defaultBranch,
  staleMs: FACTORY_CONFIG.lease.staleMs,
  log,
});

/**
 * Build a minimal environment for a child process so we don't leak
 * the daemon's full process.env (which contains other services'
 * secrets — ANTHROPIC_AUTH_TOKEN, ARK_API_KEY, CODEX_API_KEY, etc. —
 * that the child has no business seeing).
 *
 * Pass-through list is conservative: only the variables the child
 * process needs to find its binaries, locate its config dir, and
 * authenticate against GitHub. Anything else stays in the parent.
 *
 * `extra` lets the caller layer on top — e.g. the LLM worker
 * receives `FACTORY_*` and `ANTHROPIC_*` because it actually uses
 * them. Use that route for additional variables that are scoped
 * to the child's purpose; do not fall back to `...process.env`.
 */
function buildChildEnv(command, extra = {}) {
  const env = {
    // Path resolution — without this the child can't find `gh.exe`.
    PATH: process.env.PATH ?? process.env.Path ?? "",
    // Tells `gh` where its config dir lives (~/.config/gh/).
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
    HOMEDRIVE: process.env.HOMEDRIVE ?? "",
    HOMEPATH: process.env.HOMEPATH ?? "",
    // Locale hints that don't carry secrets.
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "",
    TZ: process.env.TZ ?? "",
    // Windows-specific fundamentals the child's stdio / FFI may need.
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    WINDIR: process.env.WINDIR ?? "",
    TEMP: process.env.TEMP ?? process.env.TMP ?? "",
    TMP: process.env.TMP ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    PATHEXT: process.env.PATHEXT ?? "",
    OS: process.env.OS ?? "Windows_NT",
  };
  // `gh` reads only GH_TOKEN / GITHUB_TOKEN (or its own auth config).
  // It does NOT need any ANTHROPIC / ARK / CODEX / MOONSHOT keys, and
  // exposing them would (a) leak secrets to a less-trusted child and
  // (b) expand the env to a multi-KB blob that increases the
  // likelihood of Windows env-block-related TLS-handshake quirks.
  if (command === "gh" || command === "git") {
    if (GH_TOKEN) env.GH_TOKEN = GH_TOKEN;
    if (process.env.GITHUB_TOKEN) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }
  // `node` workers (the bundled orchestrator) read `TYPESAFE_API_KEY`
  // themselves — without it `runtime/typesafe-backend.mjs` short-circuits
  // to a no-api-key fallback BEFORE the per-role adapter (line 418), so
  // forwarding at the adapter layer isn't enough; the key must be in the
  // root env. `gh` children ignore this variable, but we keep it scoped to
  // `node` to honour the leak-guard's "explicit pass-through" rule.
  if (command === "node") {
    if (process.env.TYPESAFE_API_KEY) env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;
  }
  // Caller-provided extras win last so they can override defaults.
  return Object.assign(env, extra);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--interval") out.interval = Number(argv[++i]);
    else if (a === "--webhook-port") out.webhookPort = argv[++i];
    else if (a === "--local-dir") out.localDir = argv[++i];
    else if (a === "--workdir") out.workdir = argv[++i];
    else if (a === "--state-dir") out.stateDir = argv[++i];
    else if (a === "--dry-run") out.dry = argv[++i];
    else if (a === "--once") out.once = true;
    else if (a === "--daily") out.daily = true;
    else if (a === "--env-file") {
      // `--env-file path`, `--env-file=path`, or `--env-file -` to skip.
      const next = argv[i + 1];
      if (next === undefined) { out.envFile = ""; }
      else if (next.startsWith("=")) { out.envFile = next.slice(1); i++; }
      else { out.envFile = next; i++; }
    }
    else if (a === "--no-env-file") out.noEnvFile = true;
    else if (a === "--no-fallback-env") out.noFallbackEnv = true;
    else if (a === "--force") out.force = true;
  }
  return out;
}

/**
 * Search the system PATH for an executable. Returns the absolute path of
 * the first match, or null. Used to spawn .cmd / .bat on Windows without
 * invoking cmd.exe (which Node 22+ blocks without shell: true, and which
 * also produces a deprecation warning around argument escaping).
 */
function findOnPath(name) {
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = (process.env.PATH || "").split(sep).filter(Boolean);
  const pathext = (process.env.PATHEXT || "").split(";").map((s) => s.toLowerCase());
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      const st = fsSync.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {}
    if (process.platform === "win32") {
      // Try the bare name; on Windows, exec handles PATHEXT for .cmd/.exe.
      for (const ext of pathext) {
        const c2 = candidate + ext;
        try {
          const st = fsSync.statSync(c2);
          if (st.isFile()) return c2;
        } catch {}
      }
    }
  }
  return null;
}

/**
 * Returns null when there are no new issues.
 */
async function fetchNextIssue() {
  if (LOCAL_DIR) {
    return await fetchNextFromLocalDir();
  }
  if (FACTORY_GH_REPO && GH_TOKEN) {
    return await fetchNextFromGitHub();
  }
  return null;
}

async function fetchNextFromLocalDir() {
  if (!fsSync.existsSync(LOCAL_DIR)) return null;
  const entries = await fs.readdir(LOCAL_DIR);
  entries.sort();
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(LOCAL_DIR, name);
    const content = await fs.readFile(filePath, "utf-8");
    try {
      const issue = JSON.parse(content);
      if (!await allowRuntimeRecovery(issue, await readCurrentIssueState(issue.number))) continue;
      const processingDir = path.join(LOCAL_DIR, ".processing");
      await fs.mkdir(processingDir, { recursive: true });
      const claimedPath = path.join(processingDir, name);
      await fs.rename(filePath, claimedPath);
      issue._sourceFile = claimedPath;
      issue._sourceName = name;
      log("INFO", "picked-up-issue-from-local", { issue: issue.number, file: name });
      return issue;
    } catch (err) {
      log("WARN", "bad-issue-file", { file: name, error: String(err) });
      await fs.mkdir(path.join(LOCAL_DIR, ".failed"), { recursive: true });
      await fs.rename(filePath, path.join(LOCAL_DIR, ".failed", name)).catch(() => {});
    }
  }
  return null;
}

async function fetchNextFromGitHub() {
  // Phase A (gh 不稳定治理): the polling list goes through the undici
  // REST client (runtime/github-rest.mjs) instead of `gh issue list`.
  // On Windows the gh child reliably loses its TLS session to
  // api.github.com (GraphQL endpoint) after the daemon has been alive
  // for a few minutes — `Post ...graphql: EOF` — while a persistent
  // undici Agent keeps working. The REST /issues list carries only the
  // comment COUNT per issue, so full comment bodies are fetched
  // per-issue only when a decision could change (see below).
  let issues;
  try {
    issues = await listOpenIssues({
      token: GH_TOKEN,
      repository: FACTORY_GH_REPO,
      fields: ["number", "title", "body", "labels", "author", "createdAt", "state", "url", "comments"],
    });
    if (FACTORY_CONFIG.state.backend === 'github') {
      // Manual merges can auto-close the issue before its completion record is written.
      issues.push(...await listIssues({ token: GH_TOKEN, repository: FACTORY_GH_REPO,
        state: 'closed', labels: 'verified' }));
    }
  } catch (err) {
    const stack = err?.stack ? String(err.stack).split("\n").slice(0, 8).join(" | ") : null;
    log("WARN", "issue-list-failed", { error: String(err), transient: Boolean(err?.transient), stack });
    throw err;
  }
  if (!Array.isArray(issues)) {
    // Defensive: a non-array payload is a client bug, not an issue
    // state. Treat as empty rather than crashing on `issues.sort`.
    log("WARN", "issue-list-non-array", { type: typeof issues });
    return null;
  }
  // Sort by createdAt ascending so we process oldest first.
  issues.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (const issue of issues) {
    // `fetched-N` is a transient in-flight marker. Durable checkpoints,
    // issue content and workflow labels decide whether an issue needs work.
    const fetchedKey = `fetched-${issue.number}`;
    if (activeIssueClaims.has(issue.number)) continue;
    if (FACTORY_CONFIG.state.backend === 'fixture' && fsSync.existsSync(path.join(STATE_DIR, fetchedKey))) continue;
    const labelNames = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
    // Read the checkpoint first so the comment-fetch decision and the
    // needs-info branch below can consult it. Ordering matters: reading
    // `checkpoint` after any use crashes with a TDZ error (issue #22).
    const checkpoint = await readCurrentIssueState(issue.number);
    if (issue.state === 'closed' && (!checkpoint?.implementation?.commitSha
      || checkpoint.review?.verdict !== 'APPROVE'
      || checkpoint.reviewedSha !== checkpoint.implementation.commitSha
      || checkpoint.verifiedSha !== checkpoint.implementation.commitSha
      || checkpoint.implementation.behaviorVerification?.status !== 'verified')) continue;
    // Optional chaining short-circuits on null/undefined ONLY when the
    // left side is itself null/undefined, so we still need a top-level
    // null check on the checkpoint before reading `.issue`. Without this
    // guard, a first-time-seen issue crashes with "Cannot read
    // properties of null (reading 'issue')".
    const checkpointPending = checkpoint?.nextLabel === "needs-info";
    // F-XX (2026-09-17): a STALE `needs-info` GitHub label must not
    // park an issue whose checkpoint has already moved past needs-info.
    // Observed on issue #29: label sync once ran in a worker without
    // GH_TOKEN and silently skipped, leaving the label at needs-info
    // while the triage supervisor re-routed the checkpoint to
    // ready-to-implement. The old `labelNames.includes("needs-info")`
    // check then parked the issue on every poll (author comments
    // unchanged) and the pipeline could never resume. Parking is only
    // correct when the pipeline state itself agrees the issue waits on
    // the author: the checkpoint says needs-info (covers #12, where
    // syncLabel failed and the LABEL was missing), or there is no
    // checkpoint yet and only the label says so. A stale label with a
    // moved-on checkpoint falls through to picked-up, and the run's
    // syncLabel reconciles the label.
    const parkedNeedsInfo = checkpointPending
      || (labelNames.includes("needs-info") && !checkpoint);
    const checkpointComments = checkpoint ? normalizeIssueComments(checkpoint.issue?.comments) : [];
    // Fetch full comment bodies only when they could change a decision:
    //   - first time we see the issue (no checkpoint),
    //   - the REST comment count drifted from the checkpoint, or
    //   - the issue is parked at needs-info (label OR checkpoint).
    // F-XX (2026-09-15): for needs-info issues we cannot trust cached
    // comment sets — issue #12 sat parked for hours after the author
    // posted "all blockers resolved" because the cached count never
    // moved. Force a fresh fetch on every poll for parked issues.
    const needsFullComments = FACTORY_CONFIG.state.backend !== "github" && (!checkpoint
      || Number(issue.commentCount ?? 0) !== checkpointComments.length
      || parkedNeedsInfo);
    let comments = checkpointComments;
    if (needsFullComments && Number(issue.number) > 0) {
      try {
        const refreshed = await fetchIssueFromGitHub(issue.number);
        comments = normalizeIssueComments(refreshed.comments);
      } catch (error) {
        log("WARN", "comments-refresh-failed", {
          issue: issue.number,
          error: commandErrorText(error).split(/\r?\n/).filter(Boolean).at(-1) || String(error),
        });
      }
    }
    const currentHash = businessInputHash({ ...issue, labels: labelNames, comments });
    if (!await allowRuntimeRecovery({ ...issue, labels: labelNames, comments }, checkpoint)) continue;
    const unchanged = checkpoint && (FACTORY_CONFIG.state.backend === "github"
      ? checkpoint.lastJudgmentHash === currentHash
      : businessInputHash({ ...checkpoint.issue, number: issue.number, comments: checkpointComments }) === currentHash);
    const factoryLabels = labelNames.filter((label) => ACTIVE_FACTORY_LABELS.has(label));
    const retiredLabels = labelNames.filter((label) => RETIRED_FACTORY_LABELS.has(label));
    // Needs-info wake evaluation MUST run before the waiting-park
    // decision: needs-info is a triage-mapped label, so
    // shouldParkWaitingIssue would park it first and the wake-up
    // below would never be reached (issue #29 re-parked with the
    // author's reply already inside the checkpoint).
    //
    // Special case: an issue parked at `needs-info` MUST be re-triaged
    // when the author (or anyone else) posts a new comment, even if the
    // body is byte-identical. Skipping here is what stranded issue #3 in
    // a loop where the user had answered the follow-up questions in the
    // comments but the daemon kept polling the old (unchanged)
    // checkpoint.
    //
    // F-XX (2026-09-15): also re-triage when `checkpoint.nextLabel` says
    // `needs-info` even if the GitHub label is missing (syncLabel failed
    // once and left the label blank — issue #12 sat ignored because
    // author replies were invisible to the polling loop).
    //
    // F-XX (2026-09-17, issue #29): also wake when the newest
    // non-factory comment is the issue AUTHOR's voice even if the
    // comment count matches the checkpoint — the reply may already be
    // inside the checkpoint (saved by a run that crashed before
    // re-triaging). Mirrors the orchestrator's `latestVoiceIsAuthor`.
    // The wake is edge-triggered via a marker file keyed on the author
    // comment's createdAt so a triage that stays needs-info does not
    // re-wake every poll (no LLM busy-loop); the marker is removed by
    // releaseIssueClaim on a failed run so crashes retry the wake.
    let needsInfoWake = false;
    if (parkedNeedsInfo && unchanged) {
      // Author-voice detection must skip EVERY factory-marked comment,
      // not just the triage-marker ones that normalizeIssueComments
      // already dropped: the factory posts with the operator's token,
      // so a spec-review/pr-review comment has author == issue author
      // and the account-based check alone would misread the factory's
      // own REJECT post as an author reply (issue #29, 2026-09-17 —
      // false wake, orchestrator re-parked, marker consumed). Mirrors
      // FACTORY_COMMENT_MARKERS in src/core/factory-comments.ts.
      const latest = [...comments].reverse()
        .find((c) => !isFactoryComment(c));
      const authorLogin = typeof issue.author === "string" ? issue.author : issue.author?.login;
      const authorVoice = Boolean(latest && authorLogin && latest.author === authorLogin);
      const latestTime = latest?.createdAt ? Date.parse(latest.createdAt) : NaN;
      const triageTime = checkpoint?.lastTriageAt ? Date.parse(checkpoint.lastTriageAt) : NaN;
      const newAuthorEvent = authorVoice && Number.isFinite(latestTime)
        && (!Number.isFinite(triageTime) || latestTime > triageTime);
      const wakeFile = path.join(STATE_DIR, `needs-info-wake-${issue.number}`);
      let alreadyWoke = false;
      try {
        alreadyWoke = newAuthorEvent
          && FACTORY_CONFIG.state.backend === 'fixture'
          && fsSync.readFileSync(wakeFile, "utf8").trim() === String(latest?.createdAt ?? "");
      } catch {}
      if (newAuthorEvent && !alreadyWoke) {
        needsInfoWake = true;
        if (FACTORY_CONFIG.state.backend === 'fixture') {
          try { fsSync.writeFileSync(wakeFile, String(latest.createdAt)); } catch {}
        }
        log("INFO", "needs-info-comments-changed-retry", {
          issue: issue.number,
          previousComments: checkpointComments.length,
          currentComments: comments.length,
          authorVoice,
        });
      }
    }
    // F-XX (2026-09-17): park a waiting issue ONLY when it truly waits
    // for an external actor (needs-info / wait-to-implement, human merge
    // on verified, blocked verify-failed). A waiting exit with a runnable
    // stage label (e.g. the supervisor scheduling an implementation
    // retry via nextLabel=ready-to-implement) MUST be picked up again —
    // the old unconditional label-match park deadlocked issue #29.
    const legacyWaitNeedsRetriage = checkpoint?.status === "waiting"
      && checkpoint?.nextLabel === "wait-to-implement"
      && !checkpoint?.lastTriageAt;
    const missingOperatorNotice = checkpoint?.status === "waiting"
      && ["wait-to-implement", "verified", "verify-failed"].includes(checkpoint?.nextLabel)
      && !checkpoint?.wait?.note;
    let manualMergeObserved = false;
    if (checkpoint?.nextLabel === "verified"
        && checkpoint?.implementation?.prUrl && GH_TOKEN && FACTORY_GH_REPO) {
      const prNumber = /\/pull\/(\d+)(?:$|[/?#])/.exec(checkpoint.implementation.prUrl)?.[1];
      if (prNumber) {
        try {
          const pr = await fetchPullRequestRest({ token: GH_TOKEN, repository: FACTORY_GH_REPO, number: Number(prNumber) });
          const { canConfirmMergedImplementation } = await import('../runtime/completion-contract.mjs');
          manualMergeObserved = canConfirmMergedImplementation(checkpoint, pr, FACTORY_CONFIG.github.defaultBranch)
            && (!checkpoint.merged || issue.state === 'closed' || !unchanged);
          if (manualMergeObserved) log("INFO", "manual-pr-merge-observed", { issue: issue.number, pr: Number(prNumber) });
        } catch (error) {
          log("WARN", "manual-pr-merge-check-failed", { issue: issue.number, error: String(error).slice(0, 200) });
        }
      }
    }
    if (issue.state === 'closed' && !manualMergeObserved) continue;
    if (!needsInfoWake && !legacyWaitNeedsRetriage && !missingOperatorNotice && !manualMergeObserved && shouldParkWaitingIssue({
      checkpoint,
      factoryLabels,
      retiredLabels,
      unchanged,
      autoMerge: FACTORY_CONFIG.autoMerge,
    })) {
      continue;
    }
    log("INFO", "picked-up-issue-from-github", { issue: issue.number, title: issue.title });
    // Claim the issue for this poll cycle. processIssue() removes this
    // file if it fails so the next poll retries; on success it writes
    // the permanent `processed-N` marker instead.
    activeIssueClaims.add(issue.number);
    if (FACTORY_CONFIG.state.backend === 'fixture') fsSync.writeFileSync(path.join(STATE_DIR, fetchedKey), new Date().toISOString());
    // Materialize to a temp issue.json for the CLI.
    const issuePath = path.join(STATE_DIR, `issue-${issue.number}.json`);
    await fs.writeFile(issuePath, JSON.stringify({
      number: issue.number,
      title: issue.title,
      body: issue.body || "",
      labels: labelNames,
      author: issue.author?.login || "unknown",
      url: issue.url,
      createdAt: issue.createdAt,
      state: issue.state,
      comments,
    }, null, 2));
    // F-XX (2026-09-24, issue #46): the REST /issues list endpoint
    // returns `comments` as a count only — `runtime/github-rest.mjs`
    // normalises it to `[]`. When `needsFullComments` triggered a
    // per-issue fetch (or the checkpoint already carried the full
    // thread) `comments` holds the bodies. Without this spread the
    // downstream `freshnessCheck` sees an empty array, `latestVoiceIsAuthor`
    // returns false, and the author-voice override never fires —
    // silently parking the issue at `wait` even when the operator
    // just replied. The override at
    // `scripts/freshness-poc.mjs::freshnessCheck` requires
    // `issue.comments` to be populated end-to-end.
    return { ...issue, labels: labelNames, comments, _checkpoint: checkpoint, _issuePath: issuePath };
  }
  return null;
}

const ACTIVE_FACTORY_LABELS = new Set(ACTIVE_PIPELINE_LABELS);

// Cleanup-only labels from older versions. They wake the daemon so the
// orchestrator can remove them, but they never dispatch a pipeline stage.
const RETIRED_FACTORY_LABELS = new Set(RETIRED_PIPELINE_LABELS);

function normalizeIssueComments(comments) {
  return (comments || [])
    .map((comment) => ({
      author: comment.author?.login || comment.author || "unknown",
      body: comment.body || "",
      createdAt: comment.createdAt || "",
    }))
    .filter((comment) => !comment.body.includes("<!-- pi-software-factory:triage:"));
}

async function fetchIssueFromGitHub(number) {
  // Phase A: `gh issue view` (GraphQL) replaced by two REST calls
  // through the persistent undici client — same TLS-stability reason
  // as fetchNextFromGitHub.
  let issue;
  let comments;
  try {
    issue = await fetchIssueRest({ token: GH_TOKEN, repository: FACTORY_GH_REPO, number });
    comments = await listIssueCommentsRest({ token: GH_TOKEN, repository: FACTORY_GH_REPO, number });
  } catch (error) {
    throw new Error(`issue-view REST failed for #${number}: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  if (!issue || typeof issue !== "object" || issue.number == null) {
    throw new Error(`issue-view REST returned an unexpected payload for #${number} (got ${typeof issue})`);
  }
  // Mark the issue as freshly fetched so the downstream enqueueIssue does
  // NOT issue a second fetch for the same number.
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    labels: (issue.labels || []).map((label) => typeof label === "string" ? label : label.name),
    author: issue.author?.login || issue.author || "unknown",
    url: issue.url || "",
    createdAt: issue.createdAt || "",
    comments: normalizeIssueComments(comments),
    _fresh: true,
  };
}

function acquireDaemonLock() {
  const file = path.join(STATE_DIR, "daemon.pid");
  // The lock file's `startedAt` doubles as a TTL anchor. Even when a
  // process.kill(pid, 0) probe returns success on a dead pid
  // (Windows quirk where signal-0 sometimes returns without throwing
  // for pids that no longer exist), the stale lock can be reclaimed
  // by a fresh daemon once it's older than LOCK_STALE_MS. This avoids
  // a permanent "Another factory daemon owns ..." block when a previous
  // daemon was killed without releasing its lock.
  const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
  const record = { pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fsSync.writeFileSync(file, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      return { file, pid: process.pid };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let live = false;
      try {
        const existing = JSON.parse(fsSync.readFileSync(file, "utf8"));
        const startedAtMs = Date.parse(existing?.startedAt ?? "");
        const lockAgeMs = Date.now() - startedAtMs;
        // Two ways a stale lock can be reclaimed:
        //   1. The recorded pid is no longer running (cross-platform check
        //      via process.kill(pid, 0) — works on POSIX, unreliable on
        //      Windows but we still try).
        //   2. The lock is older than LOCK_STALE_MS. Belt-and-suspenders
        //      for the Windows case where the kill probe can return
        //      success on a dead pid and leave a permanent lock.
        let pidAlive = false;
        try {
          process.kill(existing.pid, 0);
          pidAlive = true;
        } catch (probe) {
          pidAlive = probe?.code === "EPERM";
        }
        if (pidAlive && Number.isFinite(lockAgeMs) && lockAgeMs < LOCK_STALE_MS) {
          live = true;
        } else {
          log("WARN", "daemon-lock-stale", {
            file,
            recordedPid: existing?.pid,
            recordedStartedAt: existing?.startedAt,
            lockAgeMs: Number.isFinite(lockAgeMs) ? lockAgeMs : null,
            pidAlive,
            reason: pidAlive ? "lock older than TTL — reclaiming" : "pid not running",
          });
        }
      } catch {}
      if (live) throw new Error(`Another factory daemon owns ${file}`);
      try { fsSync.unlinkSync(file); } catch {}
    }
  }
  throw new Error(`Cannot acquire daemon lock ${file}`);
}

function releaseDaemonLock(lock) {
  try {
    const current = JSON.parse(fsSync.readFileSync(lock.file, "utf8"));
    if (current.pid === lock.pid) fsSync.unlinkSync(lock.file);
  } catch {}
}

async function readCurrentIssueState(number) {
  return readIssueState(FACTORY_CONFIG, Number(number));
}

function runtimeRecoveryContext(issue, checkpoint) {
  const bundle = path.join(factoryRoot, 'dist', 'factory', 'run-issue.js');
  const entry = fsSync.existsSync(bundle) ? bundle : path.join(factoryRoot, 'src', 'cli', 'run-issue.ts');
  // No credentials or source text leave this process; only their digest is stored.
  const runtime = recoveryHash({ daemon: loadedDaemonHash, worker: fsSync.readFileSync(entry, 'utf8'), config: FACTORY_CONFIG });
  return recoveryHash({ input: businessInputHash(issue), runtime, revision: checkpoint?.revision ?? null,
    status: checkpoint?.status ?? null, nextLabel: checkpoint?.nextLabel ?? null,
    issueState: issue.state ?? 'open',
    fixtureProgress: FACTORY_CONFIG.state.backend === 'fixture' ? { ...checkpoint, issue: undefined } : undefined });
}

async function reportRuntimeRecovery(record) {
  if (!record || record.issueNumber < 1 || record.noticePublished || !GH_TOKEN || !FACTORY_GH_REPO) return;
  if (record.noticeAttemptedAt && Date.now() - Date.parse(record.noticeAttemptedAt)
      < FACTORY_CONFIG.daemon.infrastructureRetryBaseMs) return;
  record.noticeAttemptedAt = new Date().toISOString();
  await RECOVERY_SCHEDULER.write(record.issueNumber, record);
  try {
    noticeWriter ??= (await fetchAuthenticatedUser({ token: GH_TOKEN })).login;
    const notice = recoveryNotice(record, FACTORY_CONFIG.daemon.infrastructureRetryMaxMs);
    const options = { token: GH_TOKEN, repository: FACTORY_GH_REPO, number: record.issueNumber };
    const comments = await listIssueCommentsRest(options);
    // Observe before reposting: a lost POST response must not create another notice.
    if (!comments.some(comment => comment.author === noticeWriter && comment.body.includes(notice.marker))) {
      const id = await createIssueComment({ ...options, body: notice.body, maxRetries: 0 });
      if (!id) throw new Error('GitHub did not confirm the runtime recovery notice');
    }
    record.noticePublished = true;
    await RECOVERY_SCHEDULER.write(record.issueNumber, record);
  } catch (error) {
    log('WARN', 'runtime-recovery-notice-failed', { issue: record.issueNumber, error: String(error) });
  }
}

async function allowRuntimeRecovery(issue, checkpoint) {
  issue._recoveryContext = runtimeRecoveryContext(issue, checkpoint);
  const { allowed, record } = await RECOVERY_SCHEDULER.admission(Number(issue.number), issue._recoveryContext);
  if (!allowed) await reportRuntimeRecovery(record);
  return allowed;
}

async function recordRuntimeFailure(issue, failure) {
  // Bind to the state actually left by the failed worker, not its pre-run snapshot.
  let context = issue._recoveryContext ?? runtimeRecoveryContext(issue, undefined);
  try {
    const checkpoint = Number(issue.number) > 0 ? await readCurrentIssueState(issue.number) : undefined;
    const currentIssue = checkpoint?.issue ? { ...issue, ...checkpoint.issue } : issue;
    context = runtimeRecoveryContext(currentIssue, checkpoint);
  } catch (error) {
    log('WARN', 'runtime-recovery-state-unavailable', { issue: issue.number,
      consequence: 'admission uses last observed input, never a replacement workflow checkpoint', error: String(error) });
  }
  const record = await RECOVERY_SCHEDULER.failed(Number(issue.number), context, failure);
  issue._runtimeFailureRecorded = true;
  log('ERROR', 'runtime-recovery-scheduled', { issue: issue.number, failure, attempts: record.attempts,
    nextRetryAt: record.nextRetryAt, consequence: 'same-input worker admission paused; workflow state unchanged' });
  await reportRuntimeRecovery(record);
}

async function runNetworkCommand(command, commandArgs, options, operation, context = {}) {
  // No in-call retries: the polling loop itself is the retry mechanism.
  // A transient gh flake (EOF, TLS timeout, 5xx) that fails immediately
  // is retried on the next POLL_INTERVAL tick. Retrying here just
  // inflates a single tick's latency (the previous critical envelope
  // could block for ~33s per failed call) and defers progress on work
  // the daemon could already be doing. The `policy` field stays so log
  // lines and `assertSessionIdAvailable`-style error paths can still
  // distinguish the call's intent.
  const policy = context.policy ?? "critical";
  return runCommandWithRetry(command, commandArgs, options, { attempts: 1, policy });
}

async function prepareIssueWorktree(issueNumber, configuredBranch, configuredExplicitly) {
  fsSync.mkdirSync(WORKDIR, { recursive: true });
  let sourceRepo;
  if (FACTORY_GH_REPO && GH_TOKEN) {
    sourceRepo = path.join(WORKDIR, "repository");
    if (fsSync.existsSync(sourceRepo) && !isGitWorktree(sourceRepo)) {
      throw new Error(`Managed repository path exists but is not a git repository: ${sourceRepo}`);
    }
    if (!fsSync.existsSync(sourceRepo)) {
      log("INFO", "cloning-managed-repository", { repo: FACTORY_GH_REPO, dst: sourceRepo });
      await runNetworkCommand(
        "gh",
        ["repo", "clone", FACTORY_GH_REPO, sourceRepo],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: buildChildEnv("gh") },
        "gh-repo-clone",
        { repo: FACTORY_GH_REPO },
      ).catch((error) => {
        if (fsSync.existsSync(sourceRepo) && !isGitWorktree(sourceRepo)) {
          fsSync.rmSync(sourceRepo, { recursive: true, force: true });
        }
        throw error;
      });
      log("INFO", "managed-repository-cloned", { repo: FACTORY_GH_REPO, dst: sourceRepo });
    } else {
      await runNetworkCommand(
        "git",
        ["-C", sourceRepo, "fetch", "origin", "--prune"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: buildChildEnv("gh") },
        "git-fetch",
        { repo: FACTORY_GH_REPO },
      );
    }
  } else {
    sourceRepo = process.cwd();
    if (!isGitWorktree(sourceRepo)) {
      throw new Error(`Local issue mode requires the daemon working directory to be a git repository root: ${sourceRepo}`);
    }
  }

  const defaultBranch = detectDefaultBranch(sourceRepo, configuredBranch, configuredExplicitly);
  try {
    execFileSync("git", ["-C", sourceRepo, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    execFileSync("git", ["-C", sourceRepo, "symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], { stdio: "ignore" });
    execFileSync("git", ["-C", sourceRepo, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", sourceRepo, "-c", "user.email=factory@local", "-c", "user.name=local-factory", "commit", "--allow-empty", "-m", "Initial commit"], { stdio: "ignore" });
    if (FACTORY_GH_REPO && GH_TOKEN) {
      await runNetworkCommand(
        "git",
        ["-C", sourceRepo, "push", "-u", "origin", defaultBranch],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: buildChildEnv("gh") },
        "git-push-initial",
        { repo: FACTORY_GH_REPO, branch: defaultBranch },
      );
      log("INFO", "seeded-initial-commit", { issue: issueNumber, branch: defaultBranch, pushed: true });
    }
  }

  const issueWorkdir = await ensureIssueWorktree({
    workdir: WORKDIR,
    issueNumber,
    sourceRepo,
    defaultBranch,
    onEvent: (event, details) => log("INFO", event, details),
  });
  return { issueWorkdir, defaultBranch };
}

/**
 * Process one issue end-to-end. Reuses a stable git worktree for the issue,
 * invokes the factory CLI, and persists the outcome as state.
 */
async function processIssue(issue, stage = "", lease = null) {
  const startedAt = new Date().toISOString();
  const issuePath = issue._issuePath || path.join(STATE_DIR, `issue-${issue.number}.json`);
  // Refresh issue JSON on disk for the CLI.
  await fs.writeFile(issuePath, JSON.stringify({
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    labels: issue.labels || [],
    author: typeof issue.author === "string" ? issue.author : (issue.author?.login || "unknown"),
    url: issue.url || "",
    createdAt: issue.createdAt || new Date().toISOString(),
    comments: issue.comments || [],
  }, null, 2));

  const sourceRoot = fsSync.existsSync(path.join(factoryRoot, "factory", "src"))
    ? path.join(factoryRoot, "factory")
    : factoryRoot;
  let defaultBranch = FACTORY_CONFIG.github.defaultBranch;
  const userSetDefaultBranch = Boolean(process.env.FACTORY_DEFAULT_BRANCH);
  let issueWorkdir;
  try {
    ({ issueWorkdir, defaultBranch } = await prepareIssueWorktree(issue.number, defaultBranch, userSetDefaultBranch));
  } catch (error) {
    log("ERROR", "worktree-setup-failed", { issue: issue.number, error: commandErrorText(error) });
    await releaseIssueClaim(issue, false);
    throw error;
  }

  const FACTORY_TRUSTED_EXECUTION = FACTORY_CONFIG.execution.trusted ? "1" : "0";
  const FACTORY_SYNC_LABELS = FACTORY_CONFIG.syncLabels ? "1" : "0";
  const FACTORY_SYNC_PROJECTS = FACTORY_CONFIG.syncProjects ? "1" : "0";
  const ANTHROPIC_MAX_TOKENS = String(FACTORY_CONFIG.model.maxTokens);

  // The worker process is a first-class consumer of FACTORY_* and
  // ANTHROPIC_* (it runs the LLM agents), but it does NOT need the
  // daemon's other-service secrets (ARK / CODEX / MOONSHOT / etc. that
  // the user's shell happened to have). Build a minimal env that
  // carries only what the worker actually consumes.
  //
  // GH_TOKEN is the factory's own credential for the factory's repo —
  // the worker's orchestrator needs it for REST label sync, comments
  // and lease-adjacent writes (without it `syncLabel` silently skips
  // and GitHub labels drift from the checkpoint forever). The claude
  // child process never sees it: `agentWorkerEnvironment`'s whitelist
  // (commit 48cdd0e leak guard) stops at the worker boundary.
  //
  // FACTORY_AGENT_* carries the operator's backend selection
  // (backend id, per-role overrides, timeout, CLI command/model
  // overrides) so the worker resolves the SAME agent config the
  // operator wrote in .env instead of falling back to defaults.
  const AGENT_CONFIG_KEYS = [
    "FACTORY_AGENT_BACKEND", "FACTORY_AGENT_OVERRIDES", "FACTORY_AGENT_TIMEOUT_MS",
    "FACTORY_CLAUDE_COMMAND", "FACTORY_CLAUDE_MODEL",
    "FACTORY_CODEX_COMMAND", "FACTORY_CODEX_MODEL",
    "FACTORY_PI_COMMAND", "FACTORY_PI_MODEL",
  ];
  const agentConfigEnv = {};
  for (const key of AGENT_CONFIG_KEYS) {
    if (process.env[key]) agentConfigEnv[key] = process.env[key];
  }
  const env = buildChildEnv("node", {
    FACTORY_AGENT_MODE: AGENT_MODE, // legacy; factory runs in llm mode only
    FACTORY_DEFAULT_BRANCH: defaultBranch,
    FACTORY_STATE_DIR: STATE_DIR,
    FACTORY_LOCAL_DIR: LOCAL_DIR,
    FACTORY_ISSUE_LEASE_SHA: lease?.sha || "",
    FACTORY_STATE_WRITERS: FACTORY_CONFIG.state.writers.join(","),
    FACTORY_REMOTE_PATH: FACTORY_GH_REPO ? `https://github.com/${FACTORY_GH_REPO}.git` : "",
    FACTORY_GH_REPO,
    GH_TOKEN,
    ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
    ...agentConfigEnv,
    ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL,
    ANTHROPIC_MAX_TOKENS,
    FACTORY_TRUSTED_EXECUTION,
    FACTORY_SYNC_LABELS,
    FACTORY_SYNC_PROJECTS,
    FACTORY_AUTO_MERGE: FACTORY_CONFIG.autoMerge ? "1" : "0",
    FACTORY_REVIEW_DIR: FACTORY_CONFIG.paths.reviewDir,
    FACTORY_COMMAND_TIMEOUT_MS: String(FACTORY_CONFIG.limits.commandTimeoutMs),
    FACTORY_INFRA_RETRY_BASE_MS: String(FACTORY_CONFIG.daemon.infrastructureRetryBaseMs),
    FACTORY_INFRA_RETRY_MAX_MS: String(FACTORY_CONFIG.daemon.infrastructureRetryMaxMs),
    FACTORY_VERIFY_COMMAND: FACTORY_CONFIG.verify.command,
    FACTORY_VERIFY_URL: FACTORY_CONFIG.verify.url,
  });

  // Pipeline runner: prefer the bundled orchestrator that ships in
  // this package's dist/ (no tsx, no source copy). A development checkout
  // may run its source in place, while keeping the target workdir clean.
  const bundlePath = path.join(factoryRoot, "dist", "factory", "run-issue.js");
  const cliPath = path.join(sourceRoot, "src", "cli", "run-issue.ts");
  const tsxCandidates = [
    path.join(sourceRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(factoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  const tsxCli = tsxCandidates.find((p) => fsSync.existsSync(p)) || tsxCandidates[0];

  const runner = process.execPath;
  let runnerEntry;
  let runnerPrefixArgs = [];
  if (fsSync.existsSync(bundlePath)) {
    runnerEntry = bundlePath;
    log("INFO", "starting-pipeline", { issue: issue.number, runner: "bundle", file: bundlePath });
  } else if (fsSync.existsSync(cliPath)) {
    runnerEntry = tsxCli;
    runnerPrefixArgs = [cliPath];
    log("INFO", "starting-pipeline", { issue: issue.number, runner: "tsx", file: cliPath, tsx: tsxCli });
  } else {
    log("ERROR", "no-pipeline-runner", { bundlePath, cliPath, factoryRoot });
    await releaseIssueClaim(issue, false);
    throw Object.assign(new Error('No factory pipeline runner is installed'), { code: 'FACTORY_WORKER_RUNNER_MISSING' });
  }

  let stdout = "", stderr = "", runtimeFailure;
  const exitCode = await new Promise((resolve) => {
    const childArgs = [
      ...runnerPrefixArgs,
      "--issue", issuePath,
    ];
    if (stage) childArgs.push("--stage", stage);
    const dockerGit = FACTORY_CONFIG.execution.adapter === "docker"
      ? {
          issueGitDir: path.resolve(issueWorkdir, execFileSync("git", ["-C", issueWorkdir, "rev-parse", "--git-dir"], { encoding: "utf8" }).trim()),
          gitCommonDir: path.resolve(issueWorkdir, execFileSync("git", ["-C", issueWorkdir, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()),
        }
      : {};
    const child = spawnWorker({
      execution: FACTORY_CONFIG.execution,
      runner,
      entryPath: runnerEntry,
      args: childArgs,
      issueWorkdir,
      factoryRoot,
      stateDir: STATE_DIR,
      env,
      ...dockerGit,
    });
    const append = (current, chunk) => (current + chunk).slice(-MAX_CHILD_OUTPUT);
    // Tee every byte the child emits to daemon.log so lifecycle events
    // stream into the operator's view in real time, not only into the
    // 16 KB-stripped state-N.json stderr blob that gets discarded after
    // each run. The log() helper already serialises structured fields, so
    // we route the raw output through it as a child-stdout / child-stderr
    // event with the issue number for grep-ability.
    const logFile = path.join(STATE_DIR, "daemon.log");
    const tee = (stream, chunk) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        try {
          fsSync.appendFileSync(logFile, `${formatUtc8Timestamp()} INFO child-${stream} issue=${issue.number} ${line}\n`);
        } catch {}
      }
    };
    child.stdout.on("data", (b) => {
      stdout = append(stdout, b);
      tee("stdout", b);
    });
    child.stderr.on("data", (b) => {
      stderr = append(stderr, b);
      tee("stderr", b);
    });
    const timeout = setTimeout(() => {
      runtimeFailure = workerFailure(Object.assign(new Error('Pipeline execution budget exhausted'), { code: 'FACTORY_WORKER_TIMEOUT' }));
      stderr = append(stderr, `\npipeline exceeded ${RUN_TIMEOUT_MS}ms and was terminated\n`);
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      }
    }, RUN_TIMEOUT_MS);
    child.on("error", (error) => {
      runtimeFailure = workerFailure(error);
      clearTimeout(timeout);
      stderr += `failed to start pipeline: ${String(error)}\n`;
      resolve(1);
    });
    // Wait for the pipes to drain before parsing stdout or persisting stderr.
    child.on("close", (code, signal) => { clearTimeout(timeout); resolve(code ?? (signal ? 1 : 0)); });
  });

  let summary = {};
  try { summary = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)); } catch {}
  const pipeline = classifyPipelineOutcome(exitCode, summary, stage);
  if (!pipeline.executionOk) {
    const failure = runtimeFailure ?? (isWorkerFailure(summary.runtimeFailure) ? summary.runtimeFailure
      : workerFailure(Object.assign(new Error(`Worker exited ${exitCode} without a failure envelope`), { code: 'FACTORY_WORKER_EXIT' })));
    await recordRuntimeFailure(issue, failure);
  } else {
    await RECOVERY_SCHEDULER.clear(Number(issue.number));
  }

  const stateRecord = {
    number: issue.number,
    title: issue.title,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    outcome: pipeline.outcome,
    completed: pipeline.completed,
    workdir: issueWorkdir,
    summary,
    stdout: stdout.slice(-16_000),
    stderr: stderr.slice(-16_000),
  };
  const stateName = stage ? `state-${stage}.json` : `state-${issue.number}.json`;
  fsSync.writeFileSync(path.join(STATE_DIR, stateName), JSON.stringify(stateRecord, null, 2));
  if (pipeline.completed) {
    log("INFO", "pipeline-completed", { issue: issue.number, exitCode, summary });
  } else if (pipeline.executionOk) {
    log("WARN", "pipeline-waiting", { issue: issue.number, exitCode, outcome: pipeline.outcome, summary });
  } else {
    log("ERROR", "pipeline-failed", { issue: issue.number, exitCode, summary, stderr: stderr.slice(-4_000) });
  }

  // Release the transient claim after every run. Durable checkpoints and
  // the current GitHub state determine whether a later poll should resume.
  await releaseIssueClaim(issue, exitCode === 0);
  if (!stage) {
    const verdict = summary?.review?.verdict;
    if (verdict === "REJECT") {
      log("WARN", "issue-rejected-will-retry", {
        issue: issue.number,
        comments: summary?.review?.comments ?? null,
        branch: summary?.implementation?.branch ?? null,
      });
    }
    // Do not re-arm the same author reply if a later stage sends this
    // run back to needs-info; only a new reply should wake it again.
    if (FACTORY_CONFIG.state.backend === 'fixture') clearNeedsInfoWakeIfTriageAdvanced(STATE_DIR, issue.number, summary, log);
  }
  // Auto-cleanup: if the pipeline merged the implementation PR into
  // the default branch, the worktree is no longer needed. Pruning it
  // now keeps factory-workdir/ from accumulating one stale branch per
  // merged issue and lets the next issue for the same number start
  // from a clean checkout.
  if (summary?.merged && issueWorkdir) {
    try {
      const implBranch = summary?.implementation?.branch;
      const repoRoot = path.dirname(issueWorkdir);
      runCommandWithRetry(
        "git",
        ["-C", repoRoot, "worktree", "remove", "--force", issueWorkdir],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        { attempts: 2, baseDelayMs: 500, sleep: async () => {} },
      );
      if (implBranch) {
        runCommandWithRetry(
          "git",
          ["-C", repoRoot, "branch", "-D", implBranch],
          { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
          { attempts: 2, baseDelayMs: 500, sleep: async () => {} },
        ).catch(() => {});
      }
      log("INFO", "worktree-cleaned", { issue: issue.number, workdir: issueWorkdir, branch: implBranch });
    } catch (error) {
      log("WARN", "worktree-cleanup-failed", {
        issue: issue.number,
        workdir: issueWorkdir,
        error: commandErrorText(error),
      });
    }
  }
  return { ok: pipeline.executionOk, completed: pipeline.completed, outcome: pipeline.outcome, summary, stdout, stderr };
}

/**
 * Worker pool. Multiple issues may be ready at the same time (e.g.
 * two GitHub issues opened in the same poll, or a retry queued while
 * a new issue landed). Running them in parallel cuts wall time
 * roughly linearly up to the pool size.
 *
 * Each worker is a free function that pulls the next issue from
 * the shared queue. The default of 1 reproduces the legacy serial
 * behaviour. Issue leases remain the source of truth for who owns
 * what — if two polls race on the same issue, only one wins.
 */
const WORKER_POOL_SIZE = Math.max(1, FACTORY_CONFIG.daemon.workerPoolSize);
const workerIdle = [];
const workerQueue = [];

function enqueueIssue(issue, stage = "") {
  return new Promise((resolve, reject) => {
    workerQueue.push({ issue, stage, resolve, reject });
    dispatchWorker();
  });
}

function dispatchWorker() {
  while (workerIdle.length > 0 && workerQueue.length > 0) {
    const idle = workerIdle.pop();
    const job = workerQueue.shift();
    idle(job.resolve, job.reject, job.issue, job.stage);
  }
}

async function runWorker(resolve, reject, issue, stage) {
  let lease = null;
  let currentIssue = issue;
  // Track whether the inner finally successfully released the lease.
  // The outer catch must not double-release — review caught this as a
  // remaining correctness hazard after the F06 cleanup split.
  let leaseReleased = false;
  try {
    try {
      lease = await LEASE_MANAGER.acquire(Number(issue.number), LEASE_OWNER);
    } catch (acquireError) {
      // Network / GitHub failure during acquire is itself a wait
      // reason: the issue is not processable right now, but neither
      // is it lost. Record the wait so the panel and the next poll
      // both see a real reason instead of an empty "skipped" marker.
      log("WARN", "issue-lease-acquire-failed", {
        issue: issue.number,
        owner: LEASE_OWNER,
        error: acquireError?.message || String(acquireError),
      });
      try {
        await reportLeaseWait(Number(issue.number), {
          reason: "lease-network-failed",
          holder: null,
          staleReclaimEnabled: false,
          staleMs: null,
          expectedRecoveryAt: null,
          note: acquireError?.message ? String(acquireError.message).slice(0, 500) : null,
        });
      } catch (waitError) {
        log("WARN", "issue-lease-wait-record-failed", {
          issue: issue.number,
          error: waitError?.message || String(waitError),
        });
      }
      await releaseIssueClaim(issue, false);
      resolve({ ok: true, completed: false, outcome: "leased", skipped: true });
      return;
    }
    if (!lease) {
      log("INFO", "issue-lease-busy", { issue: issue.number, owner: LEASE_OWNER });
      // F07 fix: persist the wait reason so the next poll and the
      // panel know why this issue was skipped, including the
      // stale-reclaim ETA when available.
      //
      // Review follow-up: do not look up the holder inline. The busy
      // path already paid one `gh api` round-trip (the failed
      // acquire); paying a second one for holder attribution would
      // (a) double the network cost on every busy skip, and (b) risk
      // turning a "lease-busy" record into a "lease-network-failed"
      // record when GitHub hiccups. Operators who need the holder
      // identity can call `factory-lease list` directly.
      try {
        await reportLeaseWait(Number(issue.number), {
          reason: "lease-busy",
          holder: null,
          staleReclaimEnabled: Boolean(FACTORY_CONFIG.lease?.staleMs && FACTORY_CONFIG.lease.staleMs > 0),
          staleMs: typeof FACTORY_CONFIG.lease?.staleMs === "number" ? FACTORY_CONFIG.lease.staleMs : null,
          expectedRecoveryAt: null,
          note: null,
        });
      } catch (waitError) {
        log("WARN", "issue-lease-wait-record-failed", {
          issue: issue.number,
          error: waitError?.message || String(waitError),
        });
      }
      await releaseIssueClaim(issue, false);
      resolve({ ok: true, completed: false, outcome: "leased", skipped: true });
      return;
    }
    // Only refresh from GitHub when:
    //   - the caller didn't already fetch (issue._fresh flag), AND
    //   - the issue did NOT come from a local inbox pickup (issue._sourceFile), AND
    //   - we have GitHub credentials, AND
    //   - the caller is requesting the full pipeline (not a sub-stage), AND
    //   - this is a real GitHub issue (number > 0).
    // Otherwise we'd hit the API twice per webhook delivery, and worse,
    // a local-inbox issue whose number happens to match a real GitHub
    // issue would silently be replaced by the GitHub content.
    const isLocalPickup = Boolean(issue._sourceFile);
    const needsRefresh = !issue._fresh
      && !isLocalPickup
      && !stage
      && FACTORY_GH_REPO
      && GH_TOKEN
      && Number(issue.number) > 0;
    try {
      currentIssue = needsRefresh ? await fetchIssueFromGitHub(issue.number) : issue;
      const checkpoint = Number(currentIssue.number) > 0 ? await readCurrentIssueState(currentIssue.number) : undefined;
      if (!await allowRuntimeRecovery(currentIssue, checkpoint)) {
        await releaseIssueClaim(issue, false);
        resolve({ ok: true, completed: false, outcome: 'runtime-cooldown', skipped: true });
        return;
      }
      const result = await processIssue(currentIssue, stage, lease);
      // The content result is what callers (worker pool, panel,
      // webhook) care about. Releasing the lease is resource cleanup
      // — if it fails, that is a separate failure whose consequence
      // is "the lease lives on" (reclaimable by `staleMs`), not "the
      // pipeline was a failure". Resolve with the content result
      // FIRST, then run release as cleanup. A release error is
      // logged but does not flip `result.ok` — F06 fix.
      resolve(result);
    } finally {
      // Cleanup: release the lease regardless of the content outcome.
      // Wrap in try/catch so a release failure cannot mask the content
      // result the caller just received. The lease error is recorded
      // for the next poll / operator triage.
      try {
        await LEASE_MANAGER.release(lease);
        // Successful release: clear any pending wait record so the
        // next poll does not see a stale "still busy" entry. The
        // M5 receipt is the durable evidence that the external
        // effect was confirmed, separate from the in-memory outcome.
        leaseReleased = true; // F06 review fix: outer catch must NOT re-release.
      } catch (releaseError) {
        log("ERROR", "lease-release-after-content", {
          issue: issue.number,
          owner: LEASE_OWNER,
          error: releaseError?.message || String(releaseError),
          consequence: "lease remains; reclaim by staleMs or operator force-clear",
        });
        // M5: also record a failed receipt so the next poll / panel
        // sees the persistent reason without grepping logs.
        try {
          await recordOperationReceipt(STATE_DIR, Number(issue.number), "lease-release", {
            status: "unknown",
            owner: LEASE_OWNER,
            expectedSha: lease?.sha ?? null,
            observedSha: null,
            error: releaseError?.message ? String(releaseError.message).slice(0, 500) : "unknown",
            note: "release-after-content failed",
          });
        } catch {}
      }
    }
  } catch (error) {
    // Best-effort release for the rare case where acquire THREW
    // without first setting `lease` (the typed catch above already
    // resolved the busy / network cases). Skip if the inner finally
    // already attempted release — a second attempt on an already-
    // gone ref is exactly the "double-release" the review caught.
    if (lease && !leaseReleased) {
      try { await LEASE_MANAGER.release(lease); } catch {}
    }
    try {
      if (!currentIssue._runtimeFailureRecorded) await recordRuntimeFailure(currentIssue, workerFailure(error));
    } catch (journalError) {
      log('ERROR', 'runtime-recovery-journal-failed', { issue: issue.number, error: String(journalError),
        requiredAction: '需要你的操作：修复调度日志目录的磁盘或权限；不能忽略损坏的隔离记录。' });
    }
    await releaseIssueClaim(issue, false);
    reject(error);
  } finally {
    workerIdle.push(runWorker);
    dispatchWorker();
  }
}

for (let i = 0; i < WORKER_POOL_SIZE; i += 1) {
  workerIdle.push(runWorker);
}

/**
 * Poll-side backoff guard (F07, review follow-up).
 *
 * True when the issue has an active lease-wait record AND its
 * `expectedRecoveryAt` is still in the future. Used by the polling
 * loop to skip issues that were leased by another owner this tick;
 * the next poll will retry them once stale reclaim is allowed to
 * fire (or the holder releases). Returns false on any read error
 * (fail-open: we'd rather spin one extra round than wedge a queue).
 */
async function reportLeaseWait(issueNumber, record) {
  log("WARN", "issue-lease-wait", { issue: issueNumber, ...record,
    requiredAction: record.reason === "lease-network-failed"
      ? "需要你的操作：检查 GitHub 网络和凭据；租约尚未获得，未执行 worker。"
      : "租约由另一执行者持有；请等待，只有确认持有者已停止后才可清理租约。" });
}

async function isInLeaseCooldown(issueNumber) {
  const leases = await listGitHubLeases(FACTORY_CONFIG);
  return leases.some((lease) => lease.issueNumber === issueNumber && !lease.dead);
}

async function releaseIssueClaim(issue, succeeded) {
  activeIssueClaims.delete(issue.number);
  if (FACTORY_CONFIG.state.backend === 'fixture') {
    try { fsSync.unlinkSync(path.join(STATE_DIR, `fetched-${issue.number}`)); } catch {}
  }
  if (!succeeded && FACTORY_CONFIG.state.backend === 'fixture') {
    // Roll back the needs-info author-voice wake marker so a crashed
    // run can be re-woken by the same author comment on the next poll.
    try { fsSync.unlinkSync(path.join(STATE_DIR, `needs-info-wake-${issue.number}`)); } catch {}
  }
  if (!issue._sourceFile || !issue._sourceName) return;
  const destination = succeeded ? path.join(LOCAL_DIR, '.processed', issue._sourceName) : path.join(LOCAL_DIR, issue._sourceName);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(issue._sourceFile, destination).catch(() => {});
}

/**
 * When `--force` is set, sweep all currently-open issues and clear any
 * existing lease for them before the polling loop begins. This bypasses the
 * `FACTORY_LEASE_STALE_MS` threshold and any owner/PID check, so it is only
 * safe when the operator is certain they are the sole daemon on this repo.
 * Used to recover from orphaned locks after a `kill -9` / Ctrl+C.
 */
async function clearLeasesOnStartup() {
  if (!args.force) return;
  const leaseNumbers = new Set([0]);
  if (FACTORY_GH_REPO && GH_TOKEN) {
    try {
      // REST client has its own bounded retries; force-clear is
      // best-effort so a transient GitHub flake must not wedge the
      // daemon startup for minutes.
      const listed = await listOpenIssues({
        token: GH_TOKEN,
        repository: FACTORY_GH_REPO,
        fields: ["number"],
      });
      for (const { number } of listed) leaseNumbers.add(Number(number));
    } catch (error) {
      log("WARN", "force-clear-list-failed", { error: String(error) });
      return;
    }
  } else {
    const filenames = await fs.readdir(path.join(STATE_DIR, "leases")).catch(() => []);
    for (const filename of filenames) {
      const match = filename.match(/^issue-(\d+)\.lock$/);
      if (match) leaseNumbers.add(Number(match[1]));
    }
  }
  const cleared = [];
  const failed = [];
  for (const number of leaseNumbers) {
    try {
      await LEASE_MANAGER.clear(Number(number));
      cleared.push(Number(number));
    } catch (error) {
      failed.push({ number, error: String(error) });
    }
  }
  log("INFO", "force-clear-complete", {
    repo: FACTORY_GH_REPO,
    clearedCount: cleared.length,
    failedCount: failed.length,
    failed,
  });
}

async function maybeRunDailyImprovement(force = false) {
  const marker = path.join(STATE_DIR, "last-improve-review-pr");
  try {
    const lastRun = Date.parse(fsSync.readFileSync(marker, "utf-8").trim());
    if (!force && Number.isFinite(lastRun) && Date.now() - lastRun < 24 * 60 * 60 * 1000) {
      return { ok: true, skipped: true };
    }
  } catch {}

  const issue = {
    number: 0,
    title: "Daily review feedback improvement",
    body: "Inspect merged pull-request feedback from the last 24 hours and update review-pr only when a durable learning exists.",
    labels: [],
    author: "factory-daemon",
    url: "",
    createdAt: new Date().toISOString(),
  };
  if (!await allowRuntimeRecovery(issue, undefined)) return { ok: true, skipped: true, outcome: 'runtime-cooldown' };
  try {
    const result = await enqueueIssue(issue, "improve-review-pr");
    if (result?.ok && !result.skipped) fsSync.writeFileSync(marker, new Date().toISOString());
    return result;
  } catch (error) {
    log('WARN', 'daily-improvement-failed', { error: String(error), consequence: 'ordinary issue dispatch continues' });
    return { ok: false };
  }
}

// === Polling loop ===
async function pollingLoop() {
  log("INFO", "daemon-start", {
    repo: FACTORY_GH_REPO || "(local)",
    interval: POLL_INTERVAL,
    localDir: LOCAL_DIR,
    workdir: WORKDIR,
    once: args.once === true,
    force: args.force === true,
    agentMode: AGENT_MODE,
    executionAdapter: FACTORY_CONFIG.execution.adapter,
    trustedExecution: FACTORY_CONFIG.execution.trusted,
    autoMerge: FACTORY_CONFIG.autoMerge,
    llmBaseUrl: ANTHROPIC_BASE_URL || "(unset)",
    llmModel: ANTHROPIC_MODEL || "(unset)",
    freshnessNoulYesMax: FRESHNESS_NOUTH_YES_MAX,
    decisionsEnabled: DECISIONS_ENABLED,
  });
  if (args.force) await clearLeasesOnStartup();
  // No loop-level backoff: every tick that fails simply sleeps for one
  // POLL_INTERVAL before retrying. The pick-up cadence is the natural
  // retry mechanism, and exponential backoff here just delays recovery
  // for transient flakes that the next tick would resolve anyway.
  const retryDelay = () => POLL_INTERVAL * 1000;
  while (true) {
    try {
      const unresolvedOps = await findStaleInFlight(FACTORY_CONFIG);
      if (unresolvedOps.length) log("WARN", "external-ops-unresolved", { operations: unresolvedOps });
      // Run the daily improvement check on every loop tick — the function
      // itself short-circuits when its 24h cooldown hasn't elapsed, so an
      // always-busy issue queue never starves the review feedback loop.
      await maybeRunDailyImprovement();
      // Drain ALL ready issues this tick so the worker pool can run
      // them in parallel. fetchNextIssue() returned one issue at a
      // time, which starved the worker pool — when two issues were
      // ready at the same time one waited for the other to finish
      // before the daemon even saw it.
      //
      // T8.4 freshness `Noul` PoC: each fetched issue passes through
      // `freshnessCheck(issue, ...)` between `fetchNextIssue()` and
      // `enqueueIssue(issue)`. The check is best-effort: every
      // failure mode maps to `{ skip: false, reason: "freshness_unavailable" }`
      // so the existing `enqueueIssue` path runs unchanged. Per-issue
      // outcomes are aggregated into `freshnessOutcomes` so the
      // `daemon-tick` log line below can attach the composite
      // `health` (skip-rate is the Phase B MVP proxy for the four
      // dimensions when the underlying scores are not yet available).
      const readyIssues = [];
      const freshnessOutcomes = [];
      while (true) {
        const issue = await fetchNextIssue();
        if (!issue) break;
        // F07 fix (review follow-up): if this issue has an active
        // lease-wait record with `expectedRecoveryAt` still in the
        // future, skip it for this tick. Without this guard the
        // daemon happily pays the GitHub fetch + the lease-acquire
        // call on every poll, which is the "ok: true 持续抢取同一
        // issue" busy-spin the plan calls out. The wait record is
        // cleared on successful acquire or release, so a stale
        // record always means "still busy".
        if (await isInLeaseCooldown(issue.number)) {
          log("DEBUG", "lease-wait-skip", { issue: issue.number });
          continue;
        }
        // Freshness `Noul` PoC (T8.4). Wrap in try/catch so an
        // unexpected throw never poisons the loop — the module's
        // contract is "never throws", but a future bug should not
        // crash the daemon. Any error maps to "freshness unavailable"
        // and the existing enqueue path runs.
        //
        // T11.1 production flip: the whole freshnessCheck step is
        // gated by `FACTORY_DECISIONS_ENABLED` (default 1). When the
        // operator opts out with `=0` the issue goes straight to
        // `readyIssues` — the original pre-Phase-B enqueue path with
        // no `judgment.skip` evaluation and no freshness outcomes.
        if (!DECISIONS_ENABLED) {
          readyIssues.push(issue);
          continue;
        }
        const judgmentStage = judgmentResumeStage(issue._checkpoint);
        if (judgmentStage) {
          log("INFO", "judgment.recovery", { issue: issue.number, stage: judgmentStage,
            reason: issue._checkpoint.wait?.reason ?? "missing-independent-judgment" });
          freshnessOutcomes.push({ issue: issue.number, skipped: false, unavailable: false });
          readyIssues.push({ ...issue, __resumeStage: judgmentStage });
          continue;
        }
        let freshnessResult;
        try {
          freshnessResult = await freshnessCheck(issue, {
            checkpoint: issue._checkpoint ?? await readCurrentIssueState(issue.number),
            stateDir: STATE_DIR,
            threshold: FRESHNESS_NOUTH_YES_MAX,
            env: process.env,
            fetchImpl: globalThis.fetch,
          });
        } catch (error) {
          log("WARN", "freshness-check-threw", {
            issue: issue.number,
            error: error instanceof Error ? error.message : String(error),
          });
          freshnessResult = { skip: false, reason: "freshness_unavailable", stateHash: "", noul_yes: 0 };
        }
        freshnessOutcomes.push({
          issue: issue.number,
          skipped: freshnessResult.skip === true,
          unavailable: freshnessResult.reason === "freshness_unavailable",
        });
        if (freshnessResult.skip) {
          // Spec T11.3: state_unchanged used to be a blanket skip and
          // permanently stranded issues whose labels had been reset
          // without any of the 5 freshness hash fields moving (issue
          // #43's `ready-to-spec` reset after EXECUTOR_CRASH). The
          // resume-decision primitive (`scripts/freshness-poc.mjs::
          // decideResumeStage`) now tags the `skip: true` envelope
          // with a stage hint. The daemon only stays parked when the
          // hint is `wait` — every other stage is treated as "label
          // says resume, enqueue to that stage".
          if (freshnessResult.reason === "state_unchanged") {
            const resumeStage = freshnessResult.resumeStage ?? "triage";
            if (resumeStage === "wait") {
              log("INFO", "judgment.skip", {
                issue: issue.number,
                reason: "state_unchanged",
                resumeStage,
                resumeReason: freshnessResult.resumeReason ?? null,
                confidence: freshnessResult.confidence ?? null,
                stateHash: freshnessResult.stateHash,
                noul_yes: freshnessResult.noul_yes,
                threshold: FRESHNESS_NOUTH_YES_MAX,
              });
              continue;
            }
            log("INFO", "judgment.resume", {
              issue: issue.number,
              resumeStage,
              resumeReason: freshnessResult.resumeReason ?? null,
              confidence: freshnessResult.confidence ?? null,
              stateHash: freshnessResult.stateHash,
            });
            readyIssues.push({ ...issue, __resumeStage: resumeStage });
            continue;
          }
          log("INFO", "judgment.skip", {
            issue: issue.number,
            reason: freshnessResult.reason,
            stateHash: freshnessResult.stateHash,
            noul_yes: freshnessResult.noul_yes,
            threshold: FRESHNESS_NOUTH_YES_MAX,
          });
          continue;
        }
        // Author-voice override (issue #46, 2026-09-24): the freshness
        // hash matched the previous judgment but the most recent comment
        // is non-factory voice. The polling layer bypassed
        // `decideResumeStage` and asked the daemon to re-triage. Log a
        // dedicated line so operators can grep override firings (the
        // `stateHash` is the new hash already persisted by
        // `freshnessCheck`).
        if (freshnessResult.reason === "author_voice_override") {
          log("INFO", "judgment.author-voice-override", {
            issue: issue.number,
            stateHash: freshnessResult.stateHash,
          });
        }
        readyIssues.push(issue);
      }
      // Freshness skip-rate is throughput telemetry, not a quality score.
      // Until stage-quality measurements exist, report health as unknown.
      if (DECISIONS_ENABLED) {
        const freshnessStats = summariseFreshness(freshnessOutcomes);
        const isIdle = freshnessOutcomes.length === 0;
        log("INFO", "daemon-tick", {
          fetched: freshnessOutcomes.length,
          skipped: freshnessStats.skipped,
          fresh: freshnessStats.fresh,
          unavailable: freshnessStats.unavailable,
          skippedRate: freshnessStats.skippedRate,
          health: null,
          threshold: FRESHNESS_NOUTH_YES_MAX,
          idle: isIdle,
        });
      }
      if (readyIssues.length > 0) {
        for (const issue of readyIssues) {
          log("INFO", "process-issue-start", { issue: issue.number });
        }
        // Fire-and-forget enqueue so all worker slots get a job in
        // the same tick. We still await each promise below so the
        // process-issue-end log lands in order.
        //
        // Resume hints wake the complete workflow, not standalone agent
        // invocations. The orchestrator owns stage transitions, verification,
        // merging and completion under the persisted checkpoint contract.
        const promises = readyIssues.map((issue) => {
          const tagged = typeof issue?.__resumeStage === "string" ? issue.__resumeStage : "";
          const cleaned = tagged ? { ...issue } : issue;
          if (tagged) delete cleaned.__resumeStage;
          const dispatch = enqueueIssue(cleaned);
          return dispatch.then(
            (result) => ({ issue: issue.number, result }),
            (error) => ({ issue: issue.number, error }),
          );
        });
        for (const outcome of await Promise.all(promises)) {
          if (outcome.error) {
            log("ERROR", "process-issue-failed", {
              issue: outcome.issue,
              error: String(outcome.error),
              stack: outcome.error?.stack ? String(outcome.error.stack).split("\n").slice(0, 5).join(" | ") : null,
              retryInMs: POLL_INTERVAL * 1000,
            });
            continue;
          }
          const result = outcome.result;
          // Surface the review verdict so REJECT is visible in daemon.log
          // (not masked by exitCode===0). The CLI's stdout ends with a
          // JSON summary; `summary.review.comments` is the count (number),
          // not an array — see src/cli/run-issue.ts:90.
          const review = result?.summary?.review ?? null;
          const verdict = review?.verdict ?? null;
          const comments = typeof review?.comments === "number" ? review.comments : null;
          const merged = Boolean(result?.summary?.merged);
          const level = !result?.ok ? "ERROR" : result?.completed ? "INFO" : "WARN";
          log(level, "process-issue-end", {
            issue: outcome.issue,
            ok: result?.ok,
            completed: result?.completed,
            outcome: result?.outcome,
            status: result?.summary?.status ?? null,
            nextLabel: result?.summary?.nextLabel ?? null,
            verify: result?.summary?.verify ?? null,
            verdict,
            comments,
            merged,
          });
          if (args.once) return result?.ok ? 0 : 1;
          if (!result?.ok) await sleep(POLL_INTERVAL * 1000);
        }
      } else {
        if (args.once) return 0;
        await sleep(POLL_INTERVAL * 1000);
      }
    } catch (err) {
      const delayMs = retryDelay();
      log("ERROR", "loop-error", { error: String(err), retryInMs: delayMs });
      if (args.once) return 1;
      await sleep(delayMs);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// === Webhook server ===
async function startWebhookServer() {
  if (!WEBHOOK_PORT) return;
  if (!WEBHOOK_SECRET) throw new Error("FACTORY_WEBHOOK_SECRET is required when webhook mode is enabled");
  if (!FACTORY_GH_REPO || !GH_TOKEN) throw new Error("FACTORY_GH_REPO and GH_TOKEN are required when webhook mode is enabled");
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/webhook")) {
      res.writeHead(404); res.end(); return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (Buffer.byteLength(body) > 1024 * 1024) req.destroy();
    });
    req.on("end", async () => {
      try {
        const signature = String(req.headers["x-hub-signature-256"] || "");
        const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
        if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
          res.writeHead(401); res.end(); return;
        }
        const delivery = String(req.headers["x-github-delivery"] || "");
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(delivery)) { res.writeHead(400); res.end(); return; }
        const deliveryFile = path.join(STATE_DIR, `delivery-${delivery}`);
        try { fsSync.writeFileSync(deliveryFile, new Date().toISOString(), { flag: "wx" }); }
        catch { res.writeHead(202); res.end(JSON.stringify({ ok: true, duplicate: true })); return; }
        const event = req.headers["x-github-event"];
        const payload = JSON.parse(body || "{}");
        const userComment = event === "issue_comment" && payload.action === "created" && payload.comment?.user?.type === "User";
        if ((event === "issues" && ["opened", "edited", "labeled", "unlabeled"].includes(payload.action)) || userComment) {
          const issueNumber = Number(payload.issue?.number);
          if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error("Webhook payload has no valid issue number");
          log("INFO", "webhook-issue-queued", { number: issueNumber, event });
          void fetchIssueFromGitHub(issueNumber)
            .then((issue) => enqueueIssue(issue))
            .catch((error) => log("ERROR", "webhook-pipeline-failed", { issue: issueNumber, error: String(error) }));
        }
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log("ERROR", "webhook-error", { error: String(err) });
        res.writeHead(500);
        res.end();
      }
    });
  });
  server.listen(WEBHOOK_PORT, () => {
    log("INFO", "webhook-listening", { port: WEBHOOK_PORT });
  });
}

// === Main ===
(async () => {
  if (!GH_TOKEN) log("WARN", "no-gh-token", {});
  if (!ANTHROPIC_AUTH_TOKEN) log("WARN", "no-anthropic-token", {});
  if (AGENT_MODE === "llm" && !LLM_CONFIGURED) throw new Error("Real agent mode requires ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL and ANTHROPIC_MODEL");

  // Sweep transient fetched-* markers left by a prior crashed daemon.
  let cleared = 0;
  try {
    const entries = FACTORY_CONFIG.state.backend === 'fixture' ? fsSync.readdirSync(STATE_DIR) : [];
    for (const name of entries) {
      if (!name.startsWith("fetched-")) continue;
      // Only consider fetched-* whose daemon mtime doesn't match a
      // running process; simplest heuristic: drop the marker entirely
      // on a fresh start. processIssue will re-create it immediately.
      try { fsSync.unlinkSync(path.join(STATE_DIR, name)); cleared++; } catch {}
    }
  } catch {}
  if (cleared > 0) log("INFO", "cleared-stale-fetched-markers", { cleared });

  if (args.daily) {
    const result = await maybeRunDailyImprovement(true);
    process.exitCode = result?.ok ? 0 : 1;
    return;
  }

  if (WEBHOOK_PORT) await startWebhookServer();
  const exitCode = await pollingLoop();
  if (args.once) process.exitCode = exitCode;
})();
