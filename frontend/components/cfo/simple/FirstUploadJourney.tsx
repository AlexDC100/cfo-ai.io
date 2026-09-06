// THE DIAL — first-upload journey (Prompt 12, Part E2). Simple mode only.
//
// After a successful scan lands, a 3-step reveal before the story
// dashboard: "Books read & verified" (the REAL trust state — the frozen
// TrustChip copy, never an overclaim) -> the three headline numbers
// (revenue / profit / cash through <Amount>, SAME accessors as the
// dashboard) -> the one thing to watch (the top EXISTING recommendation,
// template fallback — never a model call). Then it lands on the story
// dashboard, which is already rendered underneath.
//
// NEVER BLOCKS: the Skip button is always visible; a render error inside
// the overlay is swallowed by the local boundary, which lands the user
// straight on the dashboard. Never shown in Pro (the page gates the
// mount on useIsSimple), and only once — the guard key below.

import { Component, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";

import { Amount, AmountGroup } from "@/components/instrument/Amount";
import type { AmountProvenance } from "@/components/instrument/Provenance";
import { Chip, type ChipTone } from "@/components/instrument/Panel";
import { Term } from "@/components/instrument/Term";
import type { Recommendation } from "@/lib/financialReport";

import "./storyI18n";
import { useConvertedAmounts } from "./convertedAmounts";
import { pickTopRecommendation } from "./StoryOverview";

export const JOURNEY_SEEN_KEY = "cfo-first-upload-journey-seen-v1";

export function journeySeen(): boolean {
  try {
    return localStorage.getItem(JOURNEY_SEEN_KEY) === "true";
  } catch {
    return false;
  }
}

export function markJourneySeen(): void {
  try {
    localStorage.setItem(JOURNEY_SEEN_KEY, "true");
  } catch {
    /* private mode */
  }
}

// ── local boundary: any error -> straight to dashboard ─────────────────

class JourneyBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(): void {
    // The journey is a nicety — an error dismisses it silently and the
    // dashboard underneath is already there.
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ── the overlay ────────────────────────────────────────────────────────

export type JourneyTrustBand = "clean" | "watch" | "problem" | "unknown";

export interface FirstUploadJourneyProps {
  currency: string;
  revenue: number;
  profit: number;
  cash: number;
  /** Accuracy band from the SAME computeAccuracyRead the trust chip uses. */
  trustBand: JourneyTrustBand;
  /** FROZEN trust-chip node — rendered verbatim (chips identical in both
   *  modes; this component never re-words trust). */
  trustChip: ReactNode;
  recommendations: Recommendation[];
  /** Done = finished OR skipped — the caller marks the guard key and
   *  unmounts; the story dashboard is underneath. */
  onDone: () => void;
  /** Origin of the three figures — the SAME objects the story dashboard
   *  underneath receives (`lib/headlineProvenance`). Null → plain. */
  provenance?: Partial<Record<"revenue" | "profit" | "cash", AmountProvenance | null>>;
}

export function FirstUploadJourney(props: FirstUploadJourneyProps) {
  return (
    <JourneyBoundary onError={props.onDone}>
      <JourneyInner {...props} />
    </JourneyBoundary>
  );
}

function JourneyInner({
  currency,
  revenue,
  profit,
  cash,
  trustBand,
  trustChip,
  recommendations,
  onDone,
  provenance,
}: FirstUploadJourneyProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const { converted, symbol } = useConvertedAmounts([revenue, profit, cash], currency);
  const [cRevenue, cProfit, cCash] = converted;
  const topRec = pickTopRecommendation(recommendations);

  const sevChip: { tone: ChipTone; key: string } | null = topRec
    ? topRec.priority === "critical" || topRec.priority === "high"
      ? { tone: "alert", key: "story.sev.critical" }
      : topRec.priority === "medium"
        ? { tone: "caution", key: "story.sev.watch" }
        : { tone: "neutral", key: "story.sev.info" }
    : null;

  const steps: Array<{ key: string; body: ReactNode }> = [
    {
      key: "read",
      body: (
        <div className="flex flex-col items-center gap-3 text-center">
          <h2 className="text-[22px] font-semibold leading-tight tracking-tight text-ink">
            {trustBand === "clean"
              ? t("story.journey.readTitle")
              : t("story.journey.readTitleUnverified")}
          </h2>
          <div>{trustChip}</div>
          <p className="max-w-[380px] text-[13.5px] leading-relaxed text-ink-soft">
            {t("story.journey.readBody")}
          </p>
        </div>
      ),
    },
    {
      key: "numbers",
      body: (
        <div className="flex flex-col items-center gap-4 text-center">
          <h2 className="text-[22px] font-semibold leading-tight tracking-tight text-ink">
            {t("story.journey.numbersTitle")}
          </h2>
          <AmountGroup values={[cRevenue, cProfit, cCash]}>
            <div className="grid w-full max-w-[420px] grid-cols-1 gap-2">
              {(
                [
                  ["revenue", cRevenue, "journey-figure-revenue", provenance?.revenue],
                  ["net_profit", cProfit, "journey-figure-profit", provenance?.profit],
                ] as const
              ).map(([id, value, testid, origin]) => (
                <div
                  key={id}
                  data-testid={testid}
                  className="flex items-baseline justify-between gap-3 rounded-md border border-rule bg-surface px-4 py-3"
                >
                  <span className="min-w-0 text-left text-[12.5px] text-ink-2">
                    <Term id={id} />
                  </span>
                  <span className="shrink-0 text-[20px] font-medium leading-none text-ink">
                    <Amount value={value} currency={symbol} provenance={origin ?? null} />
                  </span>
                </div>
              ))}
              <div
                data-testid="journey-figure-cash"
                className="flex items-baseline justify-between gap-3 rounded-md border border-rule bg-surface px-4 py-3"
              >
                <span className="min-w-0 text-left text-[12.5px] text-ink-2">
                  {t("story.cash.label")}
                </span>
                <span className="shrink-0 text-[20px] font-medium leading-none text-ink">
                  <Amount value={cCash} currency={symbol} provenance={provenance?.cash ?? null} />
                </span>
              </div>
            </div>
          </AmountGroup>
        </div>
      ),
    },
    {
      key: "watch",
      body: (
        <div className="flex flex-col items-center gap-3 text-center">
          <h2 className="text-[22px] font-semibold leading-tight tracking-tight text-ink">
            {t("story.journey.watchTitle")}
          </h2>
          {sevChip && <Chip tone={sevChip.tone} dot>{t(sevChip.key)}</Chip>}
          {topRec ? (
            <>
              <p className="max-w-[420px] text-[14px] font-medium leading-snug text-ink">
                {topRec.title}
              </p>
              <p className="max-w-[420px] text-[13px] leading-relaxed text-ink-soft">
                {topRec.rationale?.trim() ? topRec.rationale : t("story.watch.fallbackBody")}
              </p>
            </>
          ) : (
            <>
              <p className="max-w-[420px] text-[14px] font-medium leading-snug text-ink">
                {t("story.watch.allClearTitle")}
              </p>
              <p className="max-w-[420px] text-[13px] leading-relaxed text-ink-soft">
                {t("story.watch.allClearBody")}
              </p>
            </>
          )}
        </div>
      ),
    },
  ];

  const isLast = step === steps.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-bg"
      role="dialog"
      aria-modal="true"
      aria-label={t("story.journey.numbersTitle")}
      data-testid="first-upload-journey"
    >
      {/* Skip — ALWAYS visible, top-right. */}
      <div className="flex items-center justify-between px-5 pt-4">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-mute">
          {t("story.journey.stepOf", { current: step + 1, total: steps.length })}
        </span>
        <button
          type="button"
          onClick={onDone}
          data-testid="journey-skip"
          className="inline-flex h-8 items-center rounded-sm border border-rule px-3 text-[12.5px] font-medium text-ink-2 transition-colors duration-micro hover:border-rule-strong hover:bg-bg-2 hover:text-ink"
        >
          {t("story.journey.skip")}
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center px-5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={steps[step].key}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="w-full max-w-[560px]"
          >
            {steps[step].body}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex flex-col items-center gap-3 pb-8">
        {/* Progress dots. */}
        <div className="flex items-center gap-1.5" aria-hidden>
          {steps.map((s, i) => (
            <span
              key={s.key}
              className={`h-1.5 rounded-full transition-all duration-200 ${
                i === step ? "w-5 bg-brand" : "w-1.5 bg-rule"
              }`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => (isLast ? onDone() : setStep((s) => s + 1))}
          data-testid={isLast ? "journey-finish" : "journey-continue"}
          className="inline-flex h-10 min-w-[220px] items-center justify-center rounded-md bg-brand px-6 text-[13.5px] font-semibold text-paper transition-colors duration-micro hover:bg-brand-d"
        >
          {isLast ? t("story.journey.cta") : t("story.journey.continue")}
        </button>
      </div>
    </div>
  );
}
