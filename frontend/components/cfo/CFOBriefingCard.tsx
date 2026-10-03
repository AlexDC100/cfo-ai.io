// CFO briefing — the header's narrative description of the loaded month.
//
// Extracted from FinancialStatements.tsx in the Instrument migration so
// the header policy (no model ids in primary DOM) is testable in
// isolation. The header row reads "AI briefing · verified"; the model /
// regeneration mechanics live behind the "About this analysis"
// disclosure, closed by default. A policy test asserts the rendered
// header never carries a model name.
//
// NO AUTOMATIC MODEL CALL, EVER (owner ruling 2026-10-02). This card used to
// re-POST /briefing/regenerate from an effect whenever the UI language
// differed from the briefing's or the display currency was not RON. A failed
// narration then overwrote the stored briefing with "[NARRATIVE_UNAVAILABLE]"
// on a page load, with no click. The effect is gone: mounting, a language
// switch and a currency toggle perform no request. Regeneration is ONE
// explicit, metered action — a button the reader presses, which spends one
// Ask CFO AI message of their own allowance (cfoApi.regenerateBriefing, the
// `intent: "user"` body). Gate: __tests__/briefingExplicitRegenerate.test.tsx.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, Loader2, RefreshCcw, Sparkles } from "lucide-react";

import { useDisplayCurrency } from "@/stores/currency";
import { periodQueryKey } from "@/lib/activePeriod";
import { isUnusableNarrative, type BriefingStale } from "@/lib/briefingDefinition";
import { CfoApiError, cfoApi, type RegenerateBriefingBody } from "@/lib/cfoApi";
import { queryClient } from "@/lib/queryClient";
import "@/components/cfo/dashInstrumentI18n";

// The text predicate lives beside `briefingVisibility` (the one chokepoint);
// re-exported here because the header-policy test reads it from the card.
export { isUnusableNarrative };

/** The body the explicit action sends: always into the ACTIVE UI language
 *  and the display currency on screen. */
export function regenerateRequestBody(language: string, currency: string): RegenerateBriefingBody {
  return { intent: "user", language, currency };
}

const ROMANIAN_DIACRITICS = /[șțăîâȘȚĂÎÂ]/;

/** The language a briefing is written in: the served stamp when it says
 *  'ro'; otherwise the diacritics probe — every row written before the
 *  ruling is stamped 'en' whatever its language. Romanian business prose
 *  always carries diacritics, English never does. */
export function briefingLanguageOf(body: string, served: string | null | undefined): "ro" | "en" {
  if (typeof served === "string" && served.slice(0, 2).toLowerCase() === "ro") return "ro";
  return ROMANIAN_DIACRITICS.test(body) ? "ro" : "en";
}

/** A narration shown for this session in place of the stored one. */
interface SessionNarration {
  periodId: string;
  text: string;
  lang: string;
  currency: string;
}

type Notice =
  | { kind: "failed" }
  | { kind: "generate_failed" }
  | { kind: "cap"; window: "daily" | "monthly"; used: number | null; cap: number | null };

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function CFOBriefingCard({
  periodId,
  baseBriefing,
  baseLanguage = null,
  unavailable = false,
  stale = null,
  orgId = null,
  collapsed = false,
  onToggle,
}: {
  periodId: string;
  /** The stored briefing as `briefingVisibility` lets it through — never a
   *  failure text. Null / empty when the stored row is unavailable. */
  baseBriefing: string | null;
  /** The language stamp the route served ('en' | 'ro'). */
  baseLanguage?: string | null;
  /** The stored row holds no usable narration: the card offers the explicit
   *  "Generate the briefing" instead of prose. */
  unavailable?: boolean;
  /** The prose is the last good one, kept after a later narration failed. */
  stale?: BriefingStale | null;
  /** The PERIOD's company, sent as X-Org-Id with the explicit action. */
  orgId?: string | null;
  /** 2026 redesign — the header renders the briefing clamped to two lines by
   *  default so the overview's first paint stays hero + metrics + recs; only
   *  the presentation collapses. */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const display = useDisplayCurrency();
  const baseText = !unavailable && baseBriefing && !isUnusableNarrative(baseBriefing) ? baseBriefing : "";

  const [session, setSession] = useState<SessionNarration | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // A failed explicit regeneration this session after which the STORED
  // briefing is marked stale — the engine's own word (`stale` in its answer
  // is what the stored row holds), not "a failure happened": a failed
  // currency conversion marks nothing, and the briefing on screen is then
  // still the current one (owner ruling 2026-10-03).
  const [keptAfterFailure, setKeptAfterFailure] = useState(false);
  // A4 — model / regeneration mechanics live behind this disclosure,
  // closed by default so model ids never sit in the primary DOM.
  const [aboutOpen, setAboutOpen] = useState(false);

  // The stored briefing changed (another period, or the period query was
  // refetched after a persisted regeneration): the session's narration and
  // its notices belong to what was on screen before.
  useEffect(() => {
    setSession(null);
    setNotice(null);
    setKeptAfterFailure(false);
  }, [periodId, baseBriefing]);

  const periodRef = useRef(periodId);
  periodRef.current = periodId;
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // What is on screen: this session's narration while the display currency is
  // the one it was written in, else the stored briefing (always RON).
  const live = session && session.periodId === periodId && session.currency === display ? session : null;
  const text = live ? live.text : baseText;
  const shownLang = live ? live.lang : briefingLanguageOf(baseText, baseLanguage);
  const shownCurrency = live ? live.currency : "RON";

  const activeLang = (i18n.language || "en").slice(0, 2);
  const langMismatch = !!text && (activeLang === "ro" || activeLang === "en") && activeLang !== shownLang;
  const currencyMismatch = !!text && display !== shownCurrency;
  const isStale = !!text && (keptAfterFailure || (!live && !!stale));

  // The ONE explicit action. Its label says what a click will produce.
  const action: { label: string; busy: string } | null = !text
    ? { label: t("dash.generateBriefing"), busy: t("dash.regenerating") }
    : langMismatch
      ? { label: t("dash.regenerateInLanguage"), busy: t("dash.regenerating") }
      : currencyMismatch
        ? {
            label: t("dash.regenerateInCurrency", { currency: display }),
            busy: t("dash.regeneratingIn", { currency: display }),
          }
        : null;

  async function regenerate() {
    if (inFlight.current) return;
    inFlight.current = true;
    const forPeriod = periodId;
    const hadProse = !!text;
    const language = activeLang;
    const currency = display;
    setLoading(true);
    setNotice(null);
    const isCurrent = () => mounted.current && periodRef.current === forPeriod;
    try {
      const data = await cfoApi.regenerateBriefing(
        forPeriod,
        regenerateRequestBody(language, currency),
        orgId,
      );
      if (!isCurrent()) return;
      const fresh = typeof data.briefing === "string" ? data.briefing : "";
      const regenerated =
        data.ok !== false && data.regenerated !== false && !!fresh && !isUnusableNarrative(fresh);
      if (!regenerated) {
        // The narration failed: the engine wrote nothing and released the
        // message. Whatever prose is on screen stays. It is SHOWN as stale
        // only when the engine says the stored briefing is: `stale: false`
        // is a failure that marked nothing (a converted narration, a marker
        // the database refused). An answer with no boolean `stale` (an
        // engine that predates it) keeps the cautious reading.
        setNotice({ kind: hadProse ? "failed" : "generate_failed" });
        setKeptAfterFailure(hadProse && data.stale !== false);
        return;
      }
      setSession({
        periodId: forPeriod,
        text: fresh,
        lang: (typeof data.language === "string" && data.language ? data.language : language).slice(0, 2).toLowerCase(),
        currency: typeof data.currency === "string" && data.currency ? data.currency : currency,
      });
      setKeptAfterFailure(false);
      if (data.persisted === true) {
        // The stored briefing changed: every surface that reads the period
        // (the report, the chat snapshot, the command bar) must re-read it.
        void queryClient.invalidateQueries({ queryKey: periodQueryKey(forPeriod) });
      }
    } catch (err) {
      if (!isCurrent()) return;
      const detail =
        err instanceof CfoApiError && err.status === 429 && typeof err.detail === "object" && err.detail !== null
          ? (err.detail as Record<string, unknown>)
          : null;
      if (detail && detail.code === "briefing_regen_cap_reached") {
        const daily = detail.kind === "daily_cap_reached";
        setNotice({
          kind: "cap",
          window: daily ? "daily" : "monthly",
          used: finiteOrNull(daily ? detail.daily_used : detail.monthly_used),
          cap: finiteOrNull(daily ? detail.daily_cap : detail.monthly_cap),
        });
      } else {
        // Never the server's message, never a status code: one sentence.
        setNotice({ kind: hadProse ? "failed" : "generate_failed" });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  // Chrome-less: the briefing IS the header's subtitle — plain prose under
  // a small caps eyebrow. A4: the eyebrow is "AI briefing · verified";
  // no model id renders outside the About disclosure below. A kept (stale)
  // briefing and an unavailable one are never called "verified".
  const eyebrowState = !text
    ? t("dashIx.briefingUnavailable")
    : isStale
      ? t("dashIx.briefingStale")
      : t("dashIx.briefingVerified");
  return (
    <div
      data-testid="cfo-briefing"
      data-briefing-state={!text ? "unavailable" : isStale ? "stale" : "current"}
      className="mt-3 max-w-[1040px]"
    >
      <div
        data-testid="briefing-header"
        className="flex items-center justify-between gap-2 mb-1.5"
      >
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] text-brand-d font-medium">
          <Sparkles size={11} strokeWidth={2} />
          {t("dashIx.briefingEyebrow")}
          <span className="text-ink-mute">· {eyebrowState}</span>
          {!!text && shownCurrency !== "RON" && (
            <span className="text-ink-mute normal-case tracking-normal">
              · {t("dash.displayedIn", { currency: shownCurrency })}
            </span>
          )}
        </div>
        {loading && action && (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-mute">
            <Loader2 size={12} className="animate-spin" />
            {action.busy}
          </div>
        )}
      </div>
      {text ? (
        <p
          data-testid="cfo-briefing-body"
          className={`text-[14px] sm:text-[14.5px] text-ink-soft leading-relaxed transition-opacity ${loading ? "opacity-60" : ""} ${collapsed ? "line-clamp-2" : ""}`}
        >
          {text}
        </p>
      ) : (
        <p
          data-testid="cfo-briefing-unavailable"
          className="text-[12.5px] text-ink-soft leading-snug max-w-[720px]"
        >
          {t("dash.narrativeUnavailable")}
        </p>
      )}
      {onToggle && !!text && (
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
      {action && (
        // The explicit, metered action — visible while the card is collapsed.
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <button
            type="button"
            onClick={() => void regenerate()}
            disabled={loading}
            data-testid="briefing-regenerate"
            className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-d hover:text-brand transition-colors disabled:opacity-50"
          >
            <RefreshCcw size={11} strokeWidth={2} />
            {action.label}
          </button>
          <span data-testid="briefing-regenerate-cost" className="text-[11px] text-ink-mute">
            {t("dash.regenerateCost")}
          </span>
        </div>
      )}
      {notice && (
        <p data-testid="briefing-regenerate-notice" role="status" className="mt-2 text-[11px] text-brand-d">
          {notice.kind === "cap" ? (
            <>
              {notice.used !== null && notice.cap !== null && notice.cap > 0
                ? t(notice.window === "daily" ? "dash.regenCapDaily" : "dash.regenCapMonthly", {
                    used: notice.used,
                    cap: notice.cap,
                  })
                : t("dash.regenCapNoCounts")}{" "}
              <Link to="/pricing" data-testid="briefing-regenerate-plans" className="underline hover:text-brand">
                {t("chatX.seePlans")}
              </Link>
            </>
          ) : notice.kind === "generate_failed" ? (
            t("dash.generateFailed")
          ) : (
            t("dash.regenFailed")
          )}
        </p>
      )}
      {!collapsed && !!text && (
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
