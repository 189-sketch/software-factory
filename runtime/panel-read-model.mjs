import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { resolveFactoryConfig } from "./factory-config.mjs";
import { AGENT_ROLES, UI_STAGE_IDS, uiStageForInternalStage } from "./pipeline-definition.mjs";
import { listLeaseWaits } from "./lease-wait-state.mjs";

const exec = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;

const SHARED_PANEL_ENV_KEYS = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_MAX_TOKENS",
  "ANTHROPIC_MAX_RETRIES",
  "FACTORY_MODEL_ADAPTER",
  "FACTORY_MODEL_CONTEXT_WINDOW",
  "FACTORY_LLM_TIMEOUT_MS",
]);

const AGENT_ROLE_BY_ID = new Map(AGENT_ROLES.map((role) => [role.id, role]));

async function readText(file) {
  try { return await fs.readFile(file, "utf8"); } catch { return null; }
}

async function readJson(file) {
  const text = await readText(file);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function listDir(directory) {
  try { return await fs.readdir(directory); } catch { return []; }
}

function parseDotEnv(text) {
  const values = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function repositoryFromPackage(pkg) {
  const value = pkg?.repository;
  if (typeof value === "string") return value;
  return value?.url || "";
}

function normalizedProjectId(value) {
  return String(value || "project").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "project";
}

async function loadProject(root, input, isCurrent) {
  const projectRoot = path.resolve(root, input.root || ".");
  const dotenv = parseDotEnv(await readText(path.join(projectRoot, ".factory-daemon", ".env")));
  const sharedEnv = Object.fromEntries(
    SHARED_PANEL_ENV_KEYS
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const env = isCurrent ? { ...dotenv, ...process.env } : { ...dotenv, ...sharedEnv };
  const config = resolveFactoryConfig({ env, cwd: projectRoot });
  const pkg = await readJson(path.join(projectRoot, "package.json"));
  const repository = input.repo || config.github.repository || repositoryFromPackage(pkg) || "unconfigured";
  return {
    id: isCurrent ? "current" : String(input.id || normalizedProjectId(repository || path.basename(projectRoot))),
    name: String(input.name || path.basename(projectRoot)),
    repo: String(repository),
    defaultBranch: String(input.defaultBranch || config.github.defaultBranch),
    isCurrent,
    root: projectRoot,
    config,
  };
}

async function loadProjects(root) {
  const registry = await readJson(path.join(root, ".factory", "projects.json"));
  const projects = [await loadProject(root, {}, true)];
  const ids = new Set(["current"]);
  for (const entry of Array.isArray(registry?.projects) ? registry.projects : []) {
    if (!entry || typeof entry !== "object") continue;
    const project = await loadProject(root, entry, false);
    if (ids.has(project.id)) throw new Error(`Duplicate panel project id: ${project.id}`);
    ids.add(project.id);
    projects.push(project);
  }
  return projects;
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    repo: project.repo,
    defaultBranch: project.defaultBranch,
    isCurrent: project.isCurrent,
  };
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function projectStages(stages = {}) {
  const projected = {};
  for (const [internalStage, record] of Object.entries(stages)) {
    const uiStage = uiStageForInternalStage(internalStage);
    if (!uiStage || !record || typeof record !== "object") continue;
    const previous = projected[uiStage];
    projected[uiStage] = {
      ...previous,
      ...record,
      startedAt: !previous?.startedAt || timestamp(record.startedAt) < timestamp(previous.startedAt)
        ? record.startedAt
        : previous.startedAt,
      endedAt: timestamp(record.endedAt) >= timestamp(previous?.endedAt)
        ? record.endedAt
        : previous?.endedAt,
    };
  }
  return projected;
}

async function stateDocuments(project) {
  const directory = path.join(project.config.paths.stateDir, "issues");
  const documents = [];
  for (const name of await listDir(directory)) {
    if (!name.endsWith(".json")) continue;
    const document = await readJson(path.join(directory, name));
    if (document?.issue?.number) documents.push(document);
  }
  return documents;
}

function projectIssue(document, leaseWait) {
  const projected = { ...document, stages: projectStages(document.stages) };
  // Plan §3.2 / M6: the panel must answer "why is this issue
  // waiting?" without grepping three log files. `leaseWait` is the
  // raw `LeaseWaitRecord` written by `recordLeaseWait`; when present
  // the UI surfaces the holder, blockedAt, and next-attempt-at
  // alongside the persisted issue document.
  if (leaseWait) projected.leaseWait = leaseWait;
  // T10.0 (additive): Decision 6 composite health + band, per-stage
  // typesafe confidence keyed on run id, and per-stage CJK fallback
  // badges. `health` / `healthBand` are null until the four dimension
  // scores are persisted; confidence entries expose null rather than
  // inventing data. Existing consumers ignore the new fields.
  const signals = deriveIssueSignals(document);
  projected.health = signals.health;
  projected.healthBand = signals.healthBand;
  projected.stageConfidence = signals.stageConfidence;
  projected.fallbackBadges = signals.fallbackBadges;
  return projected;
}

async function discoveredIssues(project) {
  if (!project.repo || project.repo === "unconfigured") return [];
  try {
    const env = project.config.github.token
      ? { ...process.env, GH_TOKEN: project.config.github.token }
      : process.env;
    const { stdout } = await exec("gh", [
      "issue", "list", "--repo", project.repo, "--state", "open", "--limit", "50",
      "--json", "number,title,body,author,createdAt,url,labels",
    ], { timeout: 5_000, env });
    return JSON.parse(stdout).map((issue) => ({ _discovered: true, issue }));
  } catch {
    return [];
  }
}

function emptyMetrics() {
  return { merged7d: 0, rejected30d: 0, approved30d: 0, avgTimeToMergeMs: null, started24h: 0, closed24h: 0 };
}

function computeMetrics(documents, now = Date.now()) {
  const metrics = emptyMetrics();
  const mergeDurations = [];
  for (const document of documents) {
    const stages = projectStages(document.stages);
    const triageStart = stages.triage?.startedAt;
    const mergeEnd = stages.merge?.endedAt;
    if (mergeEnd && now - timestamp(mergeEnd) <= 7 * DAY_MS) metrics.merged7d++;
    if (triageStart && mergeEnd && timestamp(mergeEnd) >= timestamp(triageStart)) {
      mergeDurations.push(timestamp(mergeEnd) - timestamp(triageStart));
    }
    const reviewEnd = stages.review?.endedAt;
    if (reviewEnd && now - timestamp(reviewEnd) <= 30 * DAY_MS) {
      if (document.review?.verdict === "REJECT") metrics.rejected30d++;
      if (document.review?.verdict === "APPROVE") metrics.approved30d++;
    }
    for (const stage of UI_STAGE_IDS) {
      if (stages[stage]?.startedAt && now - timestamp(stages[stage].startedAt) <= DAY_MS) metrics.started24h++;
      if (stages[stage]?.endedAt && now - timestamp(stages[stage].endedAt) <= DAY_MS) metrics.closed24h++;
    }
  }
  if (mergeDurations.length) {
    metrics.avgTimeToMergeMs = Math.round(mergeDurations.reduce((sum, value) => sum + value, 0) / mergeDurations.length);
  }
  return metrics;
}

function parseDaemonEvents(text, projectId) {
  const events = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const match = raw.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, ts, rawLevel, internalStage, rest] = match;
    const brace = rest.indexOf("{");
    let bindings = {};
    let message = rest;
    if (brace >= 0) {
      message = rest.slice(0, brace).trim();
      try { bindings = JSON.parse(rest.slice(brace)); } catch {}
    }
    const uiStage = uiStageForInternalStage(internalStage);
    events.push({
      id: `${projectId}:daemon:${ts}:${events.length}`,
      ts,
      level: ["INFO", "WARN", "ERROR"].includes(rawLevel) ? rawLevel : "INFO",
      stage: uiStage || "system",
      projectId,
      message: message || internalStage,
      bindings: uiStage && uiStage !== internalStage ? { ...bindings, internalStage } : bindings,
    });
  }
  return events;
}

function checkpointEvents(documents, projectId) {
  const events = [];
  for (const document of documents) {
    for (const event of Array.isArray(document.events) ? document.events : []) {
      const internalStage = String(event.stage || "system");
      const uiStage = uiStageForInternalStage(internalStage) || "system";
      const ts = event.endedAt || event.startedAt || document.issue?.createdAt || "";
      events.push({
        id: `${projectId}:issue-${document.issue.number}:${internalStage}:${ts}:${events.length}`,
        ts,
        level: event.status === "failed" ? "ERROR" : "INFO",
        stage: uiStage,
        projectId,
        message: `${internalStage} ${event.status || "updated"}`,
        bindings: {
          issue: document.issue.number,
          internalStage,
          ...(event.verdict ? { verdict: event.verdict } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
        },
      });
    }
  }
  return events;
}

function parseFrontmatter(body, fallbackName) {
  const frontmatter = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1] || "";
  const field = (name) => frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim() || "";
  const tags = field("tags").replace(/^\[|\]$/g, "").split(",").map((tag) => tag.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  return { name: field("name") || fallbackName, description: field("description"), tags };
}

async function sourceAgents(root, model) {
  const agents = [];
  for (const directory of await listDir(path.join(root, "skills"))) {
    const meta = AGENT_ROLE_BY_ID.get(directory);
    if (!meta) continue;
    const body = await readText(path.join(root, "skills", directory, "SKILL.md"));
    if (!body) continue;
    const frontmatter = parseFrontmatter(body, meta.label);
    agents.push({ id: meta.id, stage: meta.stage, label: frontmatter.name, skillPath: `skills/${directory}/SKILL.md`, skillBody: body, description: frontmatter.description, tags: frontmatter.tags, mode: "llm", model, enabled: true });
  }
  return agents;
}

async function bundledAgents(root, model) {
  const agents = [];
  const directory = path.join(root, "dist", "factory", "skills");
  for (const filename of await listDir(directory)) {
    if (!filename.endsWith(".json")) continue;
    const data = await readJson(path.join(directory, filename));
    const meta = AGENT_ROLE_BY_ID.get(data?.id);
    if (!meta) continue;
    agents.push({ id: meta.id, stage: meta.stage, label: meta.label, skillPath: `skills/${data.id}/SKILL.md`, skillBody: data.body || "", description: data.description || "", tags: data.tags || [], mode: "llm", model, enabled: true });
  }
  return agents;
}

// ---------------------------------------------------------------------------
// Operational judgments D1–D5 (spec `2026-09-20-decision-architecture`, T9.3).
//
// requirements.md §"Decision Inventory → D" defines five operational
// judgments the daemon cycle makes:
//
//   D1 pipeline bottleneck stage  — `Score`
//   D2 systemic-failure signal    — `Noul`
//   D3 operator escalation needed — `Noul`
//   D4 backpressure trigger       — `Noul` × 3
//   D5 skill suggestion           — `Choice`
//
// The panel is a READ MODEL: it never performs typesafe HTTP calls. The
// typesafe primitives for D1–D5 are consumed on the daemon side; here we
// derive the same five judgments deterministically from data already in
// the read model (stage durations, failure events, labels, lease waits).
//
// `scoreOperationalJudgments(readModel)` is the SINGLE SEAM: a future
// typesafe-backed scorer replaces this one function (or wraps it) without
// touching the aggregation method or any consumer. All fields added to the
// read model by T9.3 are additive.
// ---------------------------------------------------------------------------

/** Tunable thresholds for the deterministic D1–D5 derivations. */
export const OPERATIONAL_JUDGMENT_THRESHOLDS = Object.freeze({
  /** D2: minimum distinct issues sharing one failure class to fire. */
  systemicFailureMinIssues: 3,
  /** D2/D4: failure events older than this window are ignored. */
  failureWindowMs: 7 * DAY_MS,
  /** D3: a `needs-info` issue idle longer than this is a stall. */
  escalationStallMs: 2 * DAY_MS,
  /** D4 signal 1: queued (dispatchable) issues at/above this fire. */
  queueDepthMax: 5,
  /** D4 signal 2: concurrent lease-wait records at/above this fire. */
  leaseSaturationMax: 3,
  /** D4 signal 3: consecutive failed events at/above this fire. */
  failureStreakMax: 3,
});

/**
 * D5 fallback map: `cookbooks/skill_suggestion.md` does not exist in this
 * repository yet, so the `Choice` is derived from this static map
 * (requirements.md D5 row: "hard-coded"). Rules are matched against the
 * dominant failure class first, then against the failing UI stage.
 */
export const SKILL_SUGGESTION_RULES = Object.freeze([
  { pattern: /contract|spec/i, skill: "skills/spec/SKILL.md" },
  { pattern: /policy|user[_-]?input|needs[_-]?info/i, skill: "skills/triage/SKILL.md" },
  { pattern: /review/i, skill: "skills/review-pr/SKILL.md" },
  { pattern: /verif|behavio/i, skill: "skills/verify-behavior/SKILL.md" },
  { pattern: /implement|build|test/i, skill: "skills/implementation/SKILL.md" },
  { pattern: /reasoning|transient|permanent/i, skill: "skills/improve-review-pr/SKILL.md" },
]);

export const SKILL_SUGGESTION_BY_STAGE = Object.freeze({
  triage: "skills/triage/SKILL.md",
  spec: "skills/spec/SKILL.md",
  implementation: "skills/implementation/SKILL.md",
  review: "skills/review-pr/SKILL.md",
  verify: "skills/verify-behavior/SKILL.md",
  merge: "skills/improve-review-pr/SKILL.md",
});

const QUEUE_LABELS = new Set([
  "ready-to-spec", "ready-to-implement", "review-needed",
  "ready-to-merge", "verified", "changes-requested", "verify-failed",
]);

const ESCALATION_PATTERN = /escalat|operator|needs[_-]?info/i;

function round2(value) {
  return Math.round(value * 100) / 100;
}

function labelNames(issue) {
  return (Array.isArray(issue?.labels) ? issue.labels : [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string" && name)
    .map((name) => name.toLowerCase());
}

function normalizedFailureClass(value, fallback) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || fallback;
}

/**
 * Collect the failure classes attributed to one issue document, from
 * (a) `events[]` entries with `status: "failed"`, (b) the persisted
 * `failureCounts` map (stage → FailureClass → attempts) and (c)
 * `lastFailure.class`. Classes from failed events fall back to
 * `<uiStage>-failed` when no reason is recorded.
 */
function issueFailureClasses(document, windowStart, now) {
  const classes = [];
  for (const event of Array.isArray(document.events) ? document.events : []) {
    if (event?.status !== "failed") continue;
    const ts = timestamp(event.endedAt || event.startedAt);
    if (ts && (ts < windowStart || ts > now)) continue;
    const uiStage = uiStageForInternalStage(String(event.stage || "")) || "system";
    classes.push(normalizedFailureClass(event.reason || event.class, `${uiStage}-failed`));
  }
  const counts = document.failureCounts;
  if (counts && typeof counts === "object") {
    for (const [stage, byClass] of Object.entries(counts)) {
      if (!byClass || typeof byClass !== "object") continue;
      const uiStage = uiStageForInternalStage(stage) || "system";
      for (const [failureClass, attempts] of Object.entries(byClass)) {
        if (Number(attempts) > 0) classes.push(normalizedFailureClass(failureClass, `${uiStage}-failed`));
      }
    }
  }
  if (document.lastFailure?.class) classes.push(normalizedFailureClass(document.lastFailure.class, "unknown-failed"));
  return classes;
}

function lastActivityAt(document) {
  let latest = 0;
  for (const stage of Object.values(document.stages || {})) {
    latest = Math.max(latest, timestamp(stage?.startedAt), timestamp(stage?.endedAt));
  }
  for (const event of Array.isArray(document.events) ? document.events : []) {
    latest = Math.max(latest, timestamp(event?.endedAt || event?.startedAt));
  }
  latest = Math.max(latest, timestamp(document.issue?.updatedAt), timestamp(document.issue?.createdAt));
  return latest;
}

function isDone(document) {
  return Boolean(document.stages?.merge?.endedAt);
}

function suggestSkill(failureClass, stage) {
  for (const rule of SKILL_SUGGESTION_RULES) {
    if (rule.pattern.test(String(failureClass || ""))) return rule.skill;
  }
  return SKILL_SUGGESTION_BY_STAGE[stage] || null;
}

/**
 * Deterministic derivation of the five operational judgments (D1–D5)
 * from an already-materialised read-model snapshot.
 *
 * SINGLE SEAM (T9.3): the panel path must never perform typesafe HTTP
 * calls; when a typesafe-backed scorer lands it replaces (or wraps)
 * this function only. The input is plain data:
 *
 * @param {{ issues?: any[], leaseWaits?: any[] }} readModel
 *        `issues`   — projected issue documents (as returned by
 *                     `model.issues(projectId)`, persisted entries).
 *        `leaseWaits` — LeaseWaitRecord entries (listLeaseWaits).
 * @param {{ now?: number, thresholds?: Record<string, number> }} [options]
 *        `now` is injectable for deterministic tests.
 * @returns {{
 *   source: string,
 *   d1PipelineBottleneck: { stage: string | null, score: number, perStage: Record<string, any> },
 *   d2SystemicFailure: { triggered: boolean, failureClass: string | null, issueCount: number, issues: number[], threshold: number },
 *   d3OperatorEscalation: { triggered: boolean, issues: number[], reasons: Record<number, string> },
 *   d4Backpressure: { triggered: boolean, triggeredCount: number, signals: Record<string, any> },
 *   d5SkillSuggestion: { choice: string | null, failureClass: string | null, options: string[], source: string },
 * }}
 */
export function scoreOperationalJudgments(readModel, options = {}) {
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const thresholds = { ...OPERATIONAL_JUDGMENT_THRESHOLDS, ...(options.thresholds || {}) };
  const documents = (Array.isArray(readModel?.issues) ? readModel.issues : [])
    .filter((document) => document?.issue?.number)
    .map((document) => ({ ...document, stages: projectStages(document.stages || {}) }));
  const leaseWaits = Array.isArray(readModel?.leaseWaits) ? readModel.leaseWaits : [];
  const windowStart = now - thresholds.failureWindowMs;

  // ---- D1 — pipeline bottleneck stage (Score) ----------------------------
  // Per UI stage: mean duration across issues that ran it, and a failure
  // rate from failed events. score = 0.6 × latency (normalised against the
  // slowest stage) + 0.4 × failure rate; the bottleneck is the argmax,
  // ties broken by canonical UI stage order.
  const perStage = {};
  for (const stage of UI_STAGE_IDS) {
    perStage[stage] = { samples: 0, meanLatencyMs: 0, failures: 0, touched: 0, failureRate: 0, score: 0 };
  }
  const latencyTotals = new Map(UI_STAGE_IDS.map((stage) => [stage, { total: 0, count: 0 }]));
  const timeline = [];
  for (const document of documents) {
    for (const stage of UI_STAGE_IDS) {
      const record = document.stages?.[stage];
      if (!record) continue;
      perStage[stage].touched++;
      const start = timestamp(record.startedAt);
      const end = timestamp(record.endedAt);
      if (start && end && end >= start) {
        const totals = latencyTotals.get(stage);
        totals.total += end - start;
        totals.count++;
      }
    }
    for (const event of Array.isArray(document.events) ? document.events : []) {
      const uiStage = uiStageForInternalStage(String(event?.stage || "")) || "system";
      const ts = timestamp(event?.endedAt || event?.startedAt);
      if (!perStage[uiStage]) continue;
      if (event?.status === "failed") {
        perStage[uiStage].failures++;
        if (ts) timeline.push({ ts, failed: true });
      } else if (event?.status && ts) {
        timeline.push({ ts, failed: false });
      }
    }
  }
  let maxMean = 0;
  for (const stage of UI_STAGE_IDS) {
    const totals = latencyTotals.get(stage);
    const mean = totals.count ? totals.total / totals.count : 0;
    perStage[stage].samples = totals.count;
    perStage[stage].meanLatencyMs = Math.round(mean);
    perStage[stage].failureRate = perStage[stage].touched
      ? round2(perStage[stage].failures / perStage[stage].touched)
      : 0;
    maxMean = Math.max(maxMean, mean);
  }
  let d1Stage = null;
  let d1Score = 0;
  for (const stage of UI_STAGE_IDS) {
    const normalizedLatency = maxMean > 0 ? perStage[stage].meanLatencyMs / maxMean : 0;
    const score = round2(0.6 * normalizedLatency + 0.4 * perStage[stage].failureRate);
    perStage[stage].score = score;
    // Strict `>` keeps the first maximum in canonical UI_STAGE_IDS order.
    if (score > d1Score) {
      d1Stage = stage;
      d1Score = score;
    }
  }

  // ---- D2 — systemic-failure signal (Noul) --------------------------------
  // Fires when ≥ systemicFailureMinIssues distinct issues share one failure
  // class inside the failure window.
  const issuesByClass = new Map();
  const classCounts = new Map();
  for (const document of documents) {
    const seen = new Set();
    for (const failureClass of issueFailureClasses(document, windowStart, now)) {
      classCounts.set(failureClass, (classCounts.get(failureClass) || 0) + 1);
      if (seen.has(failureClass)) continue;
      seen.add(failureClass);
      if (!issuesByClass.has(failureClass)) issuesByClass.set(failureClass, []);
      issuesByClass.get(failureClass).push(document.issue.number);
    }
  }
  let d2Class = null;
  let d2Issues = [];
  for (const [failureClass, issues] of issuesByClass) {
    if (issues.length > d2Issues.length || (issues.length === d2Issues.length && failureClass < String(d2Class))) {
      d2Class = failureClass;
      d2Issues = issues;
    }
  }
  const d2Triggered = d2Issues.length >= thresholds.systemicFailureMinIssues;

  // ---- D3 — operator escalation needed (Noul) ------------------------------
  // Fires per-issue on: (a) `needs-info` label stalled longer than
  // escalationStallMs, or (b) an escalation-flavoured event (reason/message
  // matching /escalat|operator|needs-info/) on an issue that never merged.
  const d3Issues = [];
  const d3Reasons = {};
  for (const document of documents) {
    const labels = labelNames(document.issue);
    const stalled = labels.includes("needs-info") && now - lastActivityAt(document) >= thresholds.escalationStallMs;
    let escalated = false;
    if (!isDone(document)) {
      for (const event of Array.isArray(document.events) ? document.events : []) {
        if (ESCALATION_PATTERN.test(String(event?.reason || "")) || ESCALATION_PATTERN.test(String(event?.message || ""))) {
          escalated = true;
          break;
        }
      }
      if (document.needsInfo?.awaitingOperator || document.escalation?.unresolved) escalated = true;
    }
    if (stalled || escalated) {
      d3Issues.push(document.issue.number);
      d3Reasons[document.issue.number] = stalled && escalated ? "needs-info-stall+escalation-event" : stalled ? "needs-info-stall" : "escalation-event";
    }
  }

  // ---- D4 — backpressure trigger (Noul × 3) --------------------------------
  // Three INDEPENDENT signals, each a boolean Noul on the daemon side:
  //   1. queue depth      — dispatchable issues at/above queueDepthMax
  //   2. lease saturation — concurrent lease-wait records at/above leaseSaturationMax
  //   3. failure streak   — consecutive failed events (chronological) at/above failureStreakMax
  let queueDepth = 0;
  for (const document of documents) {
    if (isDone(document)) continue;
    if (labelNames(document.issue).some((label) => QUEUE_LABELS.has(label))) queueDepth++;
  }
  timeline.sort((left, right) => left.ts - right.ts);
  let streak = 0;
  let maxStreak = 0;
  for (const entry of timeline) {
    streak = entry.failed ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const signals = {
    queueDepth: { triggered: queueDepth >= thresholds.queueDepthMax, value: queueDepth, threshold: thresholds.queueDepthMax },
    leaseSaturation: { triggered: leaseWaits.length >= thresholds.leaseSaturationMax, value: leaseWaits.length, threshold: thresholds.leaseSaturationMax },
    failureStreak: { triggered: maxStreak >= thresholds.failureStreakMax, value: maxStreak, threshold: thresholds.failureStreakMax },
  };
  const triggeredCount = Object.values(signals).filter((signal) => signal.triggered).length;

  // ---- D5 — skill suggestion (Choice) --------------------------------------
  // Dominant failure class (most occurrences, ties alphabetical) mapped
  // through SKILL_SUGGESTION_RULES, falling back to the failing stage map.
  let dominantClass = null;
  let dominantCount = 0;
  for (const [failureClass, count] of [...classCounts.entries()].sort()) {
    if (count > dominantCount) {
      dominantClass = failureClass;
      dominantCount = count;
    }
  }
  const d5Choice = dominantClass ? suggestSkill(dominantClass, d1Stage) : null;
  const d5Options = [...new Set([
    ...(dominantClass ? SKILL_SUGGESTION_RULES.filter((rule) => rule.pattern.test(dominantClass)).map((rule) => rule.skill) : []),
    ...Object.values(SKILL_SUGGESTION_BY_STAGE),
  ])];

  return {
    source: "deterministic-v1",
    d1PipelineBottleneck: { stage: d1Stage, score: d1Score, perStage },
    d2SystemicFailure: {
      triggered: d2Triggered,
      failureClass: d2Triggered ? d2Class : null,
      issueCount: d2Issues.length,
      issues: [...d2Issues].sort((left, right) => left - right),
      threshold: thresholds.systemicFailureMinIssues,
    },
    d3OperatorEscalation: {
      triggered: d3Issues.length > 0,
      issues: d3Issues.sort((left, right) => left - right),
      reasons: d3Reasons,
    },
    d4Backpressure: { triggered: triggeredCount > 0, triggeredCount, signals },
    d5SkillSuggestion: {
      choice: d5Choice,
      failureClass: dominantClass,
      options: d5Options,
      source: "static-map",
    },
  };
}

// ---------------------------------------------------------------------------
// T10.0 — composite health, per-stage confidence, fallback badges.
//
// requirements.md §"Decision 6 — Composite scoring drives the operator
// dashboard": the orchestrator computes
//   health = 0.30·spec + 0.25·impl + 0.20·review + 0.25·verify
// and operators see health next to per-issue status in the control panel.
// §"Composite Scoring Rubric": `< 0.5` → operator alert, `0.5–0.7` →
// dashboard banner, `> 0.7` → log only.
//
// requirements.md §"CJK Fallback Contract → Observability": the read model
// shows a per-stage fallback badge whenever the last run for that stage fell
// back (`typesafe_fallback_to_claude`), and the composite health signal
// downgrades any dimension whose source primitive ran on fallback — here a
// fallback dimension contributes at 0.9× weight (FALLBACK_WEIGHT_FACTOR).
//
// Like `computeHealthJs` in `scripts/freshness-poc.mjs`, the health formula
// from `src/orchestrator/composite.ts` is mirrored locally in plain JS: the
// panel path never imports the TypeScript orchestrator and never performs
// typesafe HTTP calls. Everything below is additive — existing read-model
// consumers see the same shapes plus the new fields.
// ---------------------------------------------------------------------------

/** Decision 6 composite weights (mirrors `runtime/decisions.yaml` §composite). */
export const COMPOSITE_WEIGHTS = Object.freeze({ spec: 0.30, impl: 0.25, review: 0.20, verify: 0.25 });

/**
 * CJK Fallback Contract observability downgrade: a dimension whose source
 * primitive ran on fallback contributes at 0.9× weight to the composite.
 */
export const FALLBACK_WEIGHT_FACTOR = 0.9;

/** Dimension → UI stage whose fallback badge triggers the 0.9× downgrade. */
export const DIMENSION_STAGE = Object.freeze({
  spec: "spec",
  impl: "implementation",
  review: "review",
  verify: "verify",
});

/**
 * Contractual fallback markers. The canonical warning string is
 * `typesafe_fallback_to_claude: <reason>` (runtime/typesafe-backend.mjs);
 * agent loggers also emit the shortened `[<stage>.typesafe_fallback] <reason>`
 * form (src/agents/spec.ts, review-spec.ts), so both are recognised.
 */
const FALLBACK_MARKER = /typesafe_fallback(?:_to_claude)?/i;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * Local JS mirror of `computeHealth` in `src/orchestrator/composite.ts`
 * (same shape as `computeHealthJs` in `scripts/freshness-poc.mjs`):
 * `health = clamp(Σ(w_i · clamp(s_i, 0, 1)) / Σw_i, 0, 1)`.
 * Throws on missing / non-finite inputs so a wiring bug never lands on a
 * silent default.
 */
export function computeHealthJs(scores, weights = COMPOSITE_WEIGHTS) {
  if (!scores || typeof scores !== "object") {
    throw new Error("computeHealthJs: scores must be an object");
  }
  let total = 0;
  let weightSum = 0;
  for (const dim of Object.keys(COMPOSITE_WEIGHTS)) {
    const score = scores[dim];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error(`computeHealthJs: score for "${dim}" must be a finite number (got ${String(score)})`);
    }
    const weight = weights?.[dim];
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      throw new Error(`computeHealthJs: weight for "${dim}" must be a finite number (got ${String(weight)})`);
    }
    total += weight * clamp01(score);
    weightSum += weight;
  }
  if (weightSum <= 0) {
    throw new Error("computeHealthJs: weight sum must be positive");
  }
  return clamp01(total / weightSum);
}

/**
 * Local JS mirror of `healthBand` in `src/orchestrator/composite.ts`
 * (Decision 6 / §"Composite Scoring Rubric"):
 * `< 0.5` → `alert`, `[0.5, 0.7]` → `banner`, `> 0.7` → `log_only`.
 */
export function healthBandJs(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new Error(`healthBandJs: score must be a finite number (got ${String(score)})`);
  }
  if (score < 0.5) return "alert";
  if (score <= 0.7) return "banner";
  return "log_only";
}

function cleanFallbackReason(text) {
  return String(text || "")
    .replace(/^.*typesafe_fallback(?:_to_claude)?\]?\s*[:–-]?\s*/i, "")
    .trim() || "typesafe fallback to claude-code";
}

/**
 * Fallback marker carried by a projected stage record itself — either an
 * explicit `fallback: { reason, at }` object (forward-compatible persisted
 * shape) or a `warnings[]` array containing the contractual warning string.
 */
function stageRecordFallback(record) {
  if (!record || typeof record !== "object") return null;
  if (record.fallback && typeof record.fallback === "object") {
    return {
      reason: cleanFallbackReason(record.fallback.reason),
      at: record.fallback.at || record.endedAt || null,
    };
  }
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  const hit = warnings.find((warning) => FALLBACK_MARKER.test(String(warning)));
  if (hit) return { reason: cleanFallbackReason(String(hit)), at: record.endedAt || null };
  return null;
}

/**
 * Per-UI-stage fallback badges for one issue document.
 *
 * "The last run for that stage fell back" is derived from the persisted
 * state, in precedence order:
 *   1. the projected stage record carries `fallback` / `warnings[]` markers;
 *   2. the stage's most recent event (by endedAt || startedAt) carries the
 *      marker in `reason` / `message` — an older fallback followed by a
 *      clean run does NOT badge;
 *   3. `lastFailure` carries the marker and is at least as recent as the
 *      stage's most recent event.
 *
 * When the persisted state records no fallback, no badge is invented.
 */
export function deriveFallbackBadges(document) {
  const badges = {};
  const stages = projectStages(document?.stages || {});
  const events = Array.isArray(document?.events) ? document.events : [];
  for (const stage of UI_STAGE_IDS) {
    const fromRecord = stageRecordFallback(stages[stage]);
    if (fromRecord) {
      badges[stage] = fromRecord;
      continue;
    }
    let latest = null;
    for (const event of events) {
      const uiStage = uiStageForInternalStage(String(event?.stage || "")) || "system";
      if (uiStage !== stage) continue;
      const ts = timestamp(event?.endedAt || event?.startedAt);
      if (!latest || ts >= latest.ts) latest = { ts, event, at: event?.endedAt || event?.startedAt || null };
    }
    if (latest) {
      const text = `${latest.event?.reason || ""} ${latest.event?.message || ""}`;
      if (FALLBACK_MARKER.test(text)) {
        badges[stage] = { reason: cleanFallbackReason(text.trim()), at: latest.at };
        continue;
      }
    }
    const failure = document?.lastFailure;
    if (failure && (uiStageForInternalStage(String(failure.stage || "")) || "system") === stage) {
      const text = `${failure.class || ""} ${failure.message || ""}`;
      const failureTs = timestamp(failure.at);
      if (FALLBACK_MARKER.test(text) && (!latest || failureTs >= latest.ts)) {
        badges[stage] = { reason: cleanFallbackReason(String(failure.message || failure.class)), at: failure.at || null };
      }
    }
  }
  return badges;
}

/**
 * Per-UI-stage latest typesafe confidence for one issue document, keyed on
 * the run id so the UI can render a per-run distribution. Confidence is
 * read from persisted judgment records ONLY — when the persisted state has
 * no confidence for a stage, the entry exposes `confidence: null` rather
 * than inventing data:
 *   - spec           ← `specs.confidence` (B1–B3 batch mean, T9.2), falling
 *                      back to `specReview.confidence` (B4–B5 batch mean);
 *   - triage         ← `triage.confidence` (forward-compatible; not yet persisted);
 *   - implementation ← `implementation.confidence` (forward-compatible);
 *   - review         ← `review.confidence` (forward-compatible);
 *   - verify         ← `implementation.behaviorVerification.confidence` (forward-compatible);
 *   - merge          ← no judgment primitive; always null.
 * `runId` comes from the projected stage record, else the stage's most
 * recent event, else null.
 */
export function deriveStageConfidence(document) {
  const stages = projectStages(document?.stages || {});
  const events = Array.isArray(document?.events) ? document.events : [];
  const confidenceByStage = {
    triage: document?.triage?.confidence,
    spec: document?.specs?.confidence ?? document?.specReview?.confidence,
    implementation: document?.implementation?.confidence,
    review: document?.review?.confidence,
    verify: document?.implementation?.behaviorVerification?.confidence,
    merge: undefined,
  };
  const out = {};
  for (const stage of UI_STAGE_IDS) {
    let runId = typeof stages[stage]?.runId === "string" ? stages[stage].runId : null;
    if (!runId) {
      let latestTs = -1;
      for (const event of events) {
        const uiStage = uiStageForInternalStage(String(event?.stage || "")) || "system";
        if (uiStage !== stage || typeof event?.runId !== "string") continue;
        const ts = timestamp(event?.endedAt || event?.startedAt);
        if (ts >= latestTs) {
          latestTs = ts;
          runId = event.runId;
        }
      }
    }
    const raw = confidenceByStage[stage];
    out[stage] = {
      runId,
      confidence: typeof raw === "number" && Number.isFinite(raw) ? clamp01(raw) : null,
    };
  }
  return out;
}

/**
 * Full T10.0 signal set for one issue document: composite `health`,
 * `healthBand`, `stageConfidence`, and `fallbackBadges`.
 *
 * `health` is computed only when all four dimension scores are persisted as
 * finite numbers (`document.scores = { spec, impl, review, verify }`, the
 * forward-compatible field the orchestrator writes after the single typesafe
 * batch — Decision 6); otherwise `health` / `healthBand` are null.
 *
 * Downgrade rule (§"CJK Fallback Contract → Observability"): any dimension
 * whose source primitive ran on fallback — i.e. its stage carries a fallback
 * badge — contributes at `FALLBACK_WEIGHT_FACTOR` (0.9) × weight.
 */
export function deriveIssueSignals(document) {
  const fallbackBadges = deriveFallbackBadges(document);
  const stageConfidence = deriveStageConfidence(document);

  const raw = document?.scores;
  const dims = Object.keys(COMPOSITE_WEIGHTS);
  const complete = raw && typeof raw === "object"
    && dims.every((dim) => typeof raw[dim] === "number" && Number.isFinite(raw[dim]));
  let health = null;
  let band = null;
  if (complete) {
    const weights = {};
    for (const dim of dims) {
      const downgraded = Boolean(fallbackBadges[DIMENSION_STAGE[dim]]);
      weights[dim] = COMPOSITE_WEIGHTS[dim] * (downgraded ? FALLBACK_WEIGHT_FACTOR : 1);
    }
    health = round2(computeHealthJs(raw, weights));
    band = healthBandJs(health);
  }
  return { health, healthBand: band, stageConfidence, fallbackBadges };
}

export async function createPanelReadModel(root, options = {}) {
  const targetRoot = path.resolve(root);
  const projects = await loadProjects(targetRoot);
  const byId = new Map(projects.map((project) => [project.id, project]));
  const includeGitHub = options.includeGitHub !== false;
  const skillsRoot = path.resolve(options.skillsRoot || targetRoot);

  const requireProject = (projectId) => {
    const project = byId.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  };

  return Object.freeze({
    async projects() {
      const metrics = {};
      for (const project of projects) metrics[project.id] = computeMetrics(await stateDocuments(project));
      return { projects: projects.map(publicProject), metrics };
    },
    async issues(projectId) {
      const project = requireProject(projectId);
      // Build a Map<issueNumber, LeaseWaitRecord> once per request so
      // we don't hit the filesystem once per issue.
      const waits = await listLeaseWaits(project.config.paths.stateDir).catch(() => []);
      const waitByIssue = new Map(waits.map((entry) => [Number(entry.issueNumber), entry]));
      const persisted = (await stateDocuments(project)).map((doc) => projectIssue(doc, waitByIssue.get(Number(doc.issue.number))));
      if (!includeGitHub) return persisted;
      const known = new Set(persisted.map((entry) => entry.issue.number));
      const discovered = (await discoveredIssues(project)).filter((entry) => !known.has(entry.issue.number));
      return [...persisted, ...discovered];
    },
    async events() {
      const events = [];
      for (const project of projects) {
        const documents = await stateDocuments(project);
        events.push(...checkpointEvents(documents, project.id));
        events.push(...parseDaemonEvents(await readText(path.join(project.config.paths.stateDir, "daemon.log")), project.id));
      }
      return events.sort((left, right) => timestamp(right.ts) - timestamp(left.ts));
    },
    async agents() {
      const model = projects[0].config.model.id;
      const source = await sourceAgents(skillsRoot, model);
      return source.length ? source : bundledAgents(skillsRoot, model);
    },
    /**
     * T9.3 (additive): operational judgments D1–D5 aggregated across all
     * projects. Pure read-model derivation — no typesafe HTTP call happens
     * on this path; `scoreOperationalJudgments` is the seam a future
     * typesafe-backed scorer replaces.
     */
    async operationalJudgments() {
      const issues = [];
      const leaseWaits = [];
      for (const project of projects) {
        const waits = await listLeaseWaits(project.config.paths.stateDir).catch(() => []);
        leaseWaits.push(...waits);
        const waitByIssue = new Map(waits.map((entry) => [Number(entry.issueNumber), entry]));
        for (const document of await stateDocuments(project)) {
          issues.push(projectIssue(document, waitByIssue.get(Number(document.issue.number))));
        }
      }
      return scoreOperationalJudgments({ issues, leaseWaits });
    },
    async settings() {
      const project = projects[0];
      const pidRecord = await readJson(path.join(project.config.paths.stateDir, "daemon.pid"));
      let active = false;
      if (pidRecord?.pid) {
        try { process.kill(pidRecord.pid, 0); active = true; } catch {}
      }
      const startedAt = timestamp(pidRecord?.startedAt);
      return {
        baseUrl: project.config.model.baseUrl,
        defaultModel: project.config.model.id,
        pollIntervalSec: project.config.daemon.pollIntervalSec,
        localDaemon: {
          active,
          pid: active ? pidRecord.pid : null,
          uptimeSec: active && startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0,
          workdir: project.config.paths.workdir,
        },
      };
    },
    project(projectId) {
      return publicProject(requireProject(projectId));
    },
  });
}
