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
