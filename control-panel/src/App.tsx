import { useEffect, useMemo, useState } from "react";
import { fetchAgents, fetchEvents, fetchProjects, fetchSettings } from "./data/api";
import type { AgentConfig, FactoryEvent, GlobalSettings, Project } from "./data/types";
import { FleetView } from "./views/FleetView";
import { ProjectView } from "./views/ProjectView";
import { AgentsView } from "./views/AgentsView";
import { SettingsView } from "./views/SettingsView";
import { Pill } from "./components/Chips";

type Route =
    | { kind: "fleet" }
    | { kind: "project"; projectId: string }
    | { kind: "agents" }
    | { kind: "settings" };

const DEFAULT_SETTINGS: GlobalSettings = {
    baseUrl: "",
    defaultModel: "",
    pollIntervalSec: 30,
    localDaemon: { active: false, pid: null, uptimeSec: 0, workdir: "" },
};

export function App() {
    const [route, setRoute] = useState<Route>({ kind: "fleet" });
    const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
    const [projects, setProjects] = useState<Project[]>([]);
    const [agents, setAgents] = useState<AgentConfig[]>([]);
    const [events, setEvents] = useState<FactoryEvent[]>([]);
    const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_SETTINGS);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());

    // Initial fetch + periodic refresh. The dashboard re-reads every few
    // seconds so daemon activity is reflected without manual reload.
    useEffect(() => {
        let cancelled = false;
        async function tick() {
            try {
                const [p, a, e, s] = await Promise.all([
                    fetchProjects(),
                    fetchAgents(),
                    fetchEvents(),
                    fetchSettings(),
                ]);
                if (cancelled) return;
                setProjects(p);
                setAgents(a);
                setEvents(e);
                setSettings(s);
                setNow(Date.now());
                setLoaded(true);
                setError(null);
            } catch (err) {
                if (!cancelled) setError(String(err));
            }
        }
        tick();
        const t = setInterval(tick, 4000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    const project: Project | undefined = useMemo(
        () => (route.kind === "project" ? projects.find((p) => p.id === route.projectId) : undefined),
        [route, projects],
    );

    function gotoFleet() {
        setRoute({ kind: "fleet" });
        setSelectedIssueId(null);
    }
    function gotoProject(projectId: string) {
        setRoute({ kind: "project", projectId });
        setSelectedIssueId(null);
    }

    return (
        <div className="app">
            <TopBar
                route={route}
                now={now}
                settings={settings}
                onHome={gotoFleet}
                onAgents={() => setRoute({ kind: "agents" })}
                onSettings={() => setRoute({ kind: "settings" })}
            />

            <div className="app__body">
                <Sidebar
                    route={route}
                    projects={projects}
                    onSelectProject={(id) => gotoProject(id)}
                    onFleet={gotoFleet}
                    onAgents={() => setRoute({ kind: "agents" })}
                    onSettings={() => setRoute({ kind: "settings" })}
                    settings={settings}
                />

                <main className="app__main">
                    {!loaded ? (
                        <div className="empty-state">
                            {error ? `Factory API unreachable: ${error}` : "Loading from /api …"}
                        </div>
                    ) : route.kind === "fleet" ? (
                        <FleetView
                            projects={projects}
                            onSelectProject={(id) => gotoProject(id)}
                            onSelectIssue={(_, id) => {
                                const proj = projects.find((p) => p.issues.some((i) => i.id === id));
                                if (proj) {
                                    setRoute({ kind: "project", projectId: proj.id });
                                    setSelectedIssueId(id);
                                }
                            }}
                        />
                    ) : route.kind === "project" && project ? (
                        <ProjectView
                            project={project}
                            selectedIssueId={selectedIssueId}
                            onSelectIssue={setSelectedIssueId}
                            events={events}
                        />
                    ) : route.kind === "project" ? (
                        <div className="empty-state">
                            Project not found. {projects.length === 0 ? "The factory has no projects configured." : ""}
                        </div>
                    ) : route.kind === "agents" ? (
                        <AgentsView
                            agents={agents}
                            baseUrl={settings.baseUrl}
                            defaultModel={settings.defaultModel}
                        />
                    ) : (
                        <SettingsView settings={settings} />
                    )}
                </main>
            </div>
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/* Top bar                                                                    */
/* -------------------------------------------------------------------------- */

function TopBar({
    route,
    now,
    settings,
    onHome,
    onAgents,
    onSettings,
}: {
    route: Route;
    now: number;
    settings: GlobalSettings;
    onHome: () => void;
    onAgents: () => void;
    onSettings: () => void;
}) {
    const breadcrumb =
        route.kind === "fleet"
            ? "FLEET"
            : route.kind === "project"
            ? `PROJECT · ${route.projectId.toUpperCase()}`
            : route.kind === "agents"
            ? "AGENTS"
            : "SETTINGS";

    return (
        <header className="topbar">
            <button className="topbar__brand" onClick={onHome}>
                <span className="topbar__brand-mark" aria-hidden="true">
                    <span className="topbar__brand-mark-dot topbar__brand-mark-dot--amber" />
                    <span className="topbar__brand-mark-line" />
                    <span className="topbar__brand-mark-dot topbar__brand-mark-dot--signal" />
                </span>
                <span className="topbar__brand-text">
                    <span className="topbar__brand-text-top">factory</span>
                    <span className="topbar__brand-text-bottom">control panel</span>
                </span>
            </button>

            <div className="topbar__center">
                <span className="topbar__crumb mono">{breadcrumb}</span>
            </div>

            <div className="topbar__right">
                <div className="topbar__clock">
                    <span className="topbar__clock-label mono">LOCAL TIME</span>
                    <span className="topbar__clock-value mono">{formatClock(now)}</span>
                </div>
                <Pill tone={settings.localDaemon.active ? "signal" : "alert"}>
                    {settings.localDaemon.active ? "DAEMON ONLINE" : "DAEMON OFFLINE"}
                </Pill>
                <button className="topbar__btn" onClick={onAgents}>
                    Agents
                </button>
                <button className="topbar__btn" onClick={onSettings}>
                    Settings
                </button>
            </div>
        </header>
    );
}

function formatClock(ms: number) {
    const d = new Date(ms);
    return d.toISOString().slice(11, 19) + "Z";
}

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                    */
/* -------------------------------------------------------------------------- */

function Sidebar({
    route,
    projects,
    onSelectProject,
    onFleet,
    onAgents,
    onSettings,
    settings,
}: {
    route: Route;
    projects: Project[];
    onSelectProject: (id: string) => void;
    onFleet: () => void;
    onAgents: () => void;
    onSettings: () => void;
    settings: GlobalSettings;
}) {
    const activeProjectId = route.kind === "project" ? route.projectId : null;

    return (
        <aside className="sidebar">
            <nav className="sidebar__nav">
                <button
                    className={`sidebar__nav-item ${route.kind === "fleet" ? "is-active" : ""}`}
                    onClick={onFleet}
                >
                    <span className="sidebar__nav-marker" aria-hidden="true" />
                    <span className="sidebar__nav-label">Fleet</span>
                    <span className="sidebar__nav-count mono">{projects.length}</span>
                </button>
                <button
                    className={`sidebar__nav-item ${route.kind === "agents" ? "is-active" : ""}`}
                    onClick={onAgents}
                >
                    <span className="sidebar__nav-marker" aria-hidden="true" />
                    <span className="sidebar__nav-label">Agents</span>
                    <span className="sidebar__nav-count mono">6</span>
                </button>
                <button
                    className={`sidebar__nav-item ${route.kind === "settings" ? "is-active" : ""}`}
                    onClick={onSettings}
                >
                    <span className="sidebar__nav-marker" aria-hidden="true" />
                    <span className="sidebar__nav-label">Settings</span>
                </button>
            </nav>

            <div className="sidebar__group">
                <div className="sidebar__group-head">
                    <span className="sidebar__group-title">Projects</span>
                    <span className="sidebar__group-count mono">{projects.length}</span>
                </div>
                <ul className="sidebar__projects">
                    {projects.map((p) => {
                        const activeCount = p.issues.filter((i) =>
                            i.stages.some((s) => s.status === "running"),
                        ).length;
                        const isActive = p.id === activeProjectId;
                        return (
                            <li key={p.id}>
                                <button
                                    className={`sidebar__project ${isActive ? "is-active" : ""}`}
                                    onClick={() => onSelectProject(p.id)}
                                >
                                    <span className="sidebar__project-row">
                                        <span className="sidebar__project-name">{p.name}</span>
                                        <span
                                            className={`sidebar__project-lede ${
                                                activeCount > 0 ? "is-running" : ""
                                            }`}
                                            aria-hidden="true"
                                        />
                                    </span>
                                    <span className="sidebar__project-repo mono">{p.repo}</span>
                                    <span className="sidebar__project-meta mono">
                                        {p.issues.length} ISSUES · {activeCount} RUNNING
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </div>

            <div className="sidebar__group">
                <div className="sidebar__group-head">
                    <span className="sidebar__group-title">Pipeline stages</span>
                </div>
                <ul className="sidebar__stages mono">
                    <li><span className="sidebar__stage-bulb sidebar__stage-bulb--signal" /> Triage → Spec → Implementation</li>
                    <li><span className="sidebar__stage-bulb sidebar__stage-bulb--amber" /> Review</li>
                    <li><span className="sidebar__stage-bulb sidebar__stage-bulb--signal" /> Verify Behavior</li>
                    <li><span className="sidebar__stage-bulb sidebar__stage-bulb--cool" /> Improve Review PR · daily</li>
                </ul>
            </div>

            <div className="sidebar__footer">
                <div className="sidebar__footer-row">
                    <span className="sidebar__footer-label mono">DEFAULT MODEL</span>
                    <span className="sidebar__footer-value mono">{settings.defaultModel}</span>
                </div>
                <div className="sidebar__footer-row">
                    <span className="sidebar__footer-label mono">POLL INTERVAL</span>
                    <span className="sidebar__footer-value mono">{settings.pollIntervalSec}s</span>
                </div>
            </div>
        </aside>
    );
}
