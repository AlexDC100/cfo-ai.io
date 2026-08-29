// MarketPulseStrip — one-line market read under the search bar.
//
// The data layer carries NO BET index series (checked: publicCompanyUniverse
// + publicCompanyPriceHistory expose per-ticker data only), so per the
// operator spec the strip uses the loaded universe's AGGREGATE and labels
// it honestly: "Piața BVB azi: mediană {{x}}%" over the live-quoted rows,
// plus the day's top mover (with its 30-day sparkline from the existing
// price-history endpoint) and ONE template-based insight line — the
// sector with the strongest median day change and its leading ticker.
//
// Renders nothing when no row carries a live priceChangePct (static /
// demo fallback) — a fake pulse is worse than none.
//
// THE INSTRUMENT: hairline strip (no resting shadow), figures through
// <Amount>, movement colors from the semantic tokens (success up,
// alert down) — never raw hex.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Activity, TrendingUp, TrendingDown, Sparkles } from "lucide-react";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { Sparkline } from "@/components/dashboard/Sparkline";
import { Amount } from "@/components/instrument/Amount";
import { fmtSignedPct, useCardSparkline } from "./pciData";
import "./pciI18n";

interface Props {
  rows: PublicCompanyFinancialSnapshot[];
  onSelectTicker: (ticker: string) => void;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function MarketPulseStrip({ rows, onSelectTicker }: Props) {
  const { t } = useTranslation();

  const pulse = useMemo(() => {
    const quoted = rows.filter(
      (r): r is PublicCompanyFinancialSnapshot & { priceChangePct: number } =>
        typeof r.priceChangePct === "number" && Number.isFinite(r.priceChangePct),
    );
    if (quoted.length === 0) return null;

    const med = median(quoted.map((r) => r.priceChangePct));

    // Top mover — largest absolute day change.
    const topMover = [...quoted].sort(
      (a, b) => Math.abs(b.priceChangePct) - Math.abs(a.priceChangePct),
    )[0];

    // Insight — the sector with the strongest median day change among
    // sectors with ≥3 quoted members, plus its leading ticker.
    const bySector = new Map<string, typeof quoted>();
    for (const r of quoted) {
      const s = r.sector ?? "—";
      if (!bySector.has(s)) bySector.set(s, []);
      bySector.get(s)!.push(r);
    }
    let insight: { sector: string; ticker: string; change: number } | null = null;
    let bestMed = -Infinity;
    for (const [sector, members] of bySector) {
      if (members.length < 3) continue;
      const m = median(members.map((r) => r.priceChangePct));
      if (m > bestMed) {
        bestMed = m;
        const lead = [...members].sort((a, b) => b.priceChangePct - a.priceChangePct)[0];
        insight = { sector, ticker: lead.ticker, change: lead.priceChangePct };
      }
    }

    return { n: quoted.length, med, topMover, insight };
  }, [rows]);

  const moverTicker = pulse?.topMover.ticker ?? "";
  const spark = useCardSparkline(moverTicker, !!pulse);
  const sparkData = spark.data && spark.data.length >= 2 ? spark.data : null;

  if (!pulse) return null;

  const moverUp = pulse.topMover.priceChangePct >= 0;

  return (
    <section
      data-testid="market-pulse-strip"
      className="
        flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-rule
        bg-bg-2 px-4 py-2 text-[12px] min-w-0
      "
    >
      {/* Aggregate — honest label: the universe's median day change. */}
      <span className="inline-flex items-center gap-2 min-w-0">
        <Activity size={13} strokeWidth={2} className="shrink-0 text-brand-dark dark:text-brand-light" />
        <span className="text-ink font-medium">{t("pci.pulse.marketLead")}</span>
        <Amount
          kind="percent"
          value={pulse.med / 100}
          fractionDigits={2}
          className="text-[12px] text-ink"
        />
        <span className="font-mono text-[10.5px] tabular-nums text-ink-soft">
          {t("pci.pulse.n", { n: pulse.n })}
        </span>
      </span>

      {/* Top mover — ticker + change + 30d sparkline. */}
      <button
        type="button"
        onClick={() => onSelectTicker(pulse.topMover.ticker)}
        data-testid="pulse-top-mover"
        className="inline-flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity duration-micro"
      >
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-ink-soft">
          {t("pci.pulse.topMover")}
        </span>
        {moverUp ? (
          <TrendingUp size={12} strokeWidth={2} className="text-success" />
        ) : (
          <TrendingDown size={12} strokeWidth={2} className="text-alert" />
        )}
        <span className="font-mono font-medium text-ink">
          {pulse.topMover.ticker.replace(/\.BVB$/, "")}
        </span>
        <Amount
          kind="percent"
          value={pulse.topMover.priceChangePct / 100}
          fractionDigits={2}
          className={`text-[12px] ${moverUp ? "text-success" : "text-alert"}`}
        />
        {sparkData && (
          <span className="w-[72px] pointer-events-none">
            <Sparkline
              data={sparkData}
              idKey={`pulse-${moverTicker.replace(/\W/g, "")}`}
              positive={moverUp}
              height={22}
            />
          </span>
        )}
      </button>

      {/* Generated insight — template-based, from loaded data only. */}
      {pulse.insight && (
        <span
          data-testid="pulse-insight"
          className="inline-flex items-center gap-1.5 min-w-0 text-ink-soft"
        >
          <Sparkles size={12} strokeWidth={2} className="shrink-0 text-brand-dark dark:text-brand-light" />
          <span className="truncate">
            {t("pci.pulse.insight", {
              sector: pulse.insight.sector,
              ticker: pulse.insight.ticker.replace(/\.BVB$/, ""),
              change: fmtSignedPct(pulse.insight.change),
            })}
          </span>
        </span>
      )}
    </section>
  );
}
