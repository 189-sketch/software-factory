import type { HealthBand } from "../data/types";

/**
 * HealthBadge — the Decision 6 composite health signal.
 *
 * requirements.md §"Composite Scoring Rubric":
 *   composite < 0.5  → operator alert   (red)
 *   0.5 – 0.7        → dashboard banner (amber)
 *   > 0.7            → log only         (green)
 *
 * Shape language matches the existing `pill` chips (mono, uppercase, one
 * line tall, currentColor border + dot) so it reads as part of the same
 * signal vocabulary. Renders `null` when no health is persisted — the
 * badge reserves no space, so layouts never shift when it is absent.
 */

const BAND_LABEL: Record<HealthBand, string> = {
    alert: "operator alert",
    banner: "dashboard banner",
    log_only: "log only",
};

export interface HealthBadgeProps {
    health?: number | null;
    band?: HealthBand | null;
}

export function HealthBadge({ health, band }: HealthBadgeProps) {
    if (typeof health !== "number" || !Number.isFinite(health) || !band) return null;
    const value = health.toFixed(2);
    return (
        <span
            className={`health-badge health-badge--${band} mono`}
            role="img"
            aria-label={`Composite health ${value} — ${BAND_LABEL[band]}`}
            title={`health = ${value} · ${BAND_LABEL[band]} (Decision 6 composite)`}
        >
            <span className="health-badge__dot" aria-hidden="true" />
            HEALTH {value}
        </span>
    );
}
