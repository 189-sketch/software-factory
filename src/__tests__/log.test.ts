import test from "node:test";
import assert from "node:assert/strict";
import { ConsoleLogger, formatUtc8Timestamp } from "../core/log.js";

test("orchestrator logger emits an explicit UTC+8 timestamp", () => {
  assert.equal(
    formatUtc8Timestamp(new Date("2026-09-10T08:16:14.466Z")),
    "2026-09-10T16:16:14.466+08:00",
  );
  const lines: string[] = [];
  const original = console.error;
  console.error = (line?: unknown) => lines.push(String(line));
  try {
    new ConsoleLogger({ orchestrator: "factory" }).info("stage started");
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00 INFO /);
  assert.doesNotMatch(lines[0], /Z INFO /);
});
