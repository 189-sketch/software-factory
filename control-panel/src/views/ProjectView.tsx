import { useMemo } from "react";
import { Conveyor, STATION_LABELS } from "../components/Conveyor";
import { EventStream } from "../components/EventStream";
import { StagePill } from "../components/Chips";
import { HealthBadge } from "../components/HealthBadge";
import { ConfidenceSparkline } from "../components/ConfidenceSparkline";
import { FallbackBadge } from "../components/FallbackBadge";
import type { FactoryEvent, Project, ProjectIssue } from "../data/types";

/**
 * ProjectView — a single project's pipeline.
 *
 * Two columns:
 *  1. The conveyor, sized to the column, with all the project's issues
 *     parked on their stations.
 *  2. A vertical list of issues. Selecting one highlights it on the
 *     conveyor and reveals its details.
 *
 * Below the conveyor: a horizontal "stage timeline" for the selected
 * issue, plus a strip of recent events scoped to this project.
 */

export interface ProjectViewProps {
    project: Project;
    selectedIssueId: string | null;
    onSelectIssue: (id: string) => void;
    events: FactoryEvent[];
}

export function ProjectView({ project, selectedIssueId, onSelectIssue, events }: ProjectViewProps) {
    const selected = useMemo(
        () => project.issues.find((i) => i.id === selectedIssueId) || project.issues[0],
        [project, selectedIssueId],
    );

    const scopedEvents = events.filter((e) => e.projectId === project.id);

    return (
        <div className="view view--project">
            <header className="view__header">
                <div>
                    <div className="view__eyebrow mono">
                        PROJECT · {project.repo}
                    </div>
                    <h1 className="view__title">{project.name}</h1>
                    <p className="view__sub">
                        Default branch <span className="mono">{project.defaultBranch}</span> ·{" "}
                        {project.issues.length} issues tracked ·{" "}
                        {project.recentThroughput} merged in the last 7 days
                    </p>
                </div>
            </header>

            <section className="project-conveyor">
                <div className="section-head">
                    <h3 className="section-head__title">Conveyor</h3>
                    <div className="section-head__hint mono">
                        CLICK AN ISSUE TO INSPECT ITS RUN
                    </div>
                </div>
                <div className="project-conveyor__svg">
                    <Conveyor
                        issues={project.issues}
                        selectedId={selected?.id}
                        onSelect={onSelectIssue}
                    />
                </div>
            </section>

            <section className="project-grid">
                <aside className="project-issues">
                    <header className="section-head">
                        <h3 className="section-head__title">Issues on this line</h3>
                        <span className="section-head__hint mono">
                            {project.issues.length} TOTAL
                        </span>
                    </header>
                    <ul className="project-issues__list">
                        {project.issues.map((i) => {
                            const isSel = selected?.id === i.id;
                            const stage = i.stages.find((s) => s.id === i.currentStage);
                            return (
                                <li
                                    key={i.id}
                                    className={`project-issues__row ${isSel ? "is-selected" : ""}`}
                                    onClick={() => onSelectIssue(i.id)}
                                >
                                    <div className="project-issues__row-id mono">
                                        #{i.number}
                                    </div>
                                    <div className="project-issues__row-title">{i.title}</div>
                                    <div className="project-issues__row-meta">
                                        <StagePill status={stage?.status || "pending"} />
                                        <span className="mono project-issues__row-stage">
                                            {i.currentStage}
                                        </span>
                                        {/* T10.0: Decision 6 composite health next to per-issue status.
                                            Renders null (no space) until health is persisted. */}
                                        <HealthBadge health={i.health} band={i.healthBand} />
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </aside>

                <main className="project-detail">
                    {selected ? <IssueDetail issue={selected} /> : null}
                </main>
            </section>

            <section className="project-events">
                <header className="section-head">
                    <h3 className="section-head__title">Recent events · {project.name}</h3>
                    <span className="section-head__hint mono">{scopedEvents.length} EVENTS</span>
                </header>
                <EventStream events={scopedEvents} />
            </section>
        </div>
    );
}

function IssueDetail({ issue }: { issue: ProjectIssue }) {
    return (
        <div className="issue-detail">
            <div className="issue-detail__head">
                <div>
                    <div className="issue-detail__eyebrow mono">
                        ISSUE · {issue.id} · {issue.author}
                    </div>
                    <h2 className="issue-detail__title">{issue.title}</h2>
                    {/* T10.0: Decision 6 composite health + per-stage confidence
                        distribution, sitting under the title so the status row above
                        keeps its width. Both render null until signals are persisted. */}
                    <div className="issue-detail__signals">
                        <HealthBadge health={issue.health} band={issue.healthBand} />
                        <ConfidenceSparkline
                            stageConfidence={issue.stageConfidence}
                            fallbackBadges={issue.fallbackBadges}
                        />
                    </div>
                </div>
                <div className="issue-detail__actions">
                    {issue.prUrl && (
                        <a className="btn btn--ghost" href={issue.prUrl} target="_blank" rel="noreferrer">
                            Open PR ↗
                        </a>
                    )}
                    {issue.url && (
                        <a className="btn btn--ghost" href={issue.url} target="_blank" rel="noreferrer">
                            Open issue ↗
                        </a>
                    )}
                </div>
            </div>

            {issue.lastComment && (
                <p className="issue-detail__comment">
                    <span className="issue-detail__comment-label mono">LATEST COMMENT</span>
                    {issue.lastComment}
                </p>
            )}

            <div className="stage-timeline">
                <div className="stage-timeline__rail" />
                {issue.stages.map((s) => {
                    const station = STATION_LABELS.find((x) => x.id === s.id);
                    return (
                        <div key={s.id} className={`stage-timeline__cell stage-timeline__cell--${s.status}`}>
                            <div className="stage-timeline__bulb" />
                            <div className="stage-timeline__cell-head">
                                <span className="stage-timeline__label">{station?.label || s.id}</span>
                                <StagePill status={s.status} />
                                {/* T10.0: per-stage CJK fallback badge — set only when this
                                    stage's last run fell back to claude-code. Null otherwise. */}
                                <FallbackBadge badge={issue.fallbackBadges?.[s.id]} stage={station?.label || s.id} />
                            </div>
                            <div className="stage-timeline__sub mono">
                                {s.startedAt ? startedEnded(s) : s.status === "skipped" ? "skipped" : "—"}
                            </div>
                            <div className="stage-timeline__summary">{s.summary || "—"}</div>
                            {s.artifact && (
                                <div className="stage-timeline__artifact mono">{s.artifact}</div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function startedEnded(s: { startedAt?: string; endedAt?: string; durationMs?: number }): string {
    if (s.durationMs != null) {
        if (s.durationMs < 1000) return `${s.durationMs}ms`;
        const sec = Math.round(s.durationMs / 1000);
        if (sec < 60) return `${sec}s`;
        const min = Math.floor(sec / 60);
        const rest = sec % 60;
        return rest === 0 ? `${min}m` : `${min}m ${rest}s`;
    }
    const s_t = s.startedAt?.slice(11, 16) || "";
    const e_t = s.endedAt?.slice(11, 16) || (s_t ? "…" : "");
    return `${s_t} → ${e_t}`;
}