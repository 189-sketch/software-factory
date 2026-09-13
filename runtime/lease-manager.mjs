import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function createLeaseManager(options) {
  const run = options.run || exec;
  const repository = String(options.repository || "");
  const token = String(options.token || "");
  const defaultBranch = String(options.defaultBranch || "main");
  const stateDir = path.resolve(options.stateDir);
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

  async function acquireFileWithStaleReclaim(issueNumber, owner) {
    const first = await acquireFile(issueNumber, owner);
    if (first) return first;
    if (!staleMs) return null;

    const file = path.join(stateDir, "leases", `issue-${issueNumber}.lock`);
    let record;
    try {
      record = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      // File vanished between the first and second attempts — treat as not stale.
      return null;
    }
    const acquiredAtMs = Date.parse(record?.acquiredAt || "");
    // Unparseable or missing timestamp — refuse to steal. Operators must delete by hand.
    if (!Number.isFinite(acquiredAtMs)) return null;
    if (Date.now() - acquiredAtMs < staleMs) return null;

    log("WARN", "lease-stale-reclaiming", {
      backend: "file",
      issueNumber,
      existingOwner: record.owner,
      existingAcquiredAt: record.acquiredAt,
      ageMs: Date.now() - acquiredAtMs,
      staleMs,
    });
    try {
      await fs.unlink(file);
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
    }
    return acquireFile(issueNumber, owner); // single retry
  }

  async function acquireGitHub(issueNumber, owner) {
    const ref = `refs/heads/factory/leases/issue-${issueNumber}`;
    const { stdout } = await run("gh", [
      "api", `repos/${repository}/git/ref/heads/${defaultBranch}`, "--jq", ".object.sha",
    ], { encoding: "utf8", env });
    const parentSha = String(stdout || "").trim();
    if (!parentSha) throw new Error(`Cannot resolve ${repository} default branch ${defaultBranch} for lease acquisition`);

    // Every owner receives a dedicated commit so release can compare the current
    // ref target with its receipt before deleting it. staleMs only controls whether
    // a conflicting ref may be reclaimed.
    const { stdout: treeOut } = await run("gh", [
      "api", `repos/${repository}/git/commits/${parentSha}`, "--jq", ".tree.sha",
    ], { encoding: "utf8", env });
    const treeSha = String(treeOut || "").trim();
    if (!treeSha) throw new Error(`Cannot resolve tree for ${parentSha}`);

    const acquiredAt = new Date().toISOString();
    const message = `factory-lease issue=${issueNumber} owner=${owner} ts=${acquiredAt}`;
    const { stdout: commitOut } = await run("gh", [
      "api", "--method", "POST", `repos/${repository}/git/commits`,
      "-f", `message=${message}`,
      "-f", `tree=${treeSha}`,
      "-f", `parents[]=${parentSha}`,
      "--jq", ".sha",
    ], { encoding: "utf8", env });
    const commitSha = String(commitOut || "").trim();
    if (!commitSha) throw new Error(`Cannot create lease commit for issue #${issueNumber}`);

    try {
      await run("gh", [
        "api", "--method", "POST", `repos/${repository}/git/refs`,
        "-f", `ref=${ref}`, "-f", `sha=${commitSha}`,
      ], { encoding: "utf8", env });
      return { backend: "github-ref", issueNumber, owner, repository, ref, sha: commitSha };
    } catch (error) {
      const message = `${error?.message || ""}\n${error?.stderr || ""}`;
      if (/already exists|reference already exists|HTTP 422/i.test(message)) return null;
      throw new Error(`GitHub lease acquisition failed closed for issue #${issueNumber}: ${message.trim()}`);
    }
  }

  async function acquireGitHubWithStaleReclaim(issueNumber, owner) {
    const first = await acquireGitHub(issueNumber, owner);
    if (first) return first;
    if (!staleMs) return null;

    let existingCommitSha;
    try {
      const { stdout } = await run("gh", [
        "api", `repos/${repository}/git/ref/heads/factory/leases/issue-${issueNumber}`, "--jq", ".object.sha",
      ], { encoding: "utf8", env });
      existingCommitSha = String(stdout || "").trim();
    } catch {
      // Ref GET failed (404, network, permissions) — refuse to risk stealing an active lease.
      return null;
    }
    if (!existingCommitSha) return null;

    let existingMessage;
    try {
      const { stdout } = await run("gh", [
        "api", `repos/${repository}/git/commits/${existingCommitSha}`, "--jq", ".message",
      ], { encoding: "utf8", env });
      existingMessage = String(stdout || "");
    } catch {
      return null;
    }

    const match = existingMessage.match(/^factory-lease\s+issue=(\d+)\s+owner=(\S+)\s+ts=(\S+)/);
    if (!match) return null; // Not our format — could be a human-created ref. Refuse to delete.
    const acquiredAtMs = Date.parse(match[3]);
    if (!Number.isFinite(acquiredAtMs)) return null;
    if (Date.now() - acquiredAtMs < staleMs) return null;

    log("WARN", "lease-stale-reclaiming", {
      backend: "github-ref",
      issueNumber,
      existingOwner: match[2],
      existingAcquiredAt: match[3],
      ageMs: Date.now() - acquiredAtMs,
      staleMs,
    });
    try {
      await run("gh", [
        "api", "--method", "DELETE",
        `repos/${repository}/git/refs/heads/factory/leases/issue-${issueNumber}`,
      ], { encoding: "utf8", env });
    } catch (error) {
      log("ERROR", "lease-stale-delete-failed", {
        backend: "github-ref",
        issueNumber,
        error: error?.message || String(error),
      });
      return null;
    }
    return acquireGitHub(issueNumber, owner); // single retry
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
        try {
          await run("gh", [
            "api", "--method", "DELETE",
            `repos/${repository}/git/refs/heads/factory/leases/issue-${n}`,
          ], { encoding: "utf8", env });
          log("INFO", "lease-cleared", { backend: "github-ref", issueNumber: n });
          return;
        } catch (error) {
          const message = `${error?.message || ""}\n${error?.stderr || ""}`;
          // GitHub returns different status codes for "ref doesn't exist":
          //   404 — ref head doesn't exist
          //   422 — "Reference does not exist" (raised when DELETE is issued
          //         against a non-existent ref in older API versions)
          // Treat both as a successful no-op so force-clear doesn't error out
          // on first-startup or when another daemon already removed the ref.
          if (/not found|HTTP 404|Reference does not exist|HTTP 422/i.test(message)) {
            log("INFO", "lease-clear-noop", { backend: "github-ref", issueNumber: n });
            return;
          }
          log("ERROR", "lease-clear-failed", {
            backend: "github-ref",
            issueNumber: n,
            error: error?.message || String(error),
          });
          throw error;
        }
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
          const { stdout } = await run("gh", [
            "api", `repos/${lease.repository}/git/ref/heads/factory/leases/issue-${lease.issueNumber}`, "--jq", ".object.sha",
          ], { encoding: "utf8", env });
          const currentSha = String(stdout || "").trim();
          if (!lease.sha || currentSha !== lease.sha) {
            throw new Error(`Lease owner mismatch for issue #${lease.issueNumber}`);
          }
          await run("gh", [
            "api", "--method", "DELETE",
            `repos/${lease.repository}/git/refs/heads/factory/leases/issue-${lease.issueNumber}`,
          ], { encoding: "utf8", env });
          return;
        }
        if (lease.backend === "file") {
          const record = JSON.parse(await fs.readFile(lease.file, "utf8"));
          if (record.owner !== lease.owner) throw new Error(`Lease owner mismatch for issue #${lease.issueNumber}`);
          await fs.unlink(lease.file);
        }
      } catch (error) {
        // Layer 1: surface release failures as ERROR. Re-throw to preserve the
        // existing exception-propagation contract for callers' finally blocks.
        log("ERROR", "lease-release-failed", {
          backend: lease.backend,
          issueNumber: lease.issueNumber,
          owner: lease.owner,
          error: error?.message || String(error),
          stderr: error?.stderr ? String(error.stderr).slice(-2000) : undefined,
        });
        throw error;
      }
    },
  });
}
