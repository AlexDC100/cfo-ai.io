// CategoriesOverview — Apple-style Layer 1 of the Products redesign.
//
// 2026-05-26 — replaces the 358-row wall of SKUs that used to dominate
// the Products page. Users now land on ~25 category cards (one per
// `Categ_Pr` in the source workbook), each with a 4-KPI grid that
// puts DIO front-and-center alongside Volume / NIV / GM. Click a
// card → existing SKU table filters to that category + a "Back to
// categories" affordance appears at the top.
//
// All aggregation is CLIENT-SIDE from the existing SKU payload —
// no new backend endpoints needed. The DIO value per SKU has already
// inherited from the category map at upload time (parser at
// `_sales_extract.py:489-501`), so we can take any one SKU's DIO as
// the category DIO. We also fall back to weighted-mean if SKUs within
// a category disagree (shouldn't happen under the current parser but
// defends against future drift).
//
// Honest scope notes:
// · Deep-linkable /products/category/:slug routes — deferred (queued).
//   The drill currently sets URL `?category=X` + `?view=categories` so
//   the URL is still shareable but uses query params, not path segments.
// · Category-level Decision Rules engine integration — deferred. We
//   evaluate bucket badges client-side using the same thresholds as
//   the per-SKU model but applied to category aggregates (DIO > 365 →
//   wind_down; GM% < 5% → watch; etc.).
// · CSV export with category column — deferred.

import { useMemo, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, AlertTriangle } from "lucide-react";
import { categoryHint } from "@/lib/categoryHints";
// THE INSTRUMENT — every figure on these cards renders mono through
// <Amount>/<MoneyAmount> (FX-aware, magnitude-grouped per card).
import { Amount } from "@/components/instrument/Amount";
import { MoneyAmount, MoneyAmountGroup, PercentLevel } from "@/components/comparison/MoneyAmount";
import type { Currency } from "@/lib/rates";

// Display the category name in English (2026-07-26 per operator). The raw
// Romanian code (e.g. LEGUME CONSERVATE) is looked up in the shared
// CATEGORY_HINTS dictionary and title-cased; unknown categories fall back to
// the original source label so nothing ever renders blank.
function toEnglishLabel(raw: string): string {
  const hint = categoryHint(raw, "en");
  if (!hint) return raw;
  return hint.replace(/\b\w/g, (c) => c.toUpperCase());
}

interface SkuRow {
  id: string;
  category: string | null;
  brand: string | null;
  volume_tons: number | null;
  niv_krn: number | null;
  gm_krn: number | null;
  gm_pct: number | null;
  days_inventory_on_hand: number | null;
  inventory_value_krn: number | null;
  channels_present: string[] | null;
}

interface Props {
  skus: SkuRow[];
  /** Click handler — receives the category name verbatim from the
   *  source data (Romanian, original casing). Caller pipes this into
   *  the existing `?category=X` URL filter so the SKU table re-renders
   *  scoped to that category. */
  onSelectCategory: (category: string) => void;
  /** Financing-rate spec from the Decision Rules modal — drives the
   *  Adjusted GM line on each card. Defaults to 7% cost-of-financing +
   *  2% bank spread = 9% total carry. Same numbers compute_real_margin
   *  uses on the backend so the figures reconcile. */
  costOfFinancingPct?: number;
  bankSpreadPct?: number;
  /** Source currency the kRON aggregates are denominated in — threaded
   *  from the page's period so the global RON⇄EUR⇄USD toggle re-renders
   *  every card figure live. Defaults to RON (the SKU-upload default). */
  currency?: Currency;
}

interface CategoryAggregate {
  category: string;
  display: string;
  emoji: string;
  skuCount: number;
  brandCount: number;
  channelCount: number;
  totalVolumeKg: number;
  totalNiv: number;
  totalGm: number;
  gmPct: number | null;
  dioDays: number | null;
  inventoryValue: number | null;
  financingCost: number | null;
  adjustedGm: number | null;
  adjustedGmPct: number | null;
  bucket: "protect" | "watch" | "wind_down";
}

// ── Category emoji map ──────────────────────────────────────────────────
// Improves scannability — instant visual recognition. Keys are
// normalised (uppercase, no diacritics) to match the canonical form.
// Fallback emoji `📦` for any category not in the map.
const CATEGORY_ICONS: Record<string, string> = {
  "LEGUME CONSERVATE": "🥫",
  "JELEURI": "🍯",
  "ULEI": "🛢️",
  "COMPOT": "🍑",
  "SUC": "🧃",
  "SUC DE ROSII": "🍅",
  "MURATURI": "🥒",
  "ZACUSCA": "🥘",
  "DULCEATA": "🍓",
  "PASTA TOMATE": "🍅",
  "SIROP": "🍯",
  "PET FOOD": "🐱",
  "TON": "🐟",
  "TON FILE": "🐟",
  "MACROU": "🐠",
  "MACROU FILE": "🐠",
  "SARDINE": "🐟",
  "SARDINE FILE": "🐟",
  "HERING": "🐟",
  "HERING FILE": "🐟",
  "SOMON": "🐟",
  "SPROT": "🐟",
  "PASTRAV": "🐟",
  "MANCARE PESTE": "🐟",
  "SUPE INSTANT NOODLES": "🍜",
  "MUSTAR": "🌭",
  "SOSURI": "🍶",
  "OTET": "🍶",
  "FRUCTE NOBILE": "🍇",
  "ALTE MARFURI": "📦",
  "MANC CONGELATE CRUDE": "🧊",
};

function normalizeCategoryKey(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.trim().toUpperCase();
  // Romanian diacritic fold — matches the backend `_normalize_category`
  // logic so emoji lookup and DIO inheritance stay consistent.
  s = s.replace(/[ĂÂ]/g, "A").replace(/Î/g, "I").replace(/Ș/g, "S").replace(/Ț/g, "T");
  s = s.split(/\s+/).join(" ");
  return s;
}

function iconForCategory(raw: string): string {
  return CATEGORY_ICONS[normalizeCategoryKey(raw)] ?? "📦";
}

export function CategoriesOverview({
  skus,
  onSelectCategory,
  costOfFinancingPct = 7,
  bankSpreadPct = 2,
  currency = "RON",
}: Props) {
  const categories = useMemo<CategoryAggregate[]>(() => {
    const carryPct = (costOfFinancingPct + bankSpreadPct) / 100;
    const byCategory = new Map<string, SkuRow[]>();
    for (const s of skus) {
      const key = normalizeCategoryKey(s.category);
      if (!key) continue;
      const list = byCategory.get(key) ?? [];
      list.push(s);
      byCategory.set(key, list);
    }
    const out: CategoryAggregate[] = [];
    for (const [key, list] of byCategory.entries()) {
      const totalVolumeTons = list.reduce((a, s) => a + (s.volume_tons ?? 0), 0);
      const totalNiv = list.reduce((a, s) => a + (s.niv_krn ?? 0), 0);
      const totalGm = list.reduce((a, s) => a + (s.gm_krn ?? 0), 0);
      const gmPct = totalNiv > 0 ? totalGm / totalNiv : null;
      // DIO per SKU has already inherited from the category map at
      // upload time, so any non-null DIO in this bucket is the category
      // DIO. If all rows are null (e.g. category not in DIO sheet),
      // we honestly show "—" rather than fabricating a number.
      const firstDio = list.find((s) => s.days_inventory_on_hand != null);
      const dioDays = firstDio?.days_inventory_on_hand ?? null;
      // Inventory value: sum across covered SKUs. When a category's
      // SKUs don't carry inventory_value (only the DIO sheet does),
      // we'll get null and adjusted-GM hides itself.
      const invValues = list
        .map((s) => s.inventory_value_krn)
        .filter((v): v is number => v != null && Number.isFinite(v));
      const inventoryValue = invValues.length > 0
        ? invValues.reduce((a, v) => a + v, 0)
        : null;
      // Financing cost = inventory × (dio / 365) × carry. Needs both
      // DIO and an inventory value; otherwise null (honest).
      const financingCost = dioDays != null && inventoryValue != null
        ? inventoryValue * (dioDays / 365) * carryPct
        : null;
      // Adjusted GM = GM − financing cost. Only computed when financing
      // cost is known.
      const adjustedGm = financingCost != null ? totalGm - financingCost : null;
      const adjustedGmPct = adjustedGm != null && totalNiv > 0
        ? adjustedGm / totalNiv
        : null;
      // Bucket evaluation — category aggregate version of the SKU
      // Decision Rules. DIO over a year = capital trapped → wind down.
      // Borderline DIO or thin margin = watch. Otherwise protect.
      let bucket: "protect" | "watch" | "wind_down" = "protect";
      if (dioDays != null && dioDays > 365) {
        bucket = "wind_down";
      } else if (
        (dioDays != null && dioDays > 180)
        || (gmPct != null && gmPct < 0.05)
        || (adjustedGmPct != null && adjustedGmPct < 0)
      ) {
        bucket = "watch";
      }
      out.push({
        category: key,
        display: list[0].category ?? key,
        emoji: iconForCategory(key),
        skuCount: list.length,
        brandCount: new Set(list.map((s) => s.brand).filter(Boolean)).size,
        channelCount: new Set(list.flatMap((s) => s.channels_present ?? [])).size,
        totalVolumeKg: totalVolumeTons * 1000,
        totalNiv,
        totalGm,
        gmPct,
        dioDays,
        inventoryValue,
        financingCost,
        adjustedGm,
        adjustedGmPct,
        bucket,
      });
    }
    // Sort by total NIV descending — biggest revenue categories first.
    out.sort((a, b) => (b.totalNiv ?? 0) - (a.totalNiv ?? 0));
    return out;
  }, [skus, costOfFinancingPct, bankSpreadPct]);

  if (categories.length === 0) {
    return (
      <section
        data-testid="categories-overview-empty"
        className="rounded-3xl border border-rule bg-surface p-12 text-center text-ink-mute text-[13px]"
      >
        No categories found in this dataset.
      </section>
    );
  }

  return (
    <section
      data-testid="categories-overview"
      className="space-y-3"
    >
      {/* Header removed 2026-07-26 per operator (both the "N categories"
          heading and the "Sorted by revenue…" caption). */}
      {/* Card grid (2026-07-26 per operator) — categories laid out as a
          responsive grid instead of a single stacked column. `items-stretch`
          (grid default) + `h-full` on each card equalizes heights per row
          despite the optional Adjusted-GM / DIO-warning lines. */}
      <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {categories.map((c) => (
          <CategoryCard
            key={c.category}
            cat={c}
            currency={currency}
            onClick={() => onSelectCategory(c.display)}
          />
        ))}
      </ul>
    </section>
  );
}

// ── Single category card ────────────────────────────────────────────────

function CategoryCard({
  cat,
  currency,
  onClick,
}: {
  cat: CategoryAggregate;
  currency: Currency;
  onClick: () => void;
}) {
  const dioOverYear = cat.dioDays != null && cat.dioDays > 365;
  const adjustedGmNegative = cat.adjustedGmPct != null && cat.adjustedGmPct < 0;
  return (
    <li className="h-full">
      <button
        type="button"
        onClick={onClick}
        data-testid={`category-card-${cat.category.toLowerCase().replace(/\s+/g, "-")}`}
        className={`
          group flex h-full w-full flex-col text-left rounded-lg border bg-surface p-5
          transition-colors duration-150
          hover:bg-bg-2/30 hover:border-rule-strong
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
          ${dioOverYear
            ? "border-alert/40"
            : "border-rule"
          }
        `}
      >
        {/* Top row — name + meta (emoji removed 2026-07-26; the top-right
            bucket badge removed 2026-07-26 per operator) */}
        <div className="min-w-0">
          <h3 className="text-[15.5px] font-semibold text-ink leading-tight tracking-[-0.005em]">
            {toEnglishLabel(cat.display)}
          </h3>
          <div className="text-[11.5px] text-ink-mute mt-0.5">
            {cat.skuCount.toLocaleString("en-US")} SKUs ·{" "}
            {cat.brandCount} {cat.brandCount === 1 ? "brand" : "brands"} ·{" "}
            {cat.channelCount} {cat.channelCount === 1 ? "channel" : "channels"}
          </div>
        </div>

        {/* Divider under the header (2026-07-26 per operator) — hairline
            gradient rule separating the title/meta from the KPI grid. */}
        <div aria-hidden className="mt-3 h-px bg-gradient-to-r from-transparent via-rule-strong to-transparent" />

        {/* KPI grid — Volume / NIV / GM / DIO. 2×2 within each card so the
            cells stay legible at the narrower grid-cell width. */}
        {/* 2×2 KPI grid with cross dividers between the cells (2026-07-26 per
            operator). Borders on the top-left cell's right/bottom edges + the
            bottom-left cell's right edge + the top-right cell's bottom edge
            form a clean + separator; padding keeps values off the rules. */}
        <MoneyAmountGroup values={[cat.totalNiv * 1000, cat.totalGm * 1000]} fromCurrency={currency}>
          <div className="mt-4 grid grid-cols-2">
            <KpiCell
              label="Volume"
              value={fmtCompactKg(cat.totalVolumeKg)}
              className="border-r border-b border-rule-soft pr-4 pb-3"
            />
            <KpiCell
              label="NIV"
              value={<MoneyAmount value={cat.totalNiv * 1000} fromCurrency={currency} />}
              className="border-b border-rule-soft pl-4 pb-3"
            />
            <KpiCell
              label="GM"
              value={<MoneyAmount value={cat.totalGm * 1000} fromCurrency={currency} />}
              sub={cat.gmPct != null ? <PercentLevel value={cat.gmPct * 100} /> : null}
              className="border-r border-rule-soft pr-4 pt-3"
            />
            <KpiCell
              label="DIO"
              value={cat.dioDays != null
                ? <><Amount kind="count" value={Math.round(cat.dioDays)} />d</>
                : "—"
              }
              tone={
                cat.dioDays == null ? null
                : cat.dioDays > 365 ? "danger"
                : cat.dioDays > 180 ? "warning"
                : "positive"
              }
              className="pl-4 pt-3"
            />
          </div>
        </MoneyAmountGroup>

        {/* DIO > 365 warning callout — a danger signal, so it speaks in
            the alert token (red is reserved for exactly this). */}
        {dioOverYear && (
          <div
            data-testid="category-card-dio-warning"
            className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] text-alert"
          >
            <AlertTriangle size={12} strokeWidth={2} />
            DIO &gt; 365 days · capital trapped &gt; 1 year
          </div>
        )}

        {/* Flexible spacer — pins the sleeve to the bottom AND guarantees a
            minimum gap above it even when the card content is tall (2026-07-26
            per operator). flex-1 fills free space; min-h keeps the gap when the
            card is exactly full. */}
        <div aria-hidden className="flex-1 min-h-[12px]" />

        {/* Bottom sleeve — full-bleed footer pinned to the card's bottom edge
            (2026-07-26 per operator). The Adjusted GM (when computable) sits on
            the left and the drill chevron ">" moved into this sleeve on the
            right. Negative margins cancel the card's p-5 padding so it spans
            edge-to-edge; rounded-b-2xl matches the card corners. */}
        <div className="-mx-5 -mb-5 px-5 py-2.5 bg-bg-2/50 border-t border-rule-soft rounded-b-lg flex items-center justify-between gap-3">
          <div className="text-[12px] text-ink-soft min-w-0">
            {cat.financingCost != null && cat.adjustedGm != null && (
              <>
                Adjusted GM:{" "}
                <span
                  className={`font-medium ${
                    adjustedGmNegative
                      ? "text-alert"
                      : "text-ink"
                  }`}
                >
                  {cat.adjustedGmPct != null
                    ? <PercentLevel value={cat.adjustedGmPct * 100} />
                    : "—"
                  }
                </span>
                {" "}
                <span className="text-ink-mute">
                  (after <MoneyAmount value={cat.financingCost * 1000} fromCurrency={currency} /> financing cost)
                </span>
              </>
            )}
          </div>
          <ChevronRight
            size={14}
            strokeWidth={2}
            className="text-ink-mute group-hover:text-ink-soft group-hover:translate-x-0.5 transition-all shrink-0"
          />
        </div>
      </button>
    </li>
  );
}

// ── KPI cell ───────────────────────────────────────────────────────────
// (The legacy top-right BucketBadge was removed with the card redesign;
// its dead component went with the Instrument migration.)

function KpiCell({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode | null;
  tone?: "positive" | "warning" | "danger" | null;
  className?: string;
}) {
  // Semantic tokens only: danger = alert (red reserved for danger),
  // borderline = caution, healthy = success.
  const valueClass =
    tone === "danger" ? "text-alert"
    : tone === "warning" ? "text-caution"
    : tone === "positive" ? "text-success"
    : "text-ink";
  return (
    <div className={`space-y-0.5 ${className ?? ""}`}>
      <div className="text-[10px] uppercase tracking-[0.08em] text-ink-mute font-medium">
        {label}
      </div>
      <div className={`text-[17px] font-mono font-medium tabular-nums leading-tight ${valueClass}`}>
        {value}
      </div>
      {sub && (
        <div className="text-[12px] text-ink-mute tabular-nums">{sub}</div>
      )}
    </div>
  );
}

// ── "Back to categories" pill, exported so Products.tsx can mount it
//     above the existing SKU table when a category filter is active. ───

export function BackToCategoriesPill({
  categoryLabel,
  onClick,
}: {
  categoryLabel: string;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <button
        type="button"
        onClick={onClick}
        data-testid="back-to-categories"
        className="
          inline-flex items-center gap-1.5 h-8 px-3 rounded-lg
          border border-rule bg-surface text-[12px] font-medium
          text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors
        "
      >
        <ArrowLeft size={12} strokeWidth={2} />
        Back to categories
      </button>
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-semibold tracking-tight text-ink">{toEnglishLabel(categoryLabel)}</span>
      </div>
    </div>
  );
}

// ── Format helpers ─────────────────────────────────────────────────────
// (fmtCompactRon retired — money figures now flow through <MoneyAmount>,
// which is FX-aware and locale-correct.)

function fmtCompactKg(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}t`;
  }
  return `${Math.round(value).toLocaleString("en-US")} kg`;
}
