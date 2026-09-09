import { useEffect, useState } from "react";
import { Pill } from "../components/Chips";
import type { GlobalSettings } from "../data/types";
import { fetchEvents } from "../data/api";

/**
 * SettingsView — global factory config.
 *
 * Three panels: LLM (base url + default model), daemon (poll interval,
 * uptime, process state), and event stream tail (read from the live
 * .factory/daemon.log via /api/events).
 *
 * Form fields are wired to local state — submitting would call into the
 * factory CLI but is intentionally not implemented in the demo.
 */

export interface SettingsViewProps {
    settings: GlobalSettings;
}

export function SettingsView({ settings }: SettingsViewProps) {
    const draft = settings;
    const [logTail, setLogTail] = useState<string>("");


    // Live tail of the daemon log — pulled from /api/events so the
    // preview reflects what's actually in .factory/daemon.log right now.
    useEffect(() => {
        let cancelled = false;
        async function tick() {
            try {
                const events = await fetchEvents();
                if (cancelled) return;
                const lines = events.slice(0, 12).reverse();
                setLogTail(
                    lines
                        .map((e) => {
                            const payload = e.bindings
                                ? " " + JSON.stringify(e.bindings)
                                : "";
                            return `${e.ts.slice(11, 19)}Z ${e.level} ${e.stage} ${e.message}${payload}`;
                        })
                        .join("\n") + "\n",
                );
            } catch {
                if (!cancelled) setLogTail("");
            }
        }
        tick();
        const t = setInterval(tick, 4000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    return (
        <div className="view view--settings">
            <header className="view__header">
                <div>
                    <div className="view__eyebrow mono">SETTINGS · GLOBAL</div>
                    <h1 className="view__title">One factory, one configuration.</h1>
                    <p className="view__sub">
                        This read-only view shows the configuration used by the daemon.
                    </p>
                </div>
            </header>

            <section className="settings-grid">
                <article className="settings-card">
                    <header className="settings-card__head">
                        <h3 className="settings-card__title">LLM provider</h3>
                        <span className="settings-card__hint mono">FACTORY_LLM_*</span>
                    </header>
                    <div className="settings-card__row">
                        <label className="settings-field">
                            <span className="settings-field__label mono">BASE URL</span>
                            <input
                                className="settings-field__input mono"
                                value={draft.baseUrl}
                                readOnly
                            />
                        </label>
                        <label className="settings-field">
                            <span className="settings-field__label mono">DEFAULT MODEL</span>
                            <input
                                className="settings-field__input mono"
                                value={draft.defaultModel}
                                readOnly
                            />
                        </label>
                        <p className="settings-card__note">
                            The base URL and default model are loaded into the agent loop as
                            <span className="mono"> ANTHROPIC_BASE_URL</span> /
                            <span className="mono"> ANTHROPIC_MODEL</span>. Per-agent
                            overrides on the agents page win when set.
                        </p>
                    </div>
                </article>

                <article className="settings-card">
                    <header className="settings-card__head">
                        <h3 className="settings-card__title">Local daemon</h3>
                        <span className="settings-card__hint mono">FACTORY_DAEMON_*</span>
                    </header>
                    <div className="settings-card__row">
                        <div className="settings-card__kv">
                            <span className="settings-card__k mono">STATE</span>
                            <Pill tone={draft.localDaemon.active ? "signal" : "alert"}>
                                {draft.localDaemon.active ? "ACTIVE" : "STOPPED"}
                            </Pill>
                        </div>
                        <div className="settings-card__kv">
                            <span className="settings-card__k mono">PID</span>
                            <span className="settings-card__v mono">{draft.localDaemon.pid ?? "—"}</span>
                        </div>
                        <div className="settings-card__kv">
                            <span className="settings-card__k mono">UPTIME</span>
                            <span className="settings-card__v mono">{formatUptime(draft.localDaemon.uptimeSec)}</span>
                        </div>
                        <div className="settings-card__kv">
                            <span className="settings-card__k mono">WORKDIR</span>
                            <span className="settings-card__v mono">{draft.localDaemon.workdir}</span>
                        </div>
                        <label className="settings-field">
                            <span className="settings-field__label mono">POLL INTERVAL</span>
                            <div className="settings-field__inline">
                                <input
                                    className="settings-field__input mono"
                                    type="number"
                                    min={5}
                                    max={3600}
                                    value={draft.pollIntervalSec}
                                    readOnly
                                />
                                <span className="settings-field__unit mono">SECONDS</span>
                            </div>
                        </label>
                    </div>
                </article>

                <article className="settings-card">
                    <header className="settings-card__head">
                        <h3 className="settings-card__title">Log channel</h3>
                        <span className="settings-card__hint mono">.factory/daemon.log</span>
                    </header>
                    <pre className="settings-card__log mono">
                        {logTail || "(no daemon log yet — start the daemon with .factory-daemon/start.sh)"}
                    </pre>
                </article>
            </section>
        </div>
    );
}

function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
}
