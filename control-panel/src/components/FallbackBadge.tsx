import type { FallbackBadgeEntry } from "../data/types";

/**
 * FallbackBadge — rendered next to any stage whose last run fell back from
 * the typesafe primitive to claude-code (requirements.md §"CJK Fallback
 * Contract → Observability": "panel-read-model.mjs shows a per-stage
 * fallback badge whenever the last run for that stage fell back").
 *
 * The contractual warning is `typesafe_fallback_to_claude: <reason>`; the
 * tooltip / accessible name expose that reason verbatim. Renders `null`
 * when the stage's last run was clean — no space reserved, no layout shift.
 */

export interface FallbackBadgeProps {
    badge?: FallbackBadgeEntry | null;
    /** Stage name used in the accessible label (e.g. "spec"). */
    stage?: string;
}

export function FallbackBadge({ badge, stage }: FallbackBadgeProps) {
    if (!badge?.reason) return null;
    const label = `${stage ? `${stage} stage` : "stage"} last run fell back from typesafe to claude-code: ${badge.reason}`;
    return (
        <span
            className="fallback-badge mono"
            role="img"
            aria-label={label}
            title={label}
        >
            <span className="fallback-badge__glyph" aria-hidden="true">⇄</span>
            FALLBACK
        </span>
    );
}
