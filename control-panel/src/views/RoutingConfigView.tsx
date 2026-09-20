import { useEffect, useState } from "react";
import { Pill } from "../components/Chips";

/**
 * RoutingConfigView — read-only viewer for `runtime/decisions.yaml` (T10.1).
 *
 * Fetches `GET /api/decisions` (served by `runtime/panel-api.mjs` via
 * `runtime/decisions-loader.mjs`) and renders:
 * - the per-action auto / confirm / escalate threshold table,
 * - the composite scoring weights (with the sum),
 * - the CJK fallback block (trigger conditions + fallback backend).
 *
 * Strictly read-only: this page renders no edit controls. Editing
 * happens in `runtime/decisions.yaml` on the factory host, and the
 * daemon-side startup pre-check rejects invalid files.
 *
 * Standalone on purpose: wire types + fetch live in this file so the
 * shared `data/api.ts` / `data/types.ts` modules stay untouched.
 */

/* -------------------------------------------------------------------------- */
/* Wire types (shape returned by GET /api/decisions)                          */
/* -------------------------------------------------------------------------- */

interface DecisionTierWire {
    confidence_min?: number;
    confidence_max?: number;
    noul_yes_max?: number;
    noul_yes_min?: number;
    blocking_findings_max?: number;
    retryable_class_only?: boolean;
    target?: string;
    channel?: string;
    prompt?: string;
}

interface DecisionRuleWire {
    action: string;
    auto?: DecisionTierWire;
    confirm?: DecisionTierWire;
    escalate?: DecisionTierWire;
}

type CjkConditionWire =
    | string
    | { typesafe_confidence_below?: { action?: string; threshold?: number } };

interface DecisionsWire {
    version: number;
    decisions: DecisionRuleWire[];
    composite: Record<string, number>;
    fallback?: {
        cjk?: {
            trigger?: string;
            conditions?: CjkConditionWire[];
            fallback_backend?: string;
            log_warning?: string;
        };
    };
}

/** Threshold keys in display order (mirrors the YAML schema). */
const TIER_KEY_ORDER = [
    "confidence_min",
    "confidence_max",
    "noul_yes_max",
    "noul_yes_min",
    "blocking_findings_max",
    "retryable_class_only",
    "target",
    "channel",
    "prompt",
] as const;

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function RoutingConfigView() {
    const [data, setData] = useState<DecisionsWire | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        async function load() {
            try {
                const r = await fetch("/api/decisions");
                if (!r.ok) {
                    const body = await r.json().catch(() => null);
                    const detail = body && typeof body === "object" && "detail" in body
                        ? String((body as { detail?: unknown }).detail ?? "")
                        : "";
                    throw new Error(
                        `${r.status} ${r.statusText} for /api/decisions${detail ? ` — ${detail}` : ""}`,
                    );
                }
                const parsed = (await r.json()) as DecisionsWire;
                if (!cancelled) {
                    setData(parsed);
                    setError(null);
                }
            } catch (err) {
                if (!cancelled) setError(String(err));
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, []);

    if (error) {
        return (
            <div className="view view--routing">
                <RoutingHeader />
                <div className="empty-state">decisions.yaml unavailable: {error}</div>
            </div>
        );
    }
    if (!data) {
        return (
            <div className="view view--routing">
                <RoutingHeader />
                <div className="empty-state">Loading runtime/decisions.yaml …</div>
            </div>
        );
    }

    const cjk = data.fallback?.cjk;
    const compositeSum = Object.values(data.composite ?? {}).reduce((a, b) => a + b, 0);

    return (
        <div className="view view--routing">
            <RoutingHeader />

            <section>
                <header className="section-head">
                    <h3 className="section-head__title">Per-action routing thresholds</h3>
                    <div className="section-head__hint mono">
                        {data.decisions.length} ACTIONS · SCHEMA v{data.version}
                    </div>
                </header>
                <table className="issues-table">
                    <thead>
                        <tr>
                            <th>ACTION</th>
                            <th>AUTO</th>
                            <th>CONFIRM</th>
                            <th>ESCALATE</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.decisions.map((rule) => (
                            <tr key={rule.action}>
                                <td className="issues-table__title mono">{rule.action}</td>
                                <td><TierCell tier={rule.auto} /></td>
                                <td><TierCell tier={rule.confirm} /></td>
                                <td><TierCell tier={rule.escalate} /></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>

            <section className="settings-grid">
                <article className="settings-card">
                    <header className="settings-card__head">
                        <h3 className="settings-card__title">Composite weights</h3>
                        <span className="settings-card__hint mono">DECISION 6</span>
                    </header>
                    <div className="settings-card__row">
                        {["spec", "impl", "review", "verify"].map((key) => (
                            <div className="settings-card__kv" key={key}>
                                <span className="settings-card__k mono">{key.toUpperCase()}</span>
                                <span className="settings-card__v mono">
                                    {formatWeight(data.composite?.[key])}
                                </span>
                            </div>
                        ))}
                        <div className="settings-card__kv">
                            <span className="settings-card__k mono">SUM</span>
                            <Pill tone={Math.abs(compositeSum - 1.0) <= 0.01 ? "signal" : "alert"}>
                                {compositeSum.toFixed(2)}
                            </Pill>
                        </div>
                        <p className="settings-card__note">
                            Weights must sum to 1.0 ± 0.01 — the daemon-side startup
                            pre-check rejects the file otherwise.
                        </p>
                    </div>
                </article>

                <article className="settings-card">
                    <header className="settings-card__head">
                        <h3 className="settings-card__title">CJK fallback</h3>
                        <span className="settings-card__hint mono">DECISION 7 · fallback.cjk</span>
                    </header>
                    <div className="settings-card__row">
                        <div className="settings-card__kv">
                            <span className="settings-card__k mono">TRIGGER</span>
                            <span className="settings-card__v mono">{cjk?.trigger ?? "—"}</span>
                        </div>
                        <div className="settings-card__kv">
                            <span className="settings-card__k mono">FALLBACK BACKEND</span>
                            <span className="settings-card__v mono">{cjk?.fallback_backend ?? "—"}</span>
                        </div>
                        <div className="settings-card__kv">
                            <span className="settings-card__k mono">LOG WARNING</span>
                            <span className="settings-card__v mono">{cjk?.log_warning ?? "—"}</span>
                        </div>
                        <div className="settings-card__kv">
                            <span className="settings-card__k mono">CONDITIONS</span>
                            <span className="settings-card__v">
                                {(cjk?.conditions ?? []).map((cond, i) => (
                                    <span className="mono" key={i} style={{ display: "block" }}>
                                        {formatCondition(cond)}
                                    </span>
                                ))}
                            </span>
                        </div>
                    </div>
                </article>
            </section>
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function RoutingHeader() {
    return (
        <header className="view__header">
            <div>
                <div className="view__eyebrow mono">ROUTING · CONFIGURATION</div>
                <h1 className="view__title">Every threshold the orchestrator obeys.</h1>
                <p className="view__sub">
                    Live view of <span className="mono">runtime/decisions.yaml</span>.
                    Editing happens in that file on the factory host — the panel never
                    writes it; the daemon re-validates the schema at startup.
                </p>
            </div>
            <Pill tone="cool">READ-ONLY</Pill>
        </header>
    );
}

function TierCell({ tier }: { tier?: DecisionTierWire }) {
    if (!tier) return <span className="mono" style={{ color: "var(--text-mute)" }}>—</span>;
    const entries = TIER_KEY_ORDER
        .map((key) => [key, tier[key]] as const)
        .filter(([, value]) => value !== undefined);
    if (entries.length === 0) return <span className="mono" style={{ color: "var(--text-mute)" }}>—</span>;
    return (
        <div className="mono">
            {entries.map(([key, value]) => (
                <span key={key} style={{ display: "block", whiteSpace: "nowrap" }}>
                    <span style={{ color: "var(--text-mute)" }}>{key}</span>{" "}
                    {key === "prompt" ? `“${String(value)}”` : formatValue(value)}
                </span>
            ))}
        </div>
    );
}

function formatValue(value: unknown): string {
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);
    return String(value ?? "—");
}

function formatWeight(value: number | undefined): string {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

function formatCondition(cond: CjkConditionWire): string {
    if (typeof cond === "string") return cond;
    const inner = cond?.typesafe_confidence_below;
    if (inner) {
        return `typesafe_confidence_below · ${inner.action ?? "?"} < ${inner.threshold ?? "?"}`;
    }
    return JSON.stringify(cond);
}
