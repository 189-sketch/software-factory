import type { FallbackBadgeEntry, StageConfidenceEntry, StageId } from "../data/types";

/**
 * ConfidenceSparkline — per-stage typesafe confidence as a tiny SVG
 * histogram, one bar per stage run, keyed on the run id.
 *
 * Plain SVG in the spirit of the Conveyor: deliberate geometry, signal
 * colors from tokens.css, no chart dependency. A bar is `--cool` when the
 * stage's judgment ran on the typesafe primitive and `--amber` when that
 * stage's last run fell back to claude-code (the CJK Fallback Contract
 * downgrade made visible). Stages with no persisted confidence are
 * skipped; when nothing is persisted at all the component renders `null`
 * and reserves no space.
 */

export interface ConfidenceSparklineProps {
    stageConfidence?: Partial<Record<StageId, StageConfidenceEntry>>;
    fallbackBadges?: Partial<Record<StageId, FallbackBadgeEntry>>;
    /** Optional label override for the accessible name. */
    ariaLabel?: string;
}

const BAR_W = 8;
const GAP = 5;
const PLOT_H = 18;
const H = PLOT_H + 4;

export function ConfidenceSparkline({ stageConfidence, fallbackBadges, ariaLabel }: ConfidenceSparklineProps) {
    if (!stageConfidence) return null;
    const bars = (Object.entries(stageConfidence) as Array<[StageId, StageConfidenceEntry]>)
        .filter(([, entry]) => entry && typeof entry.confidence === "number" && entry.confidence !== null)
        .map(([stage, entry]) => ({
            stage,
            runId: entry.runId,
            confidence: Math.min(1, Math.max(0, entry.confidence as number)),
            fellBack: Boolean(fallbackBadges?.[stage]),
        }));
    if (bars.length === 0) return null;

    const W = bars.length * (BAR_W + GAP) - GAP;
    const summary = bars
        .map((b) => `${b.stage} ${b.confidence.toFixed(2)}${b.fellBack ? " (fallback)" : ""}`)
        .join(", ");
    return (
        <svg
            className="confidence-sparkline"
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
            role="img"
            aria-label={ariaLabel ?? `Typesafe confidence per stage run: ${summary}`}
        >
            {bars.map((b, i) => {
                const barH = Math.max(1.5, Math.round(b.confidence * PLOT_H * 10) / 10);
                return (
                    <rect
                        // Keyed on the run id so a re-run of the same stage
                        // remounts its bar instead of silently morphing.
                        key={`${b.stage}:${b.runId ?? "no-run"}`}
                        className={`confidence-sparkline__bar ${b.fellBack ? "confidence-sparkline__bar--fallback" : ""}`}
                        x={i * (BAR_W + GAP)}
                        y={H - 2 - barH}
                        width={BAR_W}
                        height={barH}
                        rx={1}
                    >
                        <title>
                            {`${b.stage} · confidence ${b.confidence.toFixed(2)} · run ${b.runId ?? "—"}${b.fellBack ? " · typesafe fell back to claude-code" : ""}`}
                        </title>
                    </rect>
                );
            })}
        </svg>
    );
}
