// CompareTray — compare mode for the Public Company Intelligence page
// (2026-08-04 redesign).
//
// Cards carry a compare checkbox (max 3); once ≥1 is picked this tray
// renders a sticky bar pinned to the bottom of the viewport (bottom-sheet
// styling on mobile). "Compară" opens a bottom Sheet with a side-by-side
// table: margins, leverage, valuation, dividend — every figure read
// verbatim from the loaded universe snapshots. The workspace company
// ("Compania ta") can be toggled in as an extra column when the loaded
// period carries the metric; market-linked rows (price, P/E, EV/EBITDA,
// dividend) show "—" for it — a private company has no market price.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, ArrowLeftRight } from "lucide-react";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { CompanyLogo } from "./CompanyLogo";
import {
  fmtCompactMoney,
  fmtPct1,
  fmtPrice,
  fmtSignedPct,
  fmtX,
  type WorkspaceBenchMetrics,
} from "./pciData";
import "./pciI18n";

interface Props {
  rows: PublicCompanyFinancialSnapshot[];
  workspace: WorkspaceBenchMetrics | null;
  onRemove: (ticker: string) => void;
  onClear: () => void;
  /** True when the 3-company cap is hit — the bar shows the cap note. */
  atLimit: boolean;
}

export function CompareTray({ rows, workspace, onRemove, onClear, atLimit }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [includeYou, setIncludeYou] = useState(false);

  if (rows.length === 0) return null;

  return (
    <>
      {/* Sticky bar — fixed to the viewport bottom, centred; safe-area
          padded so it clears the iOS home indicator. */}
      <div
        data-testid="compare-tray"
        className="
          fixed inset-x-0 bottom-0 z-40 flex justify-center
          px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]
          pointer-events-none
        "
      >
        <div
          className="
            pointer-events-auto flex items-center gap-2 sm:gap-3 min-w-0 max-w-full
            rounded-2xl border border-rule bg-surface/95 backdrop-blur-md
            shadow-[0_18px_50px_-18px_rgba(0,0,0,0.6)]
            px-3 py-2
          "
        >
          <span className="hidden sm:inline text-[11px] text-ink-mute whitespace-nowrap">
            {t("pci.compare.selected", { n: rows.length })}
          </span>
          <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {rows.map((r) => (
              <span
                key={r.ticker}
                className="inline-flex items-center gap-1 rounded-lg border border-rule bg-bg-2/50 pl-1 pr-0.5 py-0.5"
              >
                <CompanyLogo
                  ticker={r.ticker.replace(/\.BVB$/, "")}
                  variant="monogram"
                  size={20}
                  className="rounded"
                />
                <span className="font-mono text-[11px] font-semibold text-ink tabular-nums">
                  {r.ticker.replace(/\.BVB$/, "")}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(r.ticker)}
                  aria-label={`− ${r.ticker}`}
                  className="h-7 w-7 flex items-center justify-center text-ink-mute hover:text-ink"
                >
                  <X size={11} strokeWidth={2.25} />
                </button>
              </span>
            ))}
          </div>
          {atLimit && (
            <span className="hidden md:inline text-[10.5px] text-ink-mute whitespace-nowrap">
              {t("pci.compare.limit")}
            </span>
          )}
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 h-11 px-2.5 text-[11.5px] text-ink-soft hover:text-ink transition-colors"
          >
            {t("pci.compare.clear")}
          </button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={rows.length < 2}
            data-testid="compare-open"
            className="
              shrink-0 inline-flex items-center gap-1.5 h-11 px-4 rounded-xl
              bg-brand text-paper text-[12.5px] font-medium
              hover:bg-brand-dark transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
            "
          >
            <ArrowLeftRight size={13} strokeWidth={2} />
            {t("pci.compare.cta")}
          </button>
        </div>
      </div>

      {/* Side-by-side sheet — bottom sheet, table scrolls horizontally in
          its own container so the page never overflows. */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl max-h-[85dvh] overflow-y-auto"
          data-testid="compare-sheet"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="text-[15px] font-semibold tracking-[-0.005em]">
              {t("pci.compare.title")}
            </SheetTitle>
            <SheetDescription className="text-[12px]">
              {t("pci.compare.subtitle")}
            </SheetDescription>
          </SheetHeader>

          {workspace && (
            <label className="mt-3 inline-flex items-center gap-2 text-[12px] text-ink cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeYou}
                onChange={(e) => setIncludeYou(e.target.checked)}
                className="h-4 w-4 accent-brand"
                data-testid="compare-include-you"
              />
              {t("pci.compare.includeYou")}
            </label>
          )}

          <div className="mt-4 overflow-x-auto">
            <CompareTable rows={rows} workspace={includeYou ? workspace : null} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

// ── Table ────────────────────────────────────────────────────────────────

type CellFn = (r: PublicCompanyFinancialSnapshot) => string;
type YouFn = (w: WorkspaceBenchMetrics) => string;

interface RowDef {
  key: string;
  labelKey: string;
  cell: CellFn;
  /** Workspace value — omitted rows render "—" for Compania ta. */
  you?: YouFn;
}

const dash = "—";

const ROWS: RowDef[] = [
  {
    key: "revenue",
    labelKey: "pci.compare.row.revenue",
    cell: (r) => fmtCompactMoney(r.revenue, r.currency),
    you: (w) => fmtCompactMoney(w.revenue, "RON"),
  },
  {
    key: "mktCap",
    labelKey: "pci.compare.row.mktCap",
    cell: (r) => fmtCompactMoney(r.marketCap, r.currency),
  },
  {
    key: "price",
    labelKey: "pci.compare.row.price",
    cell: (r) =>
      r.price == null
        ? dash
        : `${fmtPrice(r.price, r.currency)} · ${fmtSignedPct(r.priceChangePct)}`,
  },
  {
    key: "ebitdaMargin",
    labelKey: "pci.compare.row.ebitdaMargin",
    cell: (r) => fmtPct1(r.ebitdaMargin),
    you: (w) => fmtPct1(w.ebitda_margin_pct),
  },
  {
    key: "netMargin",
    labelKey: "pci.compare.row.netMargin",
    cell: (r) => fmtPct1(r.netMargin),
    you: (w) => fmtPct1(w.net_margin_pct),
  },
  {
    key: "leverage",
    labelKey: "pci.compare.row.leverage",
    cell: (r) => fmtX(r.netDebtToEbitda),
    you: (w) => fmtX(w.net_debt_to_ebitda),
  },
  {
    key: "debtToEquity",
    labelKey: "pci.compare.row.debtToEquity",
    cell: (r) => fmtX(r.debtToEquity),
    you: (w) => fmtX(w.debt_to_equity),
  },
  {
    key: "pe",
    labelKey: "pci.compare.row.pe",
    cell: (r) => fmtX(r.peRatio),
  },
  {
    key: "evEbitda",
    labelKey: "pci.compare.row.evEbitda",
    cell: (r) => fmtX(r.evToEbitda),
  },
  {
    key: "dividend",
    labelKey: "pci.compare.row.dividend",
    cell: (r) => fmtPct1(r.dividendYield),
  },
];

function CompareTable({
  rows,
  workspace,
}: {
  rows: PublicCompanyFinancialSnapshot[];
  workspace: WorkspaceBenchMetrics | null;
}) {
  const { t } = useTranslation();
  return (
    <table className="w-full min-w-[520px] border-collapse text-[12px]">
      <thead>
        <tr>
          <th className="text-left font-normal text-[10.5px] uppercase tracking-[0.1em] text-ink-mute pb-2 pr-3" />
          {rows.map((r) => (
            <th key={r.ticker} className="pb-2 px-3 text-right align-bottom">
              <div className="flex flex-col items-end gap-1">
                <CompanyLogo
                  ticker={r.ticker.replace(/\.BVB$/, "")}
                  variant="monogram"
                  size={28}
                  className="rounded-md"
                />
                <span className="font-mono font-semibold text-[12px] text-ink tabular-nums">
                  {r.ticker.replace(/\.BVB$/, "")}
                </span>
                <span className="text-[10px] text-ink-mute font-normal max-w-[120px] truncate">
                  {r.companyName}
                </span>
              </div>
            </th>
          ))}
          {workspace && (
            <th className="pb-2 px-3 text-right align-bottom">
              <div className="flex flex-col items-end gap-1">
                <span
                  className="
                    inline-flex items-center rounded-full border border-brand/50 bg-brand/15
                    px-2 py-0.5 text-[10px] font-semibold text-ink
                  "
                >
                  {t("pci.bench.you")}
                </span>
                <span className="text-[10px] text-ink-mute font-normal max-w-[120px] truncate">
                  {workspace.name}
                </span>
              </div>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.key} className="border-t border-rule/60">
            <td className="py-2 pr-3 text-ink-soft whitespace-nowrap">
              {t(row.labelKey)}
            </td>
            {rows.map((r) => (
              <td
                key={r.ticker}
                className="py-2 px-3 text-right text-ink tabular-nums whitespace-nowrap"
              >
                {row.cell(r)}
              </td>
            ))}
            {workspace && (
              <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-ink bg-brand/5">
                {row.you ? row.you(workspace) : dash}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
