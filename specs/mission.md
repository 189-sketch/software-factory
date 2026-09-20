# Mission

## Core Mission

Drive an autonomous, multi-agent software factory that turns GitHub Issues into reviewed, merged code changes through a deterministic, auditable pipeline.

## Value Proposition

- Six specialised agents — triage, spec, implementation, review-spec, review-pr, verify-behavior, improve-review-pr — collaborate on every issue through a shared issue-scoped session.
- A single local daemon owns repository-level write authority, applies atomic checkpoints, and coordinates workers so two daemons never silently conflict on the same repository.
- A reusable Harness runtime replaces per-stage Agent instances, giving every role persistent context, lane-level isolation, and tool-call auditing across retries and restarts.
- Strict versioned inputs — requirement baselines, finding lists, decision records, and artifact revisions — make every retry and reviewer round fully traceable instead of guessed from free-form history.
- A bundled visual control panel exposes the live state of issues, pipelines, and external operations for human supervisors.

## Target Users

- Engineering teams that already manage work in GitHub Issues and want a CI-grade automation layer that closes the loop from triage to merge.
- Solo maintainers who need a reviewable, recoverable execution trail when delegating routine tasks to LLM agents.
- Open-source projects that want a single-command installer (`factory install`) that provisions a daemon, an `.env`, and optional systemd/Windows services in a target repository.

## Success Metrics / KPIs

- Every completed issue carries an artifact revision, a reviewer finding log, and a verification receipt; missing fields never appear as `completed`.
- No duplicate external side effects — comments, branches, PRs, and merges only fire after the previous attempt's outcome is reconciled.
- `load_skill` and other tool calls pass schema validation on the first attempt; the harness refuses unknown or schema-missing tools at startup instead of running them as no-ops.
- Worker lease release failures never mask content results, and stale leases are reclaimed by TTL rather than by hard-kill probes.
- The control panel can answer "why is this issue waiting, which artifact version is being reviewed, what is the next attempt time" without reading three separate log files.

## Why This Project Exists

Most LLM coding loops fail in the seams between stages: tools are registered with no contract, retries lose prior feedback, and external GitHub operations can be replayed after a crash.
The factory treats those seams as first-class concerns, builds the agents on top of a shared Harness session, and ships the infrastructure needed to install, run, and observe the loop on a real target repository.