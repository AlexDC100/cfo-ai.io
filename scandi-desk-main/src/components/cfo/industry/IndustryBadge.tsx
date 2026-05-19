// IndustryBadge — compact chip that shows the active industry for a period.
//
// Designed to drop into page headers, the dataset switcher, and the
// command drawer. Two visual states:
//
//   ASSIGNED    "Packaged canned meat & prepared foods"   ◷ Change
//                (with a small lock icon when locked_by_user = true)
//
//   UNSET       "No industry set · Detect"
//                (pulses amber to draw the eye, click opens picker)
//
// On click, opens the IndustryPicker via the controlled `onClickChange`
// prop. The badge itself doesn't mount the picker — that lets the parent
// decide where the modal lives in the React tree (which matters for
// portal stacking with other drawers).
//
// Variants
//   compact     icon + key only, fits inside button rows (default)
//   inline      label + secondary "Change" action; for header strips
//   full        adds the source label + confidence chip; for landing cards

import { AlertCircle, ChevronRight, Lock, Pencil, Sparkles } from "lucide-react";

import { useIndustryAssignment } from "@/hooks/useIndustryAssignment";
import { formatConfidence, sourceLabel, sourceTone } from "@/lib/industryApi";

interface Props {
  periodId: string;
  variant?: "compact" | "inline" | "full";
  onClickChange?: () => void;
}

export function IndustryBadge({ periodId, variant = "inline", onClickChange }: Props) {
  const { assignment, detection, loading } = useIndustryAssignment(periodId);

  // Display strategy:
  //   · prefer assignment.selected_industry_key + its display_name
  //   · if no assignment yet, surface detection.primary so the badge
  //     reads "Suggested: Real estate commercial rental" until the
  //     user confirms.
  const displayName =
    assignment?.selected_industry_key === detection?.primary?.industry_key
      ? detection?.primary?.display_name ?? assignment?.selected_industry_key
      : detection?.candidates.find(
          (c) => c.industry_key === assignment?.selected_industry_key,
        )?.display_name ?? assignment?.selected_industry_key ?? detection?.primary?.display_name;

  const sourceForTone = assignment?.source ?? detection?.primary?.source ?? "fallback";
  const tone = sourceTone(sourceForTone);

  if (loading) {
    return (
      <span
        data-testid="industry-badge-loading"
        className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-rule bg-bg-2/40 text-[11.5px] text-ink-mute"
      >
        Loading industry…
      </span>
    );
  }

  // UNSET state — no assignment AND no detection (rare; missing period).
  if (!assignment && !detection?.primary) {
    return (
      <button
        type="button"
        data-testid="industry-badge-unset"
        onClick={onClickChange}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-amber-300/70 bg-amber-50/50 text-[11.5px] font-medium text-amber-800 hover:bg-amber-100/60 transition-colors animate-pulse"
      >
        <AlertCircle size={12} strokeWidth={1.75} />
        No industry set
        <ChevronRight size={11} strokeWidth={1.75} />
      </button>
    );
  }

  // SUGGESTED-but-not-confirmed: detection ran, user hasn't saved yet.
  const isSuggestion = !assignment && !!detection?.primary;

  // ── compact ────────────────────────────────────────────────
  if (variant === "compact") {
    return (
      <button
        type="button"
        data-testid="industry-badge-compact"
        onClick={onClickChange}
        title={displayName ?? undefined}
        className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md border ${tone.border} ${tone.bg} text-[11.5px] ${tone.text} hover:opacity-80 transition-opacity`}
      >
        {isSuggestion ? <Sparkles size={11} /> : null}
        {assignment?.locked_by_user ? <Lock size={11} /> : null}
        <span className="font-medium truncate max-w-[180px]">{displayName}</span>
      </button>
    );
  }

  // ── full ───────────────────────────────────────────────────
  if (variant === "full") {
    const confidence = assignment?.confidence ?? detection?.primary?.confidence ?? 0;
    return (
      <div
        data-testid="industry-badge-full"
        className={`flex items-start gap-3 rounded-lg border ${tone.border} ${tone.bg} px-3.5 py-2.5`}
      >
        <div className="flex-1 min-w-0">
          <div className={`text-[10.5px] uppercase tracking-[0.1em] ${tone.text} font-medium inline-flex items-center gap-1.5`}>
            {isSuggestion ? "Suggested industry" : "Active industry"}
            {assignment?.locked_by_user && (
              <span className="inline-flex items-center gap-0.5 text-[9.5px] text-blue-700 bg-blue-100/70 rounded px-1 py-0.5">
                <Lock size={9} /> Locked
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[13.5px] font-medium text-ink truncate">
            {displayName}
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-mute">
            {sourceLabel(sourceForTone)} · {formatConfidence(confidence)} confidence
          </div>
        </div>
        <button
          type="button"
          onClick={onClickChange}
          className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-md border border-rule bg-surface text-[11.5px] text-ink hover:bg-bg-2 transition-colors"
        >
          <Pencil size={11} strokeWidth={1.75} />
          Change
        </button>
      </div>
    );
  }

  // ── inline (default) ───────────────────────────────────────
  return (
    <span
      data-testid="industry-badge-inline"
      className={`inline-flex items-center gap-2 text-[11.5px] ${tone.text}`}
    >
      <span className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-md border ${tone.border} ${tone.bg} font-medium`}>
        {isSuggestion ? <Sparkles size={11} /> : null}
        {assignment?.locked_by_user ? <Lock size={11} /> : null}
        <span className="truncate max-w-[240px]">{displayName}</span>
      </span>
      {onClickChange && (
        <button
          type="button"
          onClick={onClickChange}
          className="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-ink border border-rule rounded px-1.5 py-0.5 hover:bg-bg-2 transition-colors"
        >
          <Pencil size={10} strokeWidth={2} />
          Change
        </button>
      )}
    </span>
  );
}
