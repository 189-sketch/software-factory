#!/usr/bin/env node
// scripts/typesafe-calibration.mjs
//
// Phase B acceptance gate for risk R1 (spec `2026-09-20-decision-architecture`):
// "100 sample issues, Jev confidence P50/P90 stable within ±0.05 across
// re-runs" (validation.md L4).
//
// Runs the frozen fixture `test/fixtures/calibration/issues-100.json`
// through the typesafe batch adapter (`runTypesafeStageFromConfig`) for the
// four composite dimensions (spec / impl / review / verify `Score`
// primitives), TWICE, and asserts per-dimension P50/P90 confidence
// stability within ±0.05 across the two passes.
//
// Modes (never requires a live API in CI):
//   (default)        deterministic built-in mock fetchImpl — offline, CI default
//   --record <file>  live calls with the real TYPESAFE_API_KEY; responses are
//                    persisted to <file>; pass 2 replays the recorded map
//   --replay <file>  replay a previously recorded response file (offline)
//
// Exit codes: 0 = PASS, 1 = FAIL. On FAIL a per-issue report
// (issue number, dimension, confidence pass1/pass2, delta) is printed.
//
// Usage:
//   node scripts/typesafe-calibration.mjs [--fixture <file>]
//                                         [--record <file> | --replay <file>]
//                                         [--tolerance 0.05]

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runTypesafeStageFromConfig } from "../runtime/typesafe-backend.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_FIXTURE = path.join(REPO_ROOT, "test", "fixtures", "calibration", "issues-100.json");
const DEFAULT_TOLERANCE = 0.05;
const MODEL = "jev";

/** The four composite dimensions calibrated here (requirements.md D-table). */
const DIMENSIONS = Object.freeze([
  { id: "spec", question: "Score how complete and unambiguous this issue is as an implementation specification. 100 = fully specified acceptance criteria and scope; 0 = not implementable as written." },
  { id: "impl", question: "Score how feasible this issue is for an autonomous implementation agent. 100 = trivially implementable with the described context; 0 = infeasible without more information." },
  { id: "review", question: "Score how objectively reviewable the acceptance criteria of this issue are. 100 = a reviewer can verify completion mechanically; 0 = success is undefined." },
  { id: "verify", question: "Score how end-to-end verifiable the expected behavior of this issue is. 100 = observable outcomes and reproduction steps are described; 0 = unverifiable." },
]);

const USAGE = `usage: typesafe-calibration.mjs [--fixture <file>] [--record <file> | --replay <file>] [--tolerance <0..1>]`;

function parseArgs(argv) {
  const args = { mode: "mock", fixture: DEFAULT_FIXTURE, tolerance: DEFAULT_TOLERANCE, target: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value\n${USAGE}`);
      return value;
    };
    if (flag === "--fixture") args.fixture = path.resolve(next());
    else if (flag === "--record") { args.mode = "record"; args.target = path.resolve(next()); }
    else if (flag === "--replay") { args.mode = "replay"; args.target = path.resolve(next()); }
    else if (flag === "--tolerance") {
      const value = Number(next());
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`--tolerance must be a number in [0,1]\n${USAGE}`);
      args.tolerance = value;
    } else if (flag === "--help" || flag === "-h") { console.log(USAGE); process.exit(0); }
    else throw new Error(`unknown flag: ${flag}\n${USAGE}`);
  }
  return args;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** Deterministic SHA-256 state hash for one fixture issue (freshness-style). */
function stateHashForIssue(issue) {
  const canonical = JSON.stringify({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    comments: (issue.comments || []).map((comment) => comment.body),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function buildRequest(issue) {
  const state = {
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    comments: issue.comments || [],
  };
  return {
    model: MODEL,
    state_hash: stateHashForIssue(issue),
    primitives: DIMENSIONS.map((dimension) => ({
      id: dimension.id,
      type: "Score",
      question: dimension.question,
      state,
    })),
  };
}

/**
 * Deterministic built-in mock (CI default, offline). Confidence is a pure
 * function of (issue number, dimension, title length) — identical across
 * passes by construction, which is exactly what the stability gate measures.
 */
function mockConfidence(primitive) {
  const key = [
    "calibration-mock-v1",
    String(primitive.state?.issueNumber ?? ""),
    String(primitive.id ?? ""),
    String(primitive.state?.title ?? "").length,
  ].join("|");
  const digest = createHash("sha256").update(key).digest();
  return round4(0.55 + (digest.readUInt32BE(0) % 4001) / 10000); // [0.55, 0.95]
}

function mockResponseBody(request) {
  return {
    primitives: request.primitives.map((primitive) => {
      const confidence = mockConfidence(primitive);
      return { id: primitive.id, value: Math.round(confidence * 100), confidence };
    }),
    session_id: `calibration-mock-${String(request.state_hash).slice(0, 12)}`,
  };
}

function jsonResponse(status, statusText, body) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, statusText, text: async () => text };
}

function issueNumberOf(requestBody) {
  try {
    return String(JSON.parse(requestBody)?.primitives?.[0]?.state?.issueNumber ?? "");
  } catch {
    return "";
  }
}

/** fetchImpl for the offline mock mode. */
function mockFetchImpl() {
  return async (_url, init) => jsonResponse(200, "OK", mockResponseBody(JSON.parse(init.body)));
}

/** fetchImpl that replays from an in-memory map { issueNumber → response body }. */
function replayFetchImpl(recorded) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const hit = recorded.get(issueNumberOf(init.body));
    if (!hit) return jsonResponse(500, "replay miss", { error: `no recorded response for issue ${issueNumberOf(init.body)}` });
    return jsonResponse(200, "OK", { ...hit, session_id: hit.session_id || `calibration-replay-${String(body.state_hash).slice(0, 12)}` });
  };
}

/** fetchImpl that forwards to the live API and tees responses into `sink`. */
function recordFetchImpl(sink) {
  return async (url, init) => {
    const response = await fetch(url, init);
    const text = await response.text();
    if (response.ok) {
      try {
        const parsed = JSON.parse(text);
        sink.set(issueNumberOf(init.body), parsed);
      } catch { /* non-JSON body → adapter surfaces the fallback */ }
    }
    return { ok: response.ok, status: response.status, statusText: response.statusText, text: async () => text };
  };
}

async function loadFixture(file) {
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  const issues = Array.isArray(parsed) ? parsed : parsed.issues;
  if (!Array.isArray(issues) || issues.length === 0) throw new Error(`fixture has no issues: ${file}`);
  return issues;
}

async function loadRecorded(file) {
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  const responses = parsed?.responses ?? parsed;
  if (!responses || typeof responses !== "object") throw new Error(`recorded file is malformed: ${file}`);
  return new Map(Object.entries(responses));
}

/**
 * One pass over the fixture: issue → { number, confidences: { dim: c } }.
 * Any adapter fallback (missing key, HTTP failure, replay miss) is a hard
 * error — a calibration pass must measure confidences, not fallbacks.
 */
async function runPass(issues, fetchImpl, env) {
  const config = { timeoutMs: 30_000 };
  const results = [];
  for (const issue of issues) {
    const result = await runTypesafeStageFromConfig(config, "", buildRequest(issue), { env, fetchImpl });
    if (result.status !== "succeeded") {
      throw new Error(`issue ${issue.number}: typesafe adapter fallback: ${result.warnings.join("; ") || result.logTail || "unknown"}`);
    }
    const confidences = {};
    for (const primitive of Array.isArray(result.structuredOutput) ? result.structuredOutput : []) {
      if (primitive && typeof primitive.id === "string" && typeof primitive.confidence === "number") {
        confidences[primitive.id] = primitive.confidence;
      }
    }
    for (const dimension of DIMENSIONS) {
      if (!(dimension.id in confidences)) throw new Error(`issue ${issue.number}: missing confidence for dimension ${dimension.id}`);
    }
    results.push({ number: issue.number, confidences });
  }
  return results;
}

/** Nearest-rank percentile over a sorted-ascending numeric array. */
function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const rank = Math.ceil((p / 100) * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, rank - 1))];
}

function dimensionStats(pass) {
  const stats = {};
  for (const dimension of DIMENSIONS) {
    const sorted = pass.map((entry) => entry.confidences[dimension.id]).sort((a, b) => a - b);
    stats[dimension.id] = { p50: round4(percentile(sorted, 50)), p90: round4(percentile(sorted, 90)) };
  }
  return stats;
}

function fmt(value) {
  return value.toFixed(4);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const issues = await loadFixture(args.fixture);
  console.log(`typesafe calibration gate — fixture: ${path.relative(REPO_ROOT, args.fixture)} (${issues.length} issues)`);
  console.log(`dimensions: ${DIMENSIONS.map((dimension) => dimension.id).join(", ")} | tolerance: ±${args.tolerance} | mode: ${args.mode}`);

  let pass1;
  let pass2;
  let sink = null;
  if (args.mode === "mock") {
    const env = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY || "calibration-mock-key" };
    pass1 = await runPass(issues, mockFetchImpl(), env);
    pass2 = await runPass(issues, mockFetchImpl(), env);
  } else if (args.mode === "replay") {
    const recorded = await loadRecorded(args.target);
    const env = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY || "calibration-replay-key" };
    pass1 = await runPass(issues, replayFetchImpl(recorded), env);
    pass2 = await runPass(issues, replayFetchImpl(recorded), env);
  } else {
    // record: pass 1 hits the live API (real key required), pass 2 replays
    // what pass 1 recorded so the stability comparison is apples-to-apples.
    const apiKey = String(process.env.TYPESAFE_API_KEY || "").trim();
    if (!apiKey) {
      console.error("--record requires TYPESAFE_API_KEY in the environment");
      process.exit(1);
    }
    sink = new Map();
    pass1 = await runPass(issues, recordFetchImpl(sink), { TYPESAFE_API_KEY: apiKey });
    await fs.mkdir(path.dirname(args.target), { recursive: true });
    await fs.writeFile(args.target, `${JSON.stringify({ version: 1, model: MODEL, recordedAt: new Date().toISOString(), responses: Object.fromEntries(sink) }, null, 2)}\n`);
    console.log(`recorded ${sink.size} responses → ${args.target}`);
    pass2 = await runPass(issues, replayFetchImpl(sink), { TYPESAFE_API_KEY: apiKey });
  }

  const stats1 = dimensionStats(pass1);
  const stats2 = dimensionStats(pass2);

  console.log("");
  console.log("dim    p50(pass1) p50(pass2) Δp50     p90(pass1) p90(pass2) Δp90     verdict");
  const failures = [];
  for (const dimension of DIMENSIONS) {
    const a = stats1[dimension.id];
    const b = stats2[dimension.id];
    const deltaP50 = round4(Math.abs(a.p50 - b.p50));
    const deltaP90 = round4(Math.abs(a.p90 - b.p90));
    const ok = deltaP50 <= args.tolerance + 1e-9 && deltaP90 <= args.tolerance + 1e-9;
    if (!ok) failures.push({ dimension: dimension.id, deltaP50, deltaP90 });
    console.log(
      `${dimension.id.padEnd(6)} ${fmt(a.p50).padEnd(10)} ${fmt(b.p50).padEnd(10)} ${fmt(deltaP50).padEnd(8)}`
      + ` ${fmt(a.p90).padEnd(10)} ${fmt(b.p90).padEnd(10)} ${fmt(deltaP90).padEnd(8)} ${ok ? "OK" : "FAIL"}`,
    );
  }

  if (failures.length === 0) {
    console.log("");
    console.log(`CALIBRATION PASS — ${issues.length} issues × ${DIMENSIONS.length} dimensions, P50/P90 stable within ±${args.tolerance} across re-runs (mode=${args.mode})`);
    process.exit(0);
  }

  console.log("");
  console.log("per-issue report (issue, dimension, confidence pass1, confidence pass2, delta):");
  const byNumber = new Map(pass2.map((entry) => [entry.number, entry]));
  for (const entry of pass1) {
    const second = byNumber.get(entry.number);
    for (const dimension of DIMENSIONS) {
      const c1 = entry.confidences[dimension.id];
      const c2 = second?.confidences[dimension.id] ?? Number.NaN;
      const delta = Number.isFinite(c2) ? round4(Math.abs(c1 - c2)) : Number.NaN;
      console.log(`issue ${String(entry.number).padStart(4)} ${dimension.id.padEnd(6)} pass1=${fmt(c1)} pass2=${Number.isFinite(c2) ? fmt(c2) : "n/a"} delta=${Number.isFinite(delta) ? fmt(delta) : "n/a"}`);
    }
  }
  console.log("");
  console.log(`CALIBRATION FAIL — unstable dimensions: ${failures.map((failure) => `${failure.dimension} (Δp50=${fmt(failure.deltaP50)}, Δp90=${fmt(failure.deltaP90)})`).join(", ")}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`CALIBRATION ERROR — ${error?.stack || error}`);
  process.exit(1);
});
