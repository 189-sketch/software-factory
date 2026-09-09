# Running the factory against GitHub

This guide describes the current production path.
Simulation mode is not accepted as review, verification, or merge evidence.

## Prerequisites

- Node.js 20 or newer.
- Git and the GitHub CLI.
- A clean clone of the target repository.
- A GitHub token that can read issues and create branches and pull requests.
- An Anthropic-compatible model endpoint, token, and model ID.
- An isolated worker for implementation and verification commands.

## Local daemon configuration

Install the package into the target repository and edit `.factory-daemon/.env`.

```dotenv
FACTORY_GH_REPO=<owner>/<repo>
FACTORY_POLL_INTERVAL=30
FACTORY_TRUSTED_EXECUTION=1
FACTORY_AUTO_MERGE=0
GH_TOKEN=<token>
ANTHROPIC_AUTH_TOKEN=<model-token>
ANTHROPIC_BASE_URL=<anthropic-compatible-base-url>
ANTHROPIC_MODEL=<model-id>
```

The factory always runs in `llm` mode; `FACTORY_AGENT_MODE` is no longer recognised.

The daemon fails closed if the three model values are incomplete.
It does not silently switch to rule-based output.
Automatic merge stays disabled unless `FACTORY_AUTO_MERGE=1` is explicitly configured.

Start one polling cycle from the target repository.

```bash
factory start --once
```

Continuous mode uses `.factory/daemon.pid` as a singleton lock.

```bash
factory start --panel --port 5174
```

## Agent and evidence boundaries

Six production capabilities use the model-driven `pi-agent-core` loop.

1. Triage inspects the issue and repository through read-only tools.
2. Specification produces validated `PRODUCT.md` and `TECH.md`, then opens a separate spec PR.
3. Implementation edits the target checkout, executes regression checks, and publishes the validated commit.
4. Code review inspects the annotated diff and repository independently.
5. Behavior verification executes acceptance tests and, when configured, browser assertions.
6. Review improvement classifies real human feedback and opens a guidance proposal PR for human approval.

The factory runs exclusively in `llm` mode against the configured ModelAdapter.
Test runs use the built-in echo adapter (`FACTORY_MODEL_ADAPTER=echo`) which returns deterministic scripted responses so the pipeline can be exercised without burning real model credits.

## `needs-info` resumption

The daemon stores complete Issue comments in `.factory/issues/<number>.json`.
An Issue labeled `needs-info` remains idle while its body and comments are unchanged.
Editing the Issue or adding a comment causes a new triage Agent run.
A new actionable decision removes the stale label and resumes the pipeline.

The cloud triage workflow also listens to `issue_comment.created`.
It reloads the complete Issue context before rerunning triage.

## Durable gates

The canonical checkpoint is `.factory/issues/<number>.json`.
Review and verification results are bound to the implementation commit SHA.
Review is also bound to the base branch SHA.
A changed implementation invalidates both results.
Merge requires `APPROVE`, `verified`, and the same remote head commit.
`partially-verified`, startup success, screenshots, and Agent prose are not merge evidence.

Agent traces are written under `.factory/traces/`.
Behavior receipts and visual evidence are written under the issue work directory recorded by `.factory/state-<number>.json`.

## GitHub Actions mode

`factory install --mode cloud` copies four event workflows and the daily improvement workflow.
Configure these repository secrets:

- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_MODEL`
- `FACTORY_VERIFY_URL` when browser verification is required

Optionally configure the `FACTORY_VERIFY_COMMAND` repository variable.
The workflows build Issue JSON from GitHub event files or `gh` JSON output, so Issue titles, bodies, and comments are not interpolated into shell programs.
The review workflow posts the validated `review.json` through GitHub's pull-request review API.

Do not run cloud and local consumers for the same repository unless their ownership and concurrency are coordinated.

## Verification

Check local state and GitHub artifacts.

```bash
gh issue view <number> --repo <owner>/<repo>
gh pr list --repo <owner>/<repo>
gh run list --repo <owner>/<repo>
```

Run repository validation before releasing the factory package.

```bash
npm test
npx tsc --noEmit
npx tsc -p control-panel/tsconfig.json --noEmit
npm run test:cli
```
