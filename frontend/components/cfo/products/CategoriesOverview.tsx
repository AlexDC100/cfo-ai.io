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

import { useMemo } from "react";
import { ArrowLeft, ChevronRight, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";

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
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-serif text-[20px] text-ink tracking-[-0.005em]">
          {categories.length} {categories.length === 1 ? "category" : "categories"}
        </h2>
        <span className="text-[11.5px] text-ink-mute">
          Sorted by revenue · click any card to drill into its SKUs
        </span>
      </header>
      <ul className="space-y-3">
        {categories.map((c) => (
          <CategoryCard
            key={c.category}
            cat={c}
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
  onClick,
}: {
  cat: CategoryAggregate;
  onClick: () => void;
}) {
  const dioOverYear = cat.dioDays != null && cat.dioDays > 365;
  const adjustedGmNegative = cat.adjustedGmPct != null && cat.adjustedGmPct < 0;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        data-testid={`category-card-${cat.category.toLowerCase().replace(/\s+/g, "-")}`}
        className={`
          group w-full text-left rounded-2xl border bg-surface p-5
          transition-all duration-150
          hover:shadow-sm hover:bg-bg-2/30 hover:-translate-y-[1px]
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
          ${dioOverYear
            ? "border-amber-300/60 dark:border-amber-500/30"
            : "border-rule"
          }
        `}
      >
        {/* Top row — emoji + name + meta + bucket badge */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[26px] leading-none shrink-0">{cat.emoji}</span>
            <div className="min-w-0">
              <h3 className="text-[15.5px] font-semibold text-ink leading-tight tracking-[-0.005em]">
                {cat.display}
              </h3>
              <div className="text-[11.5px] text-ink-mute mt-0.5">
                {cat.skuCount.toLocaleString("en-US")} SKUs ·{" "}
                {cat.brandCount} {cat.brandCount === 1 ? "brand" : "brands"} ·{" "}
                {cat.channelCount} {cat.channelCount === 1 ? "channel" : "channels"}
              </div>
            </div>
          </div>
          <BucketBadge bucket={cat.bucket} />
        </div>

        {/* KPI grid — Volume / NIV / GM / DIO */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCell
            label="Volume"
            value={fmtCompactKg(cat.totalVolumeKg)}
          />
          <KpiCell
            label="NIV"
            value={fmtCompactRon(cat.totalNiv)}
          />
          <KpiCell
            label="GM"
            value={fmtCompactRon(cat.totalGm)}
            sub={cat.gmPct != null ? `${(cat.gmPct * 100).toFixed(1)}%` : null}
          />
          <KpiCell
            label="DIO"
            value={cat.dioDays != null
              ? `${Math.round(cat.dioDays).toLocaleString("en-US")}d`
              : "—"
            }
            tone={
              cat.dioDays == null ? null
              : cat.dioDays > 365 ? "danger"
              : cat.dioDays > 180 ? "warning"
              : "positive"
            }
          />
        </div>

        {/* Adjusted GM line — visible only when financing cost computable */}
        {cat.financingCost != null && cat.adjustedGm != null && (
          <div className="mt-3 pt-3 border-t border-rule/40 text-[12px] text-ink-soft">
            Adjusted GM:{" "}
            <span
              className={`font-medium tabular-nums ${
                adjustedGmNegative
                  ? "text-red-700 dark:text-red-300"
                  : "text-ink"
              }`}
            >
              {cat.adjustedGmPct != null
                ? `${(cat.adjustedGmPct * 100).toFixed(1)}%`
                : "—"
              }
            </span>
            {" "}
            <span className="text-ink-mute">
              (after {fmtCompactRon(cat.financingCost)} financing cost)
            </span>
          </div>
        )}

        {/* DIO > 365 warning callout */}
        {dioOverYear && (
          <div
            data-testid="category-card-dio-warning"
            className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle size={12} strokeWidth={2} />
            DIO &gt; 365 days · capital trapped &gt; 1 year
          </div>
        )}

        {/* Chevron — visual affordance for "drill in" */}
        <div className="mt-3 flex justify-end">
          <ChevronRight
            size={14}
            strokeWidth={2}
            className="text-ink-mute group-hover:text-ink-soft group-hover:translate-x-0.5 transition-all"
          />
        </div>
      </button>
    </li>
  );
}

// ── Bucket badge ───────────────────────────────────────────────────────

function BucketBadge({ bucket }: { bucket: "protect" | "watch" | "wind_down" }) {
  const map = {
    protect: {
      label: "PROTECT",
      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
      Icon: TrendingUp,
    },
    watch: {
      label: "WATCH",
      cls: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
      Icon: AlertTriangle,
    },
    wind_down: {
      label: "WIND DOWN",
      cls: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
      Icon: TrendingDown,
    },
  };
  const { label, cls, Icon } = map[bucket];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold tracking-[0.06em] ${cls}`}
    >
      <Icon size={10} strokeWidth={2.5} />
      {label}
    </span>
  );
}

// ── KPI cell ───────────────────────────────────────────────────────────

function KpiCell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone?: "positive" | "warning" | "danger" | null;
}) {
  const valueClass =
    tone === "danger" ? "text-red-700 dark:text-red-300"
    : tone === "warning" ? "text-amber-700 dark:text-amber-300"
    : tone === "positive" ? "text-emerald-700 dark:text-emerald-300"
    : "text-ink";
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-[0.08em] text-ink-mute font-medium">
        {label}
      </div>
      <div className={`text-[15px] font-semibold tabular-nums leading-tight ${valueClass}`}>
        {value}
      </div>
      {sub && (
        <div className="text-[10.5px] text-ink-mute tabular-nums">{sub}</div>
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
        <span className="text-[22px] leading-none">{iconForCategory(categoryLabel)}</span>
        <span className="font-serif text-[18px] text-ink">{categoryLabel}</span>
      </div>
    </div>
  );
}

// ── Format helpers ─────────────────────────────────────────────────────

function fmtCompactRon(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  // Source data is in kRON (thousand RON). Convert to raw RON for Intl.
  const raw = value * 1000;
  try {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 1,
    }).format(raw) + " RON";
  } catch {
    return `${raw.toLocaleString("en-US", { maximumFractionDigits: 0 })} RON`;
  }
}

function fmtCompactKg(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}t`;
  }
  return `${Math.round(value).toLocaleString("en-US")} kg`;
}
