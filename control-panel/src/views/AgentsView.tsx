import { useState } from "react";
import { Pill } from "../components/Chips";
import type { AgentConfig } from "../data/types";

/**
 * AgentsView — the agent library.
 *
 * Each agent gets a card with:
 *   - the SKILL.md body, rendered as Markdown-ish text,
 *   - the live LLM config (model + base URL + mode),
 *   - any sub-skills it loads,
 *   - a per-agent prompt override (if any).
 *
 * Editing happens in the panel; we render the diff visually but don't
 * persist in this demo. The contract is the same one the orchestrator
 * would consume: a runtime config that overrides the skill defaults.
 */

export interface AgentsViewProps {
    agents: AgentConfig[];
    baseUrl: string;
    defaultModel: string;
}

export function AgentsView({ agents, baseUrl, defaultModel }: AgentsViewProps) {
    const [selectedId, setSelectedId] = useState(agents[0]?.id || "");
    const selected = agents.find((a) => a.id === selectedId);

    return (
        <div className="view view--agents">
            <header className="view__header">
                <div>
                    <div className="view__eyebrow mono">AGENTS · LIBRARY</div>
                    <h1 className="view__title">Six independent agents, one per skill.</h1>
                    <p className="view__sub">
                        Each production capability runs a model-driven tool loop and loads its SKILL.md.
                    </p>
                </div>
            </header>

            <div className="agents-grid">
                <aside className="agents-list">
                    {agents.map((a) => (
                        <button
                            key={a.id}
                            className={`agents-list__row ${selectedId === a.id ? "is-selected" : ""}`}
                            onClick={() => setSelectedId(a.id)}
                        >
                            <div className="agents-list__row-head">
                                <span className="agents-list__row-name">{a.label}</span>
                                <Pill tone={a.mode === "llm" ? "amber" : "cool"}>{a.mode.toUpperCase()}</Pill>
                            </div>
                            <div className="agents-list__row-skill mono">{a.skillPath}</div>
                            <div className="agents-list__row-tags">
                                {a.tags.map((t) => (
                                    <span key={t} className="agents-list__row-tag mono">{t}</span>
                                ))}
                            </div>
                        </button>
                    ))}
                </aside>

                {selected && (
                    <article className="agent-detail">
                        <header className="agent-detail__head">
                            <div>
                                <div className="agent-detail__eyebrow mono">
                                    AGENT · {selected.id.toUpperCase()}
                                </div>
                                <h2 className="agent-detail__title">{selected.label}</h2>
                                <div className="agent-detail__sub mono">{selected.skillPath}</div>
                            </div>
                            <div className="agent-detail__toggles">
                                <label className="agent-detail__toggle">
                                    <span className="agent-detail__toggle-label">ENABLED</span>
                                    <input
                                        type="checkbox"
                                        checked={selected.enabled}
                                        disabled
                                        readOnly
                                        className="agent-detail__toggle-input"
                                    />
                                </label>
                            </div>
                        </header>

                        <section className="agent-detail__row">
                            <div className="agent-detail__cell">
                                <div className="agent-detail__cell-label mono">MODE</div>
                                <div className="agent-detail__cell-value">{selected.mode.toUpperCase()}</div>
                            </div>
                            <div className="agent-detail__cell">
                                <div className="agent-detail__cell-label mono">MODEL</div>
                                <div className="agent-detail__cell-value mono">{selected.model}</div>
                            </div>
                            <div className="agent-detail__cell agent-detail__cell--wide">
                                <div className="agent-detail__cell-label mono">BASE URL</div>
                                <div className="agent-detail__cell-value mono" title={baseUrl}>{baseUrl}</div>
                            </div>
                            <div className="agent-detail__cell">
                                <div className="agent-detail__cell-label mono">FALLBACK MODEL</div>
                                <div className="agent-detail__cell-value mono">{defaultModel}</div>
                            </div>
                        </section>

                        {selected.subSkills && selected.subSkills.length > 0 && (
                            <section className="agent-detail__subsection">
                                <div className="agent-detail__subsection-head mono">
                                    SUB-SKILLS LOADED BY THIS AGENT
                                </div>
                                <div className="agent-detail__chips">
                                    {selected.subSkills.map((s) => (
                                        <span key={s} className="agent-detail__chip mono">
                                            {s}
                                        </span>
                                    ))}
                                </div>
                            </section>
                        )}

                        {selected.tools && selected.tools.length > 0 && (
                            <section className="agent-detail__subsection">
                                <div className="agent-detail__subsection-head mono">
                                    TOOL WHITELIST
                                </div>
                                <div className="agent-detail__chips">
                                    {selected.tools.map((s) => (
                                        <span key={s} className="agent-detail__chip mono">
                                            {s}
                                        </span>
                                    ))}
                                </div>
                            </section>
                        )}

                        <section className="agent-detail__subsection">
                            <div className="agent-detail__subsection-head mono">
                                SKILL.md
                            </div>
                            <pre className="agent-detail__skill mono">{selected.skillBody}</pre>
                        </section>

                        <section className="agent-detail__subsection">
                            <div className="agent-detail__subsection-head mono">
                                PROMPT OVERRIDE
                                <span className="agent-detail__subsection-hint">
                                    read-only runtime view
                                </span>
                            </div>
                            {selected.promptOverride ? (
                                <pre className="agent-detail__skill mono">{selected.promptOverride}</pre>
                            ) : (
                                <div className="agent-detail__empty mono">
                                    (none — using skill defaults)
                                </div>
                            )}
                        </section>
                    </article>
                )}
            </div>
        </div>
    );
}
