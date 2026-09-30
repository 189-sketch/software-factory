import { GitHubStateStore } from "./github-state-store.mjs";
import * as github from "./github-rest.mjs";
import { readFixtureState, listFixtureStates } from "./fixture-state.mjs";

export function githubStateStore(config, ghClient = github) {
  return new GitHubStateStore({ repository: config.github.repository, token: config.github.token,
    stateDir: config.paths.stateDir, writers: config.state.writers, ghClient });
}

export async function readIssueState(config, number, ghClient = github) {
  if (config.state.backend === "fixture") return readFixtureState(config.paths.stateDir, number);
  return githubStateStore(config, ghClient).read(number);
}

export async function listIssueStates(config, { state = "all", ghClient = github } = {}) {
  if (config.state.backend === "fixture") return listFixtureStates(config.paths.stateDir);
  const rows = await ghClient.listIssues({ repository: config.github.repository, token: config.github.token, state });
  const store = githubStateStore(config, ghClient);
  const documents = [];
  // Bounded concurrency without an unbounded request burst.
  for (let offset = 0; offset < rows.length; offset += 4) {
    documents.push(...await Promise.all(rows.slice(offset, offset + 4).map((row) => store.read(row.number, row))));
  }
  return documents;
}
