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
import { resolveFactoryConfig } from "../runtime/factory-config.mjs";
import { ACTIVE_PIPELINE_LABELS, RETIRED_PIPELINE_LABELS } from "../runtime/pipeline-definition.mjs";
import { spawnWorker } from "../runtime/worker-executor.mjs";
import { createLeaseManager } from "../runtime/lease-manager.mjs";
import {
  LEASE_WAIT_REASONS,
  clearLeaseWait,
  computeExpectedRecoveryAt,
  readLeaseWait,
  recordLeaseWait,
} from "../runtime/lease-wait-state.mjs";
import {
  commandErrorText,
  detectDefaultBranch,
  ensureIssueWorktree,
  formatUtc8Timestamp,
  isGitWorktree,
  isTransientNetworkError,
  loopBackoffMs,
  runCommandWithRetry,
} from "./daemon-support.mjs";

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
fsSync.mkdirSync(STATE_DIR, { recursive: true });
const DAEMON_LOCK = acquireDaemonLock();
process.on("exit", () => releaseDaemonLock(DAEMON_LOCK));

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

  // (2) gh CLI fallback for GH_TOKEN.
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
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
const NETWORK_RETRY_ATTEMPTS = 3;
const NETWORK_RETRY_BASE_DELAY_MS = 1_000;
const LEASE_OWNER = `${os.hostname()}:${process.pid}`;
const LEASE_MANAGER = createLeaseManager({
  stateDir: STATE_DIR,
  repository: FACTORY_GH_REPO,
  token: GH_TOKEN,
  defaultBranch: FACTORY_CONFIG.github.defaultBranch,
  staleMs: FACTORY_CONFIG.lease.staleMs,
  log,
});

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
  try {
    const out = await runNetworkCommand("gh", [
      "issue", "list",
      "--repo", FACTORY_GH_REPO,
      "--state", "open",
      "--json", "number,title,body,labels,author,createdAt,url,comments",
      "--limit", "1000",
    ], { encoding: "utf-8", env: { ...process.env, GH_TOKEN } }, "gh-issue-list");
    let issues;
    try {
      issues = JSON.parse(out);
    } catch (error) {
      // gh occasionally writes a partial / non-JSON payload to stdout on
      // transport hiccups before execFileSync raises. Treat as "no issues
      // this poll" rather than crashing the daemon with a parse error.
      log("WARN", "gh-issue-list-parse-failed", {
        error: String(error),
        preview: String(out).slice(0, 200),
      });
      return null;
    }
    if (!Array.isArray(issues)) {
      // gh sometimes returns a literal `null` or object on transient API
      // failures. Treat as empty rather than crashing on `issues.sort`.
      log("WARN", "gh-issue-list-non-array", { type: typeof issues });
      return null;
    }
    // Sort by createdAt ascending so we process oldest first.
    issues.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const issue of issues) {
      // `fetched-N` is a transient in-flight marker. Durable checkpoints,
      // issue content and workflow labels decide whether an issue needs work.
      const fetchedKey = `fetched-${issue.number}`;
      if (fsSync.existsSync(path.join(STATE_DIR, fetchedKey))) continue;
      const labelNames = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
      let comments = normalizeIssueComments(issue.comments);
      // `gh issue list` doesn't always return comments reliably — sometimes
      // the field is omitted, sometimes comments posted after the issue was
      // created are dropped. When the issue has a body (likely a real
      // conversation) but no comments came back from list, fall back to a
      // per-issue `gh issue view` so the triage agent sees the full thread.
      // Issue #3 was stranded for hours because list returned `comments: []`
      // even after the author posted two clarifying replies.
      if (comments.length === 0 && issue.body && issue.body.length > 0 && Number(issue.number) > 0) {
        try {
          const refreshed = await fetchIssueFromGitHub(issue.number);
          comments = normalizeIssueComments(refreshed.comments);
        } catch (error) {
          log("WARN", "comments-fallback-view-failed", {
            issue: issue.number,
            error: commandErrorText(error).split(/\r?\n/).filter(Boolean).at(-1) || String(error),
          });
        }
      }
      const checkpoint = await readCheckpoint(issue.number);
      // Optional chaining short-circuits on null/undefined ONLY when the
      // left side is itself null/undefined, so we still need a top-level
      // null check on the checkpoint before reading `.issue`. Without this
      // guard, a first-time-seen issue crashes with "Cannot read
      // properties of null (reading 'issue')".
      const checkpointComments = checkpoint ? normalizeIssueComments(checkpoint.issue?.comments) : [];
      const unchanged = checkpoint && JSON.stringify([
        checkpoint.issue?.body || "",
        checkpointComments,
      ]) === JSON.stringify([issue.body || "", comments]);
      const factoryLabels = labelNames.filter((label) => ACTIVE_FACTORY_LABELS.has(label));
      const retiredLabels = labelNames.filter((label) => RETIRED_FACTORY_LABELS.has(label));
      if (checkpoint?.status === "waiting" && !checkpoint.error && unchanged &&
          retiredLabels.length === 0 && checkpoint.nextLabel && factoryLabels.length === 1 && factoryLabels[0] === checkpoint.nextLabel) {
        continue;
      }
      // Special case: an issue parked at `needs-info` MUST be re-triaged when
      // the author (or anyone else) posts a new comment, even if the body is
      // byte-identical. Skipping here is what stranded issue #3 in a loop
      // where the user had answered the follow-up questions in the comments
      // but the daemon kept polling the old (unchanged) checkpoint.
      if (labelNames.includes("needs-info") && unchanged) {
        const commentsChanged = checkpointComments.length !== comments.length;
        if (!commentsChanged) continue;
        log("INFO", "needs-info-comments-changed-retry", {
          issue: issue.number,
          previousComments: checkpointComments.length,
          currentComments: comments.length,
        });
      }
      log("INFO", "picked-up-issue-from-github", { issue: issue.number, title: issue.title });
      // Claim the issue for this poll cycle. processIssue() removes this
      // file if it fails so the next poll retries; on success it writes
      // the permanent `processed-N` marker instead.
      fsSync.writeFileSync(path.join(STATE_DIR, fetchedKey), new Date().toISOString());
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
        comments,
      }, null, 2));
      return { ...issue, _issuePath: issuePath };
    }
  } catch (err) {
    const stack = err?.stack ? String(err.stack).split("\n").slice(0, 8).join(" | ") : null;
    log("WARN", "gh-issue-list-failed", { error: String(err), stack });
    throw err;
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
  const out = await runNetworkCommand("gh", [
    "issue", "view", String(number),
    "--repo", FACTORY_GH_REPO,
    "--json", "number,title,body,labels,author,createdAt,url,comments",
  ], { encoding: "utf-8", env: { ...process.env, GH_TOKEN } }, "gh-issue-view", { issue: number });
  let issue;
  try {
    issue = JSON.parse(out);
  } catch (error) {
    throw new Error(`gh-issue-view returned non-JSON for #${number}: ${String(error).slice(0, 120)} (preview: ${String(out).slice(0, 120)})`);
  }
  if (!issue || typeof issue !== "object" || issue.number == null) {
    throw new Error(`gh-issue-view returned an unexpected payload for #${number} (got ${typeof issue})`);
  }
  // Mark the issue as freshly fetched so the downstream enqueueIssue does
  // NOT issue a second `gh issue view` for the same number.
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    labels: (issue.labels || []).map((label) => typeof label === "string" ? label : label.name),
    author: issue.author?.login || issue.author || "unknown",
    url: issue.url || "",
    createdAt: issue.createdAt || "",
    comments: normalizeIssueComments(issue.comments),
    _fresh: true,
  };
}

function acquireDaemonLock() {
  const file = path.join(STATE_DIR, "daemon.pid");
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
        process.kill(existing.pid, 0);
        live = true;
      } catch (probe) {
        live = probe?.code === "EPERM";
      }
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

async function readCheckpoint(number) {
  try {
    return JSON.parse(await fs.readFile(path.join(STATE_DIR, 'issues', `${number}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function runNetworkCommand(command, commandArgs, options, operation, context = {}) {
  // Default to "critical" — every gh call from the daemon is on the
  // pipeline's hot path, and losing one to a transient GraphQL flake
  // strands the issue for the next poll cycle. Standard-policy callers
  // can opt out by passing `policy: "standard"` in `context`.
  const policy = context.policy ?? "critical";
  return runCommandWithRetry(command, commandArgs, options, {
    attempts: NETWORK_RETRY_ATTEMPTS,
    baseDelayMs: NETWORK_RETRY_BASE_DELAY_MS,
    policy,
    onRetry: ({ attempt, nextAttempt, delayMs, error, policy: policyName }) => {
      log("WARN", "transient-network-retry", {
        operation,
        policy: policyName,
        ...context,
        attempt,
        nextAttempt,
        delayMs,
        error: commandErrorText(error).split(/\r?\n/).filter(Boolean).at(-1) || String(error),
      });
    },
  });
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
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_TOKEN } },
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
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_TOKEN } },
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
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_TOKEN } },
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
async function processIssue(issue, stage = "") {
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

  const env = {
    ...process.env,
    FACTORY_AGENT_MODE: AGENT_MODE, // legacy; factory runs in llm mode only
    FACTORY_DEFAULT_BRANCH: defaultBranch,
    FACTORY_STATE_DIR: STATE_DIR,
    FACTORY_REMOTE_PATH: FACTORY_GH_REPO ? `https://github.com/${FACTORY_GH_REPO}.git` : "",
    FACTORY_GH_REPO,
    GH_TOKEN,
    ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL,
    ANTHROPIC_MAX_TOKENS,
    FACTORY_TRUSTED_EXECUTION,
    FACTORY_SYNC_LABELS,
    FACTORY_SYNC_PROJECTS,
    FACTORY_AUTO_MERGE: FACTORY_CONFIG.autoMerge ? "1" : "0",
  };

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
    return null;
  }

  let stdout = "", stderr = "";
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
      stderr = append(stderr, `\npipeline exceeded ${RUN_TIMEOUT_MS}ms and was terminated\n`);
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      }
    }, RUN_TIMEOUT_MS);
    child.on("error", (error) => {
      stderr += `failed to start pipeline: ${String(error)}\n`;
      resolve(1);
    });
    // Wait for the pipes to drain before parsing stdout or persisting stderr.
    child.on("close", (code, signal) => { clearTimeout(timeout); resolve(code ?? (signal ? 1 : 0)); });
  });

  let summary = {};
  try { summary = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)); } catch {}
  const pipeline = stage
    ? { executionOk: exitCode === 0, completed: exitCode === 0, outcome: exitCode === 0 ? "completed" : "failed" }
    : classifyPipelineOutcome(exitCode, summary);

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
  if (!stage) {
    await releaseIssueClaim(issue, exitCode === 0);
    const verdict = summary?.review?.verdict;
    if (verdict === "REJECT") {
      log("WARN", "issue-rejected-will-retry", {
        issue: issue.number,
        comments: summary?.review?.comments ?? null,
        branch: summary?.implementation?.branch ?? null,
      });
    }
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
        // Delete the remote lease ref so the next poll does not
        // re-acquire a stale lease.
        await LEASE_MANAGER.clear(issue.number).catch(() => {});
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
        await recordLeaseWait(STATE_DIR, Number(issue.number), {
          reason: LEASE_WAIT_REASONS.network,
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
        await recordLeaseWait(STATE_DIR, Number(issue.number), {
          reason: LEASE_WAIT_REASONS.busy,
          holder: null,
          staleReclaimEnabled: Boolean(FACTORY_CONFIG.lease?.staleMs && FACTORY_CONFIG.lease.staleMs > 0),
          staleMs: typeof FACTORY_CONFIG.lease?.staleMs === "number" ? FACTORY_CONFIG.lease.staleMs : null,
          expectedRecoveryAt: computeExpectedRecoveryAt(new Date().toISOString(), FACTORY_CONFIG.lease?.staleMs ?? null),
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
      const currentIssue = needsRefresh ? await fetchIssueFromGitHub(issue.number) : issue;
      const result = await processIssue(currentIssue, stage);
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
        // next poll does not see a stale "still busy" entry.
        await clearLeaseWait(STATE_DIR, Number(issue.number)).catch(() => {});
        leaseReleased = true; // F06 review fix: outer catch must NOT re-release.
      } catch (releaseError) {
        log("ERROR", "lease-release-after-content", {
          issue: issue.number,
          owner: LEASE_OWNER,
          error: releaseError?.message || String(releaseError),
          consequence: "lease remains; reclaim by staleMs or operator force-clear",
        });
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
async function isInLeaseCooldown(issueNumber) {
  let record;
  try {
    record = await readLeaseWait(STATE_DIR, issueNumber);
  } catch {
    return false;
  }
  if (!record) return false;
  const eta = record.expectedRecoveryAt;
  if (!eta) return false; // no recovery ETA — let the next attempt decide
  const etaMs = Date.parse(eta);
  if (!Number.isFinite(etaMs)) return false;
  return etaMs > Date.now();
}

async function releaseIssueClaim(issue, succeeded) {
  try { fsSync.unlinkSync(path.join(STATE_DIR, `fetched-${issue.number}`)); } catch {}
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
      // Standard (not critical) policy so a transient GitHub flake
      // doesn't make force-clear hang the daemon for 5+ minutes — the
      // critical retries are reserved for operations on the live issue
      // pipeline where losing one matters. force-clear is best-effort.
      const out = await runNetworkCommand("gh", [
        "issue", "list",
        "--repo", FACTORY_GH_REPO,
        "--state", "open",
        "--json", "number",
        "--limit", "1000",
      ], { encoding: "utf-8", env: { ...process.env, GH_TOKEN } }, "gh-issue-list-force", { policy: "standard", timeoutMs: "short" });
      for (const { number } of JSON.parse(out)) leaseNumbers.add(Number(number));
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

  const result = await enqueueIssue({
    number: 0,
    title: "Daily review feedback improvement",
    body: "Inspect merged pull-request feedback from the last 24 hours and update review-pr only when a durable learning exists.",
    labels: [],
    author: "factory-daemon",
    url: "",
    createdAt: new Date().toISOString(),
  }, "improve-review-pr");
  if (result?.ok) fsSync.writeFileSync(marker, new Date().toISOString());
  return result;
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
  });
  if (args.force) await clearLeasesOnStartup();
  let consecutiveNetworkFailures = 0;
  // Circuit breaker: after NETWORK_BREAKER_THRESHOLD consecutive transient
  // failures within NETWORK_BREAKER_WINDOW_MS, the daemon stops polling for
  // NETWORK_BREAKER_COOLDOWN_MS and emits an ERROR. This prevents the
  // "fake-alive" failure mode where the daemon spins on `gh issue list` EOF
  // every 30s without making any progress. Issue #3 stayed parked for hours
  // partly because of this — the process was running but never advanced.
  const NETWORK_BREAKER_WINDOW_MS = 5 * 60 * 1000;
  const NETWORK_BREAKER_THRESHOLD = 5;
  const NETWORK_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;
  const networkFailureTimestamps = [];
  const recordNetworkFailure = (error) => {
    networkFailureTimestamps.push(Date.now());
    while (networkFailureTimestamps.length && Date.now() - networkFailureTimestamps[0] > NETWORK_BREAKER_WINDOW_MS) {
      networkFailureTimestamps.shift();
    }
  };
  const retryDelay = (error) => {
    const transient = Boolean(error?.factoryTransientNetworkFailure) || isTransientNetworkError(error);
    if (!transient) {
      consecutiveNetworkFailures = 0;
      networkFailureTimestamps.length = 0;
      return POLL_INTERVAL * 1000;
    }
    consecutiveNetworkFailures++;
    recordNetworkFailure(error);
    if (networkFailureTimestamps.length >= NETWORK_BREAKER_THRESHOLD) {
      log("ERROR", "network-circuit-breaker-tripped", {
        consecutiveNetworkFailures: networkFailureTimestamps.length,
        windowMs: NETWORK_BREAKER_WINDOW_MS,
        cooldownMs: NETWORK_BREAKER_COOLDOWN_MS,
      });
      networkFailureTimestamps.length = 0;
      return NETWORK_BREAKER_COOLDOWN_MS;
    }
    return loopBackoffMs(consecutiveNetworkFailures, POLL_INTERVAL * 1000);
  };
  while (true) {
    try {
      // Run the daily improvement check on every loop tick — the function
      // itself short-circuits when its 24h cooldown hasn't elapsed, so an
      // always-busy issue queue never starves the review feedback loop.
      await maybeRunDailyImprovement();
      // Drain ALL ready issues this tick so the worker pool can run
      // them in parallel. fetchNextIssue() returned one issue at a
      // time, which starved the worker pool — when two issues were
      // ready at the same time one waited for the other to finish
      // before the daemon even saw it.
      const readyIssues = [];
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
        readyIssues.push(issue);
      }
      consecutiveNetworkFailures = 0;
      if (readyIssues.length > 0) {
        for (const issue of readyIssues) {
          log("INFO", "process-issue-start", { issue: issue.number });
        }
        // Fire-and-forget enqueue so all worker slots get a job in
        // the same tick. We still await each promise below so the
        // process-issue-end log lands in order.
        const promises = readyIssues.map((issue) =>
          enqueueIssue(issue).then(
            (result) => ({ issue: issue.number, result }),
            (error) => ({ issue: issue.number, error }),
          ),
        );
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
      const delayMs = retryDelay(err);
      log("ERROR", "loop-error", { error: String(err), retryInMs: delayMs, consecutiveNetworkFailures });
      if (args.once) return 1;
      await sleep(delayMs);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Belt + suspenders. processIssue does multiple await execFileSync calls
// and remote ops that can throw; without these handlers the daemon would
// silently exit on unhandled rejections (especially under Windows where
// the worker thread exits before its log buffer flushes).
process.on("unhandledRejection", (reason) => {
  try { log("ERROR", "unhandled-rejection", { error: String(reason) }); } catch {}
  process.exitCode = 1;
});
process.on("uncaughtException", (err) => {
  try { log("ERROR", "uncaught-exception", { error: String(err) }); } catch {}
  process.exitCode = 1;
});

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
    const entries = fsSync.readdirSync(STATE_DIR);
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
