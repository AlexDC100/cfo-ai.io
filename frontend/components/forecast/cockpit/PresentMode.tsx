// "PREZINTĂ" — the cockpit for a meeting: a clean full-screen view of the four
// numbers, the chart and the assumptions, for an investor or a bank across
// the table. Nothing on it moves unless the engine answers; nothing on it is
// computed here (it paints the same served view the cockpit paints).
//
// Esc exits — from the overlay's own key handler, and from the browser's
// full-screen exit (which swallows the Esc keypress before the page sees it).
// Its one primary action is "Exportă pentru bancă".

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, X } from "lucide-react";

import { pick, type CockpitView, type LeverPositions } from "@/lib/forecastCockpit";
import { leverText } from "./format";
import { CockpitChart } from "./CockpitChart";
import { HeadlineNumbers } from "./HeadlineNumbers";
import type { MoneyFormat } from "./format";

export function PresentMode({
  cockpit,
  companyName,
  caseName,
  positions,
  format,
  locale,
  lang,
  projectedLabel,
  answerKey,
  exporting,
  onExport,
  onClose,
}: {
  cockpit: CockpitView;
  companyName: string;
  caseName: string;
  positions: LeverPositions;
  format: MoneyFormat;
  locale: string;
  lang: string;
  projectedLabel: string;
  answerKey: string;
  exporting: boolean;
  onExport: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const days = t("forecast.cockpit.levers.days", "days");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Full screen where the browser allows it (a user gesture opened this);
    // where it does not, the fixed overlay is the full screen.
    const el = root.current as (HTMLDivElement & { requestFullscreen?: () => Promise<void> }) | null;
    let entered = false;
    try {
      const p = el?.requestFullscreen?.();
      if (p && typeof p.then === "function") {
        p.then(() => {
          entered = true;
        }).catch(() => undefined);
      }
    } catch {
      /* not allowed here: the overlay stands in */
    }
    const onFs = () => {
      if (entered && !document.fullscreenElement) onClose();
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
      try {
        if (document.fullscreenElement) void document.exitFullscreen?.();
      } catch {
        /* already out */
      }
    };
  }, [onClose]);

  // The four primary assumptions, and every other one the plan does not hold
  // at its default (moved by the reader or set by the case).
  const shownLevers = cockpit.levers.filter(
    (l) => l.group === "primary" || positions[l.id] !== undefined || l.origin !== "default",
  );

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={t("forecast.cockpit.present.aria", "Presentation of the plan")}
      data-testid="cockpit-present"
      className="fixed inset-0 z-[70] overflow-y-auto bg-bg"
    >
      <div className="mx-auto max-w-[1180px] px-4 py-6 sm:px-10 sm:py-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
              {t("forecast.cockpit.present.kicker", "Five-year plan · {{case}}", { case: caseName })}
            </div>
            <h1 data-testid="cockpit-present-company" className="mt-1 text-[26px] font-semibold leading-tight text-ink sm:text-[34px]">
              {companyName}
            </h1>
            <div className="mt-1 text-[13px] text-ink-soft">
              {t("forecast.cockpit.present.standsOn", "Stands on {{period}} · every ◇ figure is a projection", {
                period: cockpit.basePeriodLabel,
              })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="cockpit-present-export"
              data-primary-action="true"
              disabled={exporting}
              onClick={onExport}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand-d disabled:opacity-60"
            >
              <FileDown size={14} strokeWidth={2} aria-hidden />
              {exporting
                ? t("forecast.cockpit.export.working", "Preparing the PDF…")
                : t("forecast.cockpit.export.button", "Export for the bank")}
            </button>
            <button
              type="button"
              data-testid="cockpit-present-close"
              onClick={onClose}
              className="inline-flex items-center gap-1 rounded-lg border border-rule px-3 py-2 text-[13px] text-ink-soft hover:text-ink"
            >
              <X size={14} strokeWidth={2} aria-hidden />
              {t("forecast.cockpit.present.close", "Close (Esc)")}
            </button>
          </div>
        </header>

        <div className="mt-6">
          <HeadlineNumbers cockpit={cockpit} lang={lang} projectedLabel={projectedLabel} answerKey={answerKey} />
        </div>
        <p data-testid="cockpit-present-sentence" className="mt-5 text-[18px] leading-snug text-ink sm:text-[20px]">
          {pick(cockpit.sentence, lang)}
        </p>
        <div className="mt-5">
          <CockpitChart
            bars={cockpit.chart.ebitda}
            cash={cockpit.chart.cash}
            format={format}
            projectedLabel={projectedLabel}
            lang={lang}
            answerKey={answerKey}
          />
        </div>
        <section data-testid="cockpit-present-assumptions" className="mt-6">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
            {t("forecast.cockpit.levers.title", "Assumptions")}
          </h2>
          <dl className="mt-2 grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
            {shownLevers.map((l) => (
              <div key={l.id} className="min-w-0 border-t border-rule-soft pt-2" data-lever-id={l.id}>
                <dt className="flex items-baseline justify-between gap-3 text-[13.5px] text-ink">
                  <span className="min-w-0">{pick(l.label, lang)}</span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {pick(l.display, lang) ||
                      (positions[l.id] !== undefined
                        ? leverText(l, positions[l.id], locale, days)
                        : t("forecast.cockpit.levers.notMeasured", "not measured"))}
                  </span>
                </dt>
                <dd className="mt-0.5 text-[12px] leading-snug text-ink-mute">{pick(l.basis, lang)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
