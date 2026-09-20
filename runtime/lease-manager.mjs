import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  getBranchSha,
  getCommitMessage,
  getCommitTree,
  getRef,
  createRef,
  createCommit,
  deleteRef,
} from "./github-rest.mjs";

const exec = promisify(execFile);

/**
 * Parse the canonical `hostname:pid` lease-owner string back into its
 * parts. Returns null when the string is not in the expected shape
 * (e.g. a manual `factory-lease` test, an older daemon, or a foreign
 * ref that another tool created). Callers must treat null as
 * "indeterminate — fall back to staleness heuristic".
 */
export function parseLeaseOwner(ownerStr) {
  if (typeof ownerStr !== "string" || ownerStr.length === 0) return null;
  const idx = ownerStr.lastIndexOf(":");
  if (idx <= 0 || idx === ownerStr.length - 1) return null;
  const pid = Number(ownerStr.slice(idx + 1));
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { hostname: ownerStr.slice(0, idx), pid };
}

/**
 * True when the lease holder is provably dead on this host:
 *   - the parsed hostname matches ours, AND
 *   - the pid is no longer running (process.kill(pid, 0) throws ESRCH).
 *
 * Returns false for cross-host holders (we can't tell if their PID is
 * alive) and for malformed owner strings. Used by the lease manager's
 * acquire path to reclaim orphaned leases without requiring the
 * operator to set `FACTORY_LEASE_STALE_MS > 0`.
 */
export function isLeaseHolderDeadOnThisHost(ownerStr, hostName = os.hostname()) {
  const parsed = parseLeaseOwner(ownerStr);
  if (!parsed) return false;
  if (parsed.hostname !== hostName) return false;
  try {
    process.kill(parsed.pid, 0);
    return false; // signal 0 succeeded → process exists
  } catch (error) {
    if (error?.code === "ESRCH") return true; // no such process
    // EPERM (process exists but we lack permission) → don't reclaim.
    return false;
  }
}

export function createLeaseManager(options) {
  const run = options.run || exec;
  const repository = String(options.repository || "");
  const token = String(options.token || "");
  const defaultBranch = String(options.defaultBranch || "main");
  const stateDir = path.resolve(options.stateDir);
  // Phase B: every GitHub call now goes through a thin client
  // surface so the test suite can substitute a mock without
  // shelling out to `gh`. Production code uses the real
  // undici-backed client from `./github-rest.mjs`; tests pass a
  // plain object with the same method names.
  const gh = options.ghClient || {
    getBranchSha, getCommitTree, getCommitMessage, getRef, createRef, createCommit, deleteRef,
  };
  // staleMs controls automatic reclaim of orphaned leases (Layer 2).
  // <= 0 disables the feature and keeps the original "fail closed on conflict" behavior.
  const staleMs = Math.max(0, Number(options.staleMs) || 0);
  // Default logger: silent except for ERROR (CLI path stays quiet on stdout).
  // The factory daemon injects its own structured logger via options.log.
  const log = typeof options.log === "function"
    ? options.log
    : (level, msg, extra = {}) => {
        if (level === "ERROR") {
          try { process.stderr.write(`[ERROR] ${msg} ${JSON.stringify(extra)}\n`); } catch {}
        }
      };
  const env = { ...process.env, GH_TOKEN: token };

  async function acquireFile(issueNumber, owner) {
    const directory = path.join(stateDir, "leases");
    const file = path.join(directory, `issue-${issueNumber}.lock`);
    await fs.mkdir(directory, { recursive: true });
    let handle;
    try {
      handle = await fs.open(file, "wx");
      await handle.writeFile(JSON.stringify({ issueNumber, owner, acquiredAt: new Date().toISOString() }));
      return { backend: "file", issueNumber, owner, file };
    } catch (error) {
      if (error?.code === "EEXIST") return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  /**
 * `withStaleReclaim` is the shared "try-acquire, on-conflict check
 * staleness, reclaim, retry" loop. Both the file and GitHub-ref
 * backends implement the same plan but with different inspect /
 * reclaim shapes; this HOF keeps the stale-check policy in one place
 * so a future backend (e.g. S3, Postgres) only has to supply the
 * three callbacks.
 */
  function withStaleReclaim({
    acquire: acquireOnce,
    inspect,
    reclaim,
    backendName,
  }) {
    return async function acquireWithStaleReclaim(issueNumber, owner) {
      const first = await acquireOnce(issueNumber, owner);
      if (first) return first;

      const existing = await inspect(issueNumber);
      if (!existing) return null;

      // Layer 1 reclaim: dead-process detection. If the holder's
      // hostname matches ours and the pid is no longer running, the
      // lease is provably orphaned — the previous daemon crashed or
      // was killed without releasing. Reclaim without requiring an
      // operator-configured `FACTORY_LEASE_STALE_MS`. This is the
      // common post-mortem case (issue #24 sat busy-looping for
      // hours because the old daemon's lease ref outlived its pid).
      if (isLeaseHolderDeadOnThisHost(existing.owner)) {
        log("WARN", "lease-dead-process-reclaiming", {
          backend: backendName,
          issueNumber,
          existingOwner: existing.owner,
          existingAcquiredAt: existing.acquiredAt,
          reason: "holder pid no longer running on this host",
        });
        const reclaimed = await reclaim(issueNumber);
        if (reclaimed) return acquireOnce(issueNumber, owner);
        return null;
      }

      // Layer 2 reclaim: staleness heuristic. Catches cross-host
      // holders (we can't tell if their pid is alive) and same-host
      // holders whose pid we couldn't classify. Gated by staleMs
      // because the heuristic can misfire on slow checkpoints.
      if (!staleMs) return null;
      const acquiredAtMs = Date.parse(existing.acquiredAt);
      if (!Number.isFinite(acquiredAtMs)) return null; // unparseable → refuse to steal
      const ageMs = Date.now() - acquiredAtMs;
      if (ageMs < staleMs) return null;

      log("WARN", "lease-stale-reclaiming", {
        backend: backendName,
        issueNumber,
        existingOwner: existing.owner,
        existingAcquiredAt: existing.acquiredAt,
        ageMs,
        staleMs,
      });
      const reclaimed = await reclaim(issueNumber);
      if (!reclaimed) return null;
      return acquireOnce(issueNumber, owner); // single retry
    };
  }

  const acquireFileWithStaleReclaim = withStaleReclaim({
    acquire: acquireFile,
    backendName: "file",
    inspect: async (issueNumber) => {
      const file = path.join(stateDir, "leases", `issue-${issueNumber}.lock`);
      try {
        const record = JSON.parse(await fs.readFile(file, "utf8"));
        return { owner: record?.owner ?? null, acquiredAt: record?.acquiredAt ?? "" };
      } catch {
        // File vanished between the first and second attempts — treat as not stale.
        return null;
      }
    },
    reclaim: async (issueNumber) => {
      const file = path.join(stateDir, "leases", `issue-${issueNumber}.lock`);
      try {
        await fs.unlink(file);
        return true;
      } catch (error) {
        // ENOENT is fine (vanished between inspect and unlink); other
        // errors fail closed.
        return error?.code === "ENOENT";
      }
    },
  });

  async function acquireGitHub(issueNumber, owner) {
    const ref = `refs/heads/factory/leases/issue-${issueNumber}`;
    // Phase B: every GitHub call now goes through undici via
    // `./github-rest.mjs`. The persistent Agent + bounded retry
    // envelope replaces the previous `gh api` shell-out so the
    // daemon survives the long-running-state TLS regression that
    // Windows `gh` clients suffer after a few minutes alive.
    const parentSha = await gh.getBranchSha({
      token, repository, branch: defaultBranch,
    });
    if (!parentSha) throw new Error(`Cannot resolve ${repository} default branch ${defaultBranch} for lease acquisition`);

    // Every owner receives a dedicated commit so release can compare
    // the current ref target with its receipt before deleting it.
    // staleMs only controls whether a conflicting ref may be reclaimed.
    const treeSha = await gh.getCommitTree({ token, repository, sha: parentSha });
    if (!treeSha) throw new Error(`Cannot resolve tree for ${parentSha}`);

    const acquiredAt = new Date().toISOString();
    const message = `factory-lease issue=${issueNumber} owner=${owner} ts=${acquiredAt}`;
    const commit = await gh.createCommit({
      token, repository, message, tree: treeSha, parents: [parentSha],
    });
    const commitSha = commit?.sha;
    if (!commitSha) throw new Error(`Cannot create lease commit for issue #${issueNumber}`);

    try {
      await gh.createRef({ token, repository, ref, sha: commitSha });
      return { backend: "github-ref", issueNumber, owner, repository, ref, sha: commitSha };
    } catch (error) {
      // createRef throws on 422 (reference already exists).
      // Treat that as "another daemon holds the lease" so
      // withStaleReclaim can decide whether to reclaim.
      if (error.status === 422) return null;
      throw new Error(`GitHub lease acquisition failed closed for issue #${issueNumber}: ${error?.message ?? String(error)}`);
    }
  }

  async function acquireGitHubWithStaleReclaim(issueNumber, owner) {
    return withStaleReclaim({
      acquire: acquireGitHub,
      backendName: "github-ref",
      inspect: async (n) => {
        const existingSha = await gh.getRef({
          token, repository, ref: `heads/factory/leases/issue-${n}`,
        }).catch(() => null);
        if (!existingSha) return null; // 404, network, perms — refuse to steal
        const existingMessage = await gh.getCommitMessage({
          token, repository, sha: existingSha,
        }).catch(() => null);
        if (!existingMessage) return null;
        const match = existingMessage.match(/^factory-lease\s+issue=(\d+)\s+owner=(\S+)\s+ts=(\S+)/);
        if (!match) return null;
        return { owner: match[2], acquiredAt: match[3] };
      },
      reclaim: async (n) => {
        const ok = await gh.deleteRef({
          token, repository, ref: `heads/factory/leases/issue-${n}`,
        }).catch((err) => {
          log("ERROR", "lease-stale-delete-failed", {
            backend: "github-ref",
            issueNumber: n,
            error: err?.message ?? String(err),
          });
          return false;
        });
        return ok;
      },
    })(issueNumber, owner);
  }

  return Object.freeze({
    acquire(issueNumber, owner) {
      if (!Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) < 0) {
        throw new Error(`Invalid lease issue number: ${issueNumber}`);
      }
      if (!owner) throw new Error("Lease owner is required");
      return repository && token
        ? acquireGitHubWithStaleReclaim(Number(issueNumber), String(owner))
        : acquireFileWithStaleReclaim(Number(issueNumber), String(owner));
    },
    /**
     * Forcibly remove any existing lease for the given issue, regardless of
     * ownership or staleness. Used by `factory-lease acquire --force` for test
     * recovery and operator intervention. Missing leases are a no-op (logged at
     * INFO); unexpected failures (network, permissions) are logged at ERROR and
     * re-thrown so the caller can decide how to handle them.
     */
    async clear(issueNumber) {
      if (!Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) < 0) {
        throw new Error(`Invalid lease issue number: ${issueNumber}`);
      }
      const n = Number(issueNumber);
      if (repository && token) {
        // deleteRef returns true on delete, false on 404/422
        // (GitHub uses 422 in older API versions for DELETE on a
        // non-existent ref). Both are no-ops for force-clear.
        const deleted = await gh.deleteRef({
          token, repository, ref: `heads/factory/leases/issue-${n}`,
        }).catch((err) => {
          log("ERROR", "lease-clear-failed", {
            backend: "github-ref",
            issueNumber: n,
            error: err?.message ?? String(err),
          });
          throw err;
        });
        log(deleted ? "INFO" : "INFO", deleted ? "lease-cleared" : "lease-clear-noop", {
          backend: "github-ref",
          issueNumber: n,
        });
        return;
      }
      // File backend
      const file = path.join(stateDir, "leases", `issue-${n}.lock`);
      try {
        await fs.unlink(file);
        log("INFO", "lease-cleared", { backend: "file", issueNumber: n });
      } catch (error) {
        if (error?.code === "ENOENT") {
          log("INFO", "lease-clear-noop", { backend: "file", issueNumber: n });
          return;
        }
        log("ERROR", "lease-clear-failed", {
          backend: "file",
          issueNumber: n,
          error: error?.message || String(error),
        });
        throw error;
      }
    },
    async release(lease) {
      if (!lease) return;
      try {
        if (lease.backend === "github-ref") {
          const currentSha = await gh.getRef({
            token, repository: lease.repository, ref: `heads/factory/leases/issue-${lease.issueNumber}`,
          });
          if (!lease.sha || currentSha !== lease.sha) {
            throw new Error(`Lease owner mismatch for issue #${lease.issueNumber}`);
          }
          await gh.deleteRef({
            token, repository: lease.repository, ref: `heads/factory/leases/issue-${lease.issueNumber}`,
          });
          return;
        }
        if (lease.backend === "file") {
          const record = JSON.parse(await fs.readFile(lease.file, "utf8"));
          if (record.owner !== lease.owner) throw new Error(`Lease owner mismatch for issue #${lease.issueNumber}`);
          await fs.unlink(lease.file);
        }
      } catch (error) {
        log("ERROR", "lease-release-failed", {
          backend: lease.backend,
          issueNumber: lease.issueNumber,
          owner: lease.owner,
          error: error?.message || String(error),
        });
        throw error;
      }
    },
  });
}
