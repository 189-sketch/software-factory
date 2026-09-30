# factory · control panel

A visual control panel for the multi-agent software factory.

```
npm install
npm run dev        # vite at http://localhost:5174
npm run build      # tsc + vite build to dist/
npm run preview    # serve dist/ for a sanity check
```

> `control-panel/package.json` 的 dev script 是 `vite --host 0.0.0.0 --port 5174`,
> 默认绑定 `0.0.0.0`(即任何可达该机器的接口都可访问控制面板)。
> 如果只在开发机本机使用,请改为 `--host 127.0.0.1` 或加防火墙规则,
> 不要把 5174 端口直接对外网开放。

## It reads real data, not mocks

Development and packaged servers both delegate API requests to `runtime/panel-api.mjs`.
That API builds one `PanelReadModel`, so both delivery paths use the same project registry, state projection, events, metrics, agents, and settings behavior.

The current repository is always project `current`.
Additional projects are declared explicitly in `.factory/projects.json`:

```json
{
  "projects": [
    {
      "id": "secondary",
      "root": "../secondary-repo",
      "name": "Secondary",
      "repo": "acme/secondary",
      "defaultBranch": "main"
    }
  ]
}
```

Each project resolves its own `.factory-daemon/.env` and `FACTORY_STATE_DIR`.
Process-level credentials and model settings may be shared, but current-project path overrides are not allowed to leak into registered projects.

| Path | Source |
| --- | --- |
| `/api/projects` | the current repository plus entries from `.factory/projects.json`, with per-project metrics |
| `/api/projects/:id` | single-project projection (regex match in `runtime/panel-api.mjs`): returns `{project, metrics, issues}` |
| `/api/projects/:id/issues` | `<state-dir>/issues/*.json` plus optional open GitHub issues, deduplicated by issue number |
| `/api/events` | merged checkpoint events and `<state-dir>/daemon.log`, parsed **on each request** (no client-side polling); projected into the conveyor's triage / spec / implementation / review / verify / merge stations via `UI_STAGE_IDS` (`runtime/pipeline-definition.mjs`) |
| `/api/agents` | source or bundled `skills/*/SKILL.md` metadata |
| `/api/settings` | resolved current-project `FactoryConfig` and daemon PID state |
| `/api/decisions` | read-only view of `runtime/decisions.yaml` parsed by `runtime/decisions-loader.mjs`; powers the Routing view with per-action auto/confirm/escalate tiers, composite weights, and CJK fallback conditions |

If a factory has not run yet, the panel renders an honest empty state.

## What it shows

- **Fleet** - every configured project, one card per project with its own conveyor showing where each issue is parked.
- **Project** - a full-width conveyor, issue list, selected issue timeline, and recent project-scoped events.
- **Agents** - the installed agent skills, their descriptions, and resolved model configuration.
- **Routing** - read-only view of `runtime/decisions.yaml`: per-action auto/confirm/escalate confidence tiers, composite weights (spec / impl / review / verify), and the CJK fallback conditions that the orchestrator consults.
- **Settings** - the LLM provider, daemon liveness / poll cadence, and a structured event-stream preview.

## The signature element

The conveyor is a horizontal rail with six station bulbs: Triage, Spec, Implementation, Review, Verify, and Merge.
Each issue parks above its projected station, with a leader line dropping to the belt.
Stacked issues render as one card plus a `+N` indicator.

- **amber** - an agent is currently working at this station.
- **signal green** - every issue at this station has cleared it.
- **alert red** - a review or merge has failed at this station.
- **cool blue** - the station is idle.

## Design language

- **Surface tokens** (`src/styles/tokens.css`) use `--ink`, `--amber`, `--signal`, `--alert`, and `--cool` on a warm blue-black surface.
- **Type pairing** uses Inter for UI labels and JetBrains Mono for identifiers, timestamps, paths, log lines, and metrics.
- **Restraint** keeps the rail as the dominant motif, with minimal shadows and small corner radii.

## Layout

The view is full-width with no maximum-width ceiling.
Breakpoints at 1100px and 720px stack grids instead of squeezing them.
