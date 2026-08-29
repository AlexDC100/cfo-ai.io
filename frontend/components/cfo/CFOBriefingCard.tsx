// CFO briefing — the header's narrative description of the loaded month.
//
// Extracted from FinancialStatements.tsx in the Instrument migration so
// the header policy (no model ids in primary DOM) is testable in
// isolation. The header row reads "AI briefing · verified"; the model /
// regeneration mechanics live behind the "About this analysis"
// disclosure, closed by default. A policy test asserts the rendered
// header never carries a model name.
//
// Behavior is unchanged from the in-page original: the card stays
// MOUNTED while collapsed (its currency/language regeneration effects
// keep running); only the presentation clamps to two lines.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Loader2, Sparkles } from "lucide-react";

import { useDisplayCurrency } from "@/stores/currency";
import "@/components/cfo/dashInstrumentI18n";

export function isUnusableNarrative(s: string | null | undefined): boolean {
  if (!s) return true;
  return /\[NARRATIVE_UNAVAILABLE\]|Narrative unavailable|invalid_request_error|credit balance|Error code: \d/i.test(s);
}

export function CFOBriefingCard({
  periodId,
  baseBriefing,
  collapsed = false,
  onToggle,
}: {
  periodId: string;
  baseBriefing: string;
  /** 2026 redesign — the header renders the briefing clamped to two lines by
   *  default so the overview's first paint stays hero + metrics + recs. The
   *  card stays MOUNTED either way (its currency/language regeneration
   *  effects keep running); only the presentation collapses. */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const display = useDisplayCurrency();
  const baseUsable = !isUnusableNarrative(baseBriefing);
  const [text, setText] = useState<string>(baseUsable ? baseBriefing : "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A4 — model / regeneration mechanics live behind this disclosure,
  // closed by default so model ids never sit in the primary DOM.
  const [aboutOpen, setAboutOpen] = useState(false);

  // Language awareness (2026-08-04): the persisted briefing was generated
  // in the UI language active AT SCAN TIME. If the user has since switched
  // EN↔RO, re-narrate in the language they're reading — "no RO body under
  // EN labels". Detection is cheap and reliable for this language pair:
  // Romanian business prose always carries diacritics, English never does.
  const activeLang = (i18n.language || "en").slice(0, 2);
  const baseLang = /[șțăîâȘȚĂÎÂ]/.test(baseBriefing) ? "ro" : "en";
  const langMismatch = activeLang !== baseLang && (activeLang === "ro" || activeLang === "en");

  // Reset to baseline if user switches periods (different periodId)
  // OR returns to RON (the canonical persisted briefing) in its own language.
  useEffect(() => {
    if (display === "RON" && !langMismatch) {
      setText(baseUsable ? baseBriefing : "");
      setError(null);
    }
  }, [baseBriefing, baseUsable, display, langMismatch]);

  useEffect(() => {
    if (display === "RON" && !langMismatch) return;
    // Debounce 600ms so rapid RON→EUR→USD toggles don't fire 3 narration calls.
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const { getSupabase } = await import("@/lib/supabase");
        const sb = getSupabase();
        const { data: session } = sb
          ? await sb.auth.getSession()
          : { data: { session: null } };
        const token = session?.session?.access_token;
        if (!token) {
          throw new Error("Not signed in");
        }
        const apiUrl =
          (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
        const res = await fetch(
          `${apiUrl}/api/period/${periodId}/briefing/regenerate?currency=${display}&language=${activeLang}`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (
          !cancelled &&
          typeof data.briefing === "string" &&
          data.briefing.length > 0 &&
          !isUnusableNarrative(data.briefing)
        ) {
          setText(data.briefing);
        } else if (!cancelled && isUnusableNarrative(data.briefing)) {
          // Regeneration failed upstream (e.g. provider billing). Keep
          // whatever prose we already have; surface a friendly note.
          setError(t("dash.narrativeUnavailable"));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps — activeLang/langMismatch drive the same debounce
  }, [display, periodId, activeLang, langMismatch]);

  // Chrome-less: the briefing IS the header's subtitle — plain prose under
  // a small caps eyebrow. A4: the eyebrow is "AI briefing · verified";
  // no model id renders outside the About disclosure below.
  return (
    <div data-testid="cfo-briefing" className="mt-3 max-w-[1040px]">
      <div
        data-testid="briefing-header"
        className="flex items-center justify-between gap-2 mb-1.5"
      >
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] text-brand-d font-medium">
          <Sparkles size={11} strokeWidth={2} />
          {t("dashIx.briefingEyebrow")}
          <span className="text-ink-mute">· {t("dashIx.briefingVerified")}</span>
          {display !== "RON" && (
            <span className="text-ink-mute normal-case tracking-normal">
              · {t("dash.displayedIn", { currency: display })}
            </span>
          )}
        </div>
        {loading && (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-mute">
            <Loader2 size={12} className="animate-spin" />
            {t("dash.regeneratingIn", { currency: display })}
          </div>
        )}
      </div>
      <p
        className={`text-[14px] sm:text-[14.5px] text-ink-soft leading-relaxed transition-opacity ${loading ? "opacity-60" : ""} ${collapsed ? "line-clamp-2" : ""}`}
      >
        {text}
      </p>
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          data-testid="cfo-briefing-toggle"
          className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-d hover:text-brand transition-colors"
        >
          {collapsed ? t("dashV2.briefingShowMore") : t("dashV2.briefingShowLess")}
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={`transition-transform duration-200 ${collapsed ? "" : "rotate-180"}`}
          />
        </button>
      )}
      {error && (
        <p className="mt-2 text-[11px] text-brand-d">
          {t("dash.regenFailed", { currency: display, error })}
        </p>
      )}
      {!collapsed && (
        <div className="mt-3">
          <p className="text-[11px] italic text-ink-mute leading-relaxed">
            {t("dash.briefingDisclaimer")}
          </p>
          {/* About this analysis — the one place model/prompt mechanics
              may render. Closed by default; never in the header. */}
          <button
            type="button"
            onClick={() => setAboutOpen((v) => !v)}
            aria-expanded={aboutOpen}
            data-testid="briefing-about-analysis"
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-ink-mute hover:text-ink transition-colors"
          >
            {t("dashIx.aboutAnalysis")}
            <ChevronDown
              size={11}
              strokeWidth={2}
              className={`transition-transform duration-200 ${aboutOpen ? "rotate-180" : ""}`}
            />
          </button>
          {aboutOpen && (
            <p
              data-testid="briefing-about-analysis-body"
              className="mt-1 max-w-[640px] font-mono text-[10.5px] leading-relaxed text-ink-mute"
            >
              {t("dashIx.aboutAnalysisBody")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
