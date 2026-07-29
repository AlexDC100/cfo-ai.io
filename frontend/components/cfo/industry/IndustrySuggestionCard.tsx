// IndustrySuggestionCard — visualizes one DetectResponse row.
//
// Renders the auto-detect primary alongside the top-3 alternative
// candidates so the user can see what the system considered and why.
//
// Used inside IndustryPicker, but designed to render standalone too —
// pass a `DetectResponse` directly and (optionally) a click handler
// to swap the primary to a different candidate.
//
// Color semantics
//   user_override      blue    — explicit user choice
//   auto_caen          green   — CAEN registry match (strongest signal)
//   auto_activity_text violet  — keyword in activity description
//   auto_account_struct sky     — cost-structure heuristic
//   fallback           amber   — couldn't decide; user must pick
//
// All copy is English-only per the project's i18n rules; Romanian labels
// only appear inside data fields surfaced from the backend (display_name_ro).

import { CheckCircle2, CircleDashed, Info, Lock, ShieldQuestion, Sparkles } from "lucide-react";

import type { CandidateRow, DetectResponse, DetectionSource } from "@/lib/industryApi";
import { formatConfidence, sourceLabel, sourceTone } from "@/lib/industryApi";

interface Props {
  detection: DetectResponse;
  /** Highlight this candidate as currently-selected (== persisted assignment). */
  selectedKey?: string | null;
  /** Click on any alternative candidate. When omitted, the card is read-only. */
  onPickCandidate?: (c: CandidateRow) => void;
  /** Hide the "alternatives considered" block (e.g., when used in a compact slot). */
  hideAlternatives?: boolean;
}

export function IndustrySuggestionCard({
  detection,
  selectedKey,
  onPickCandidate,
  hideAlternatives,
}: Props) {
  const primary = detection.primary;
  if (!primary) {
    return (
      <div
        data-testid="industry-suggestion-empty"
        className="rounded-xl border border-rule bg-bg-2/50 p-4 text-[13px] text-ink-mute inline-flex items-center gap-2"
      >
        <ShieldQuestion size={14} className="shrink-0" />
        No detection result available. The period may still be importing.
      </div>
    );
  }

  return (
    <section data-testid="industry-suggestion-card" className="space-y-3">
      <CandidateRowView
        candidate={primary}
        isPrimary
        isSelected={selectedKey === primary.industry_key}
        locked={detection.locked}
      />

      {!hideAlternatives && detection.candidates.length > 1 && (
        <div data-testid="industry-alternatives" className="space-y-1.5 pl-1">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
            Alternatives considered
          </div>
          {detection.candidates
            .filter((c) => c.industry_key !== primary.industry_key)
            .slice(0, 3)
            .map((c) => (
              <button
                key={c.industry_key}
                type="button"
                disabled={!onPickCandidate}
                onClick={() => onPickCandidate?.(c)}
                className={
                  "w-full text-left rounded-lg border border-rule bg-surface px-3 py-2 " +
                  "hover:bg-bg-2 transition-colors disabled:cursor-default " +
                  (selectedKey === c.industry_key ? "ring-1 ring-ink/30" : "")
                }
              >
                <CandidateInline candidate={c} />
              </button>
            ))}
        </div>
      )}

      {/* Inputs strip — explains which signals contributed. Helps the
          user understand a low-confidence call ("we only had cost
          structure to go on"). */}
      <DetectionInputs inputs={detection.inputs} />
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function CandidateRowView({
  candidate,
  isPrimary,
  isSelected,
  locked,
}: {
  candidate: CandidateRow;
  isPrimary: boolean;
  isSelected: boolean;
  locked: boolean;
}) {
  const tone = sourceTone(candidate.source);
  return (
    <div
      data-testid={isPrimary ? "industry-primary-candidate" : "industry-alt-candidate"}
      className={`rounded-xl border ${tone.border} ${tone.bg} dark:bg-opacity-10 p-4`}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className={`text-[10.5px] uppercase tracking-[0.1em] ${tone.text} font-medium inline-flex items-center gap-1.5`}>
          {isPrimary ? <Sparkles size={11} /> : <CircleDashed size={11} />}
          {isPrimary ? "Best match" : "Alternative"} · {sourceLabel(candidate.source)}
        </div>
        <div className={`text-[11px] font-medium ${tone.text}`}>
          {formatConfidence(candidate.confidence)} confidence
          {candidate.match_quality ? ` · ${candidate.match_quality}` : ""}
        </div>
      </div>

      <div className="mt-1.5 font-medium text-ink inline-flex items-center gap-2">
        {candidate.display_name ?? candidate.industry_key}
        {isSelected && (
          <CheckCircle2 size={14} strokeWidth={2.2} className="text-[#2AA89B]" aria-label="Currently selected" />
        )}
        {isPrimary && locked && (
          <span className="inline-flex items-center gap-1 text-[10px] text-[#2AA89B] bg-[#E6F7F4]/70 rounded px-1.5 py-0.5">
            <Lock size={9} /> Locked
          </span>
        )}
      </div>

      {candidate.rationale && (
        <p className="text-[12px] text-ink-soft mt-1.5 leading-relaxed">
          {candidate.rationale}
        </p>
      )}
    </div>
  );
}

function CandidateInline({ candidate }: { candidate: CandidateRow }) {
  const tone = sourceTone(candidate.source);
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <div className="text-[13px] text-ink truncate">
          {candidate.display_name ?? candidate.industry_key}
        </div>
        {candidate.rationale && (
          <div className="text-[11.5px] text-ink-mute line-clamp-1">
            {candidate.rationale}
          </div>
        )}
      </div>
      <div className={`shrink-0 inline-flex items-center gap-1.5 text-[10.5px] font-medium ${tone.text}`}>
        <span className={`inline-block rounded-full ${tone.bg} border ${tone.border} px-1.5 py-0.5`}>
          {sourceLabel(candidate.source)}
        </span>
        {formatConfidence(candidate.confidence)}
      </div>
    </div>
  );
}

function DetectionInputs({ inputs }: { inputs: Record<string, unknown> }) {
  const items: { label: string; value: string }[] = [];
  const caen = inputs.caen_code as string | null | undefined;
  if (caen) items.push({ label: "CAEN", value: caen });
  const activityLen = inputs.activity_text_len as number | undefined;
  if (typeof activityLen === "number" && activityLen > 0) {
    items.push({ label: "Activity text", value: `${activityLen} chars` });
  }
  const metricsCount = inputs.metrics_count as number | undefined;
  if (typeof metricsCount === "number" && metricsCount > 0) {
    items.push({ label: "Metrics", value: `${metricsCount} signals` });
  }
  if (inputs.locked_assignment_present) {
    items.push({ label: "Status", value: "Locked by user" });
  }
  if (items.length === 0) return null;
  return (
    <div
      data-testid="industry-detection-inputs"
      className="flex items-center gap-2 flex-wrap text-[11px] text-ink-mute"
    >
      <Info size={11} strokeWidth={1.75} />
      <span className="uppercase tracking-[0.08em] font-medium">Signals used:</span>
      {items.map((it) => (
        <span key={it.label} className="rounded border border-rule bg-surface px-1.5 py-0.5">
          <span className="font-medium text-ink-soft">{it.label}</span>
          <span className="text-ink-mute">: {it.value}</span>
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Convenience: an alias for callers wiring `mapAlternativeToBody`.
// Returns the AssignmentUpsertBody you'd POST to switch to a candidate.
// ─────────────────────────────────────────────────────────────────────

export function candidateToUpsertBody(c: CandidateRow): {
  selected_industry_key: string;
  source: DetectionSource;
  confidence: number;
  locked_by_user: boolean;
  reason: string;
} {
  // Picking an alternative is still a user act, so we record it as a
  // `user_override`. The system source (auto_caen, etc.) lives in the
  // audit log via `payload`.
  return {
    selected_industry_key: c.industry_key,
    source: "user_override",
    confidence: Math.max(c.confidence, 0.9),
    locked_by_user: true,
    reason: `User selected alternative '${c.industry_key}' (detected via ${c.source}).`,
  };
}
