// PeriodBreadcrumb — the header-left period context: "‹ DEC 2025 ›".
//
// 2026-08-04 header redesign: the period breadcrumb moved back into the
// TopHeader (it had been sidebar-only since 2026-07-26); the sidebar rail
// now shows just the year. Both read the same usePeriodStepper() state, so
// they can't disagree.
//
// Arrows render only when there are ≥2 periods to step between; with one
// (or zero) the label stands alone. With nothing loaded at all we show the
// current month — every workspace keeps a permanent current-month period,
// so that is the month the app is about to land on anyway.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { currentMonthEnd, formatPeriodMonth } from "@/lib/orgPeriods";
import { usePeriodStepper } from "@/lib/usePeriodStepper";
import { useActiveLocale } from "@/lib/locale";

export function PeriodBreadcrumb() {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const { selectedEnd, prevTarget, nextTarget, showStepper, goToPeriod } =
    usePeriodStepper();

  const label =
    formatPeriodMonth(selectedEnd, locale) ??
    formatPeriodMonth(currentMonthEnd(), locale);

  return (
    <div
      data-testid="header-period-breadcrumb"
      className="flex items-center gap-0.5 min-w-0"
    >
      {showStepper && (
        <button
          type="button"
          onClick={() => prevTarget && goToPeriod(prevTarget.period_id)}
          aria-label={t("topbar.prevMonth")}
          title={`${t("topbar.prevMonth")} (${formatPeriodMonth(prevTarget?.period_end, locale) ?? ""})`}
          data-testid="header-prev-month"
          className="inline-flex h-11 w-8 sm:h-8 sm:w-7 shrink-0 items-center justify-center rounded-md text-ink-mute hover:text-ink hover:bg-bg-2/70 transition-colors duration-150"
        >
          <ChevronLeft size={14} strokeWidth={2} />
        </button>
      )}
      <span
        data-testid="header-period-label"
        className="px-0.5 font-mono text-[11.5px] uppercase tracking-[0.14em] font-semibold text-ink whitespace-nowrap tabular-nums"
      >
        {label}
      </span>
      {showStepper && (
        <button
          type="button"
          onClick={() => nextTarget && goToPeriod(nextTarget.period_id)}
          aria-label={t("topbar.nextMonth")}
          title={`${t("topbar.nextMonth")} (${formatPeriodMonth(nextTarget?.period_end, locale) ?? ""})`}
          data-testid="header-next-month"
          className="inline-flex h-11 w-8 sm:h-8 sm:w-7 shrink-0 items-center justify-center rounded-md text-ink-mute hover:text-ink hover:bg-bg-2/70 transition-colors duration-150"
        >
          <ChevronRight size={14} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
