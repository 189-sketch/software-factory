import path from "node:path";
import { readdir } from "node:fs/promises";
import { readOptionalJson } from "./durable-json.mjs";

/** Explicit offline fixtures, not a recovery source for production. */
export function readFixtureState(stateDir, number) {
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid fixture issue number");
  return readOptionalJson(path.join(stateDir, "issues", `${number}.json`));
}

export async function listFixtureStates(stateDir) {
  const directory = path.join(stateDir, "issues");
  let names;
  try { names = await readdir(directory); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const states = await Promise.all(names.filter((name) => /^\d+\.json$/.test(name))
    .map((name) => readFixtureState(stateDir, Number(name.slice(0, -5)))));
  return states.filter(Boolean);
}

export function createFixtureLeaseManager() {
  const active = new Map();
  return {
    async acquire(issueNumber, owner) {
      if (active.has(issueNumber)) return null;
      const lease = { backend: "fixture", issueNumber, owner };
      active.set(issueNumber, lease);
      return lease;
    },
    async release(lease) {
      if (active.get(lease.issueNumber) !== lease) throw new Error("Fixture lease owner mismatch");
      active.delete(lease.issueNumber);
    },
  };
}
