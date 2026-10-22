/**
 * Agent content stream — transcript sink tests.
 *
 * The transcript is the operator-local record of what an agent actually
 * did during a stage run. These tests pin the properties that make it
 * safe to keep on disk and useful to read:
 *   - `off` produces nothing at all;
 *   - `on` keeps model text, tool calls and tool results, and drops
 *     model reasoning and partial deltas;
 *   - `full` keeps reasoning and deltas in the FILE but never in the
 *     console summary (deltas are per-token);
 *   - credential-shaped values never reach the file;
 *   - the byte budget stops the transcript from growing without limit;
 *   - one transcript file per issue/role/run, so concurrent runs do not
 *     interleave.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAgentStreamSink,
  resolveStreamDirectory,
  streamFileName,
} from "../core/agent-stream-log.js";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "factory-stream-"));
}

test('the stream mode decides whether a transcript exists at all', () => {
  assert.equal(createAgentStreamSink({ mode: "off", dir: freshDir(), maxBytes: 1024, issue: 1, role: "triage", runId: "r1" }), null);
});

test('the transcript keeps model text, tool calls and tool results but not reasoning', () => {
  const dir = freshDir();
  const summaries: string[] = [];
  const sink = createAgentStreamSink({
    mode: "on", dir, maxBytes: 1024 * 1024, issue: 7, role: "spec-tech", runId: "run-1",
    summary: line => summaries.push(line),
  });
  assert.ok(sink);
  sink.write({ kind: "text", text: "MODEL-TEXT" });
  sink.write({ kind: "tool-call", tool: "Read", input: JSON.stringify({ file_path: "a.ts" }) });
  sink.write({ kind: "tool-result", tool: "Read", text: "TOOL-OUTPUT", isError: false });
  sink.write({ kind: "thinking", text: "PRIVATE-REASONING" });
  sink.write({ kind: "delta-text", text: "part" });

  const transcript = readFileSync(sink.file, "utf8");
  assert.match(transcript, /MODEL-TEXT/);
  assert.match(transcript, /TOOL-OUTPUT/);
  assert.match(transcript, /"tool":"Read"/);
  assert.doesNotMatch(transcript, /PRIVATE-REASONING/, "model reasoning must stay out of the default transcript");
  assert.doesNotMatch(transcript, /"kind":"delta-text"/, "partial deltas must stay out of the default transcript");
  assert.equal(sink.counts.thinking, 1, "an observed record still counts even when it is not persisted");
  assert.equal(sink.counts["delta-text"], 1);

  assert.equal(summaries.length, 3, "one console line per persisted record");
  assert.match(summaries[0], /issue=7 role=spec-tech run=run-1/);
  assert.match(summaries[1], /tool=Read call/);
  assert.match(summaries[2], /tool=Read ok/);
  rmSync(dir, { recursive: true, force: true });
});

test('the full mode keeps reasoning in the file and keeps deltas out of the console', () => {
  const dir = freshDir();
  const summaries: string[] = [];
  const sink = createAgentStreamSink({
    mode: "full", dir, maxBytes: 1024 * 1024, issue: 1, role: "triage", runId: "run-2",
    summary: line => summaries.push(line),
  });
  assert.ok(sink);
  sink.write({ kind: "thinking", text: "REASONING" });
  sink.write({ kind: "delta-text", text: "tok" });
  const transcript = readFileSync(sink.file, "utf8");
  assert.match(transcript, /REASONING/);
  assert.match(transcript, /"kind":"delta-text"/);
  assert.equal(summaries.length, 1, "per-token deltas must not flood the operator console");
  rmSync(dir, { recursive: true, force: true });
});

test("credential-shaped values never reach the transcript", () => {
  const dir = freshDir();
  const previous = process.env.FACTORY_TEST_STREAM_TOKEN;
  process.env.FACTORY_TEST_STREAM_TOKEN = "stream-secret-value";
  try {
    const sink = createAgentStreamSink({
      mode: "on", dir, maxBytes: 1024 * 1024, issue: 1, role: "triage", runId: "run-3",
      summary: () => {},
    });
    assert.ok(sink);
    sink.write({ kind: "tool-result", tool: "Bash", text: "export TOKEN=stream-secret-value" });
    sink.write({ kind: "tool-result", tool: "Bash", text: "Authorization: Bearer abc.def-ghi" });
    const transcript = readFileSync(sink.file, "utf8");
    assert.doesNotMatch(transcript, /stream-secret-value/);
    assert.match(transcript, /\[REDACTED\]/);
    assert.doesNotMatch(transcript, /Bearer abc\.def-ghi/);
  } finally {
    if (previous === undefined) delete process.env.FACTORY_TEST_STREAM_TOKEN;
    else process.env.FACTORY_TEST_STREAM_TOKEN = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the byte budget stops the transcript and records why", () => {
  const dir = freshDir();
  const sink = createAgentStreamSink({
    mode: "on", dir, maxBytes: 200, issue: 1, role: "triage", runId: "run-4", summary: () => {},
  });
  assert.ok(sink);
  for (let index = 0; index < 50; index += 1) sink.write({ kind: "text", text: `line-${index}-${"x".repeat(40)}` });
  assert.equal(sink.budgetExhausted, true);
  const transcript = readFileSync(sink.file, "utf8");
  assert.match(transcript, /budget-exhausted/);
  assert.ok(Buffer.byteLength(transcript, "utf8") < 200 * 4, "the transcript must stay near the budget");
  rmSync(dir, { recursive: true, force: true });
});

test("each run owns its transcript and the directory defaults to the state root", () => {
  const dir = freshDir();
  const first = createAgentStreamSink({ mode: "on", dir, maxBytes: 1024, issue: 1, role: "triage", runId: "run-a", summary: () => {} });
  const second = createAgentStreamSink({ mode: "on", dir, maxBytes: 1024, issue: 2, role: "triage", runId: "run-a", summary: () => {} });
  assert.ok(first); assert.ok(second);
  assert.notEqual(first.file, second.file);
  assert.equal(path.basename(first.file), "issue-1-triage-run-a.ndjson");
  assert.equal(resolveStreamDirectory("", path.join("/state", "root")), path.join("/state", "root", "streams"));
  assert.equal(resolveStreamDirectory(path.join("/custom", "dir"), path.join("/state", "root")), path.join("/custom", "dir"));
  assert.equal(streamFileName(3, "review/pr", "abc"), "issue-3-review-pr-abc.ndjson");
  rmSync(dir, { recursive: true, force: true });
});

test("the transcript never lands inside the product checkout", () => {
  // The implementation stage stages the worktree with
  // `git add -A -- :!factory/`, which excludes only `factory/`. A
  // transcript written into the checkout would be committed and pushed
  // as product data.
  const checkout = path.join("/repo", "factory-workdir", "issue-7");
  const inside = resolveStreamDirectory("", checkout, checkout);
  assert.ok(!inside.startsWith(checkout), `transcript must not live inside the checkout: ${inside}`);
  const configuredInside = resolveStreamDirectory(path.join(checkout, "streams"), checkout, checkout);
  assert.ok(!configuredInside.startsWith(checkout), `transcript must not live inside the checkout: ${configuredInside}`);
  // A relative configured directory resolves against the state root, so
  // the daemon and the worker agree despite different working dirs.
  const stateRoot = path.resolve(path.sep, "state", "root");
  assert.equal(resolveStreamDirectory("transcripts", stateRoot), path.join(stateRoot, "transcripts"));
});

test("the transcript file is only created once something is written", () => {
  const dir = freshDir();
  const sink = createAgentStreamSink({ mode: "on", dir, maxBytes: 1024, issue: 1, role: "triage", runId: "run-5", summary: () => {} });
  assert.ok(sink);
  assert.equal(existsSync(sink.file), false);
  sink.write({ kind: "system", subtype: "init" });
  assert.equal(existsSync(sink.file), true);
  rmSync(dir, { recursive: true, force: true });
});
