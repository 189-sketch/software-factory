#!/usr/bin/env node
/**
 * CLI entry point for the multi-agent software factory.
 *
 * Usage:
 *   tsx src/cli/run-issue.ts --issue fixtures/issues/1.json
 *   tsx src/cli/run-issue.ts --all            (runs every fixture issue)
 */
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { FactoryOrchestrator } from "../orchestrator/index.js";
import { loadIssues } from "../github/local.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve the skills root at runtime so the same CLI works in both
//   - source layout: <repo>/skills/                 (../../skills from src/cli)
//   - bundle layout: <pkg>/dist/factory/skills/     (./skills from dist/factory)
// SkillLoader inside falls back from SKILL.md to .json so either layout
// loads the same set of skills.
const skillsRoot = [path.join(__dirname, "..", "..", "skills"), path.join(__dirname, "skills")]
    .find((candidate) => existsSync(candidate)) ?? path.join(__dirname, "..", "..", "skills");
const fixturesDir = path.join(__dirname, "..", "..", "fixtures", "issues");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Use process.cwd() so tests can point the CLI at a temp directory.
  const repoRoot = process.cwd();
  const remotePath = process.env.FACTORY_REMOTE_PATH || args.remote || "";
  const [owner = 'local', name = path.basename(repoRoot)] = (process.env.FACTORY_GH_REPO || '').split('/').filter(Boolean);
  const orchestrator = new FactoryOrchestrator({
    skillsRoot,
    repo: { owner, name, defaultBranch: process.env.FACTORY_DEFAULT_BRANCH || 'main', workdir: repoRoot },
    remotePath,
  });

  const issues = args.all
    ? await loadIssues(fixturesDir)
    : args.issue
      ? [await loadOne(args.issue)]
      : [];
  if (issues.length === 0) {
    console.error("no issues to process; pass --issue <file> or --all");
    process.exit(1);
  }

  for (const issue of issues) {
    let result;
    if (args.stage === "triage") {
      result = await orchestrator.runTriage(issue);
    } else if (args.stage === "improve-review-pr") {
      result = await orchestrator.runImproveReviewPr(issue);
    } else if (args.stage === "verify-behavior") {
      result = await orchestrator.runVerifyBehavior(issue);
    } else if (args.stage === "review-pr") {
      result = await orchestrator.runReviewPr(issue);
    } else {
      result = await orchestrator.runForIssue(issue);
    }
    const summary = JSON.stringify(summarize(result, args.stage));
    console.log(summary);
    // Persist a JSON file alongside stdout so callers (notably the GitHub
    // Actions triage workflow) don't have to `tail -n 1` the streamed logs
    // and pray the last line is valid JSON.
    if (args.outputFile) {
      await fs.writeFile(args.outputFile, summary, "utf-8");
    }
  }

  await orchestrator.persist();
}

function summarize(state: any, stage?: string) {
  if (stage === "improve-review-pr") {
    return {
      issue: state.issue?.number,
      decision: state.decision,
      prsInspected: state.prsInspected,
      feedbackItems: state.feedbackItems,
      learnings: state.learnings,
      skillPrUrl: state.skillPrUrl,
    };
  }
  if (stage === "verify-behavior") {
    return {
      issue: state.issue?.number,
      mode: state.mode,
      status: state.status,
      channel: state.channel,
      ozRunUrl: state.ozRunUrl,
      evidenceCount: state.evidence?.length ?? 0,
    };
  }
  if (stage === "review-pr") return state;
  return {
    issue: state.issue.number,
    title: state.issue.title,
    triage: state.triage?.state,
    triageResult: state.triage ?? null,
    specs: state.specs ? { branch: state.specs.specBranch, prUrl: state.specs.specPrUrl } : null,
    implementation: state.implementation ? { branch: state.implementation.branch, prUrl: state.implementation.prUrl, filesChanged: state.implementation.filesChanged } : null,
    review: state.review ? { verdict: state.review.verdict, comments: state.review.comments.length, body: state.review.body } : null,
    verify: state.implementation?.behaviorVerification?.status,
    merged: state.merged,
    status: state.status,
    nextLabel: state.nextLabel,
    agentMode: state.agentMode,
  };
}

async function loadOne(p: string) {
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(p, "utf-8");
  const obj = JSON.parse(raw);
  return {
    number: obj.number,
    title: obj.title,
    body: obj.body ?? "",
    labels: obj.labels ?? [],
    author: obj.author ?? "demo-user",
    url: obj.url ?? "",
    createdAt: obj.createdAt ?? new Date().toISOString(),
    comments: obj.comments ?? [],
  };
}

function parseArgs(argv: string[]): { issue?: string; all?: boolean; stage?: string; remote?: string; outputFile?: string } {
  const out: { issue?: string; all?: boolean; stage?: string; remote?: string; outputFile?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--issue") out.issue = argv[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--stage") out.stage = argv[++i];
    else if (a === "--remote") out.remote = argv[++i];
    else if (a === "--output-file") out.outputFile = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (out.stage && !['triage', 'improve-review-pr', 'verify-behavior', 'review-pr'].includes(out.stage)) throw new Error(`Unsupported stage: ${out.stage}`);
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
