#!/usr/bin/env node
import path from "node:path";
import { inspectLegacyCheckpoint } from "../runtime/legacy-checkpoint.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || !/^\d+$/.test(args[1])) {
  throw new Error("Usage: node scripts/inspect-legacy-state.mjs CHECKPOINT_FILE ISSUE_NUMBER");
}
const file = path.resolve(args[0]);
const report = await inspectLegacyCheckpoint({
  file, number: Number(args[1]),
  repository: process.env.FACTORY_GH_REPO || process.env.GITHUB_REPOSITORY,
  token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  stateDir: path.dirname(path.dirname(file)),
  writers: (process.env.FACTORY_STATE_WRITERS || "").split(",").map((value) => value.trim()).filter(Boolean),
});
// Never print the candidate snapshot: legacy feedback may contain project-private material.
const { candidate, ...summary } = report;
console.log(JSON.stringify({ ...summary, candidatePrepared: Boolean(candidate) }, null, 2));
