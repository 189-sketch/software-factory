import * as github from "./github-rest.mjs";
import { isLeaseHolderDeadOnThisHost } from "./lease-manager.mjs";

/** Observe ownership only. A waiter must never mutate the holder's fencing SHA. */
export async function listGitHubLeases(config, ghClient = github) {
  if (config.state.backend === "fixture") return [];
  const options = { repository: config.github.repository, token: config.github.token };
  const refs = await ghClient.listLeaseRefs(options);
  return Promise.all(refs.map(async (ref) => {
    const message = await ghClient.getCommitMessage({ ...options, sha: ref.sha });
    const match = message?.match(/^factory-lease\s+issue=(\d+)\s+owner=(\S+)\s+ts=(\S+)/);
    if (!match || Number(match[1]) !== ref.issueNumber || !Number.isFinite(Date.parse(match[3]))) {
      return { ...ref, owner: null, acquiredAt: null, dead: false, malformed: true };
    }
    return { ...ref, owner: match[2], acquiredAt: match[3],
      dead: isLeaseHolderDeadOnThisHost(match[2]), malformed: false };
  }));
}
