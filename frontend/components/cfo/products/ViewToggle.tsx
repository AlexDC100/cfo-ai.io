// ViewToggle — segmented pill control for Products page's
// Categories / All-SKUs switch.
//
// 2026-05-26 — replaces the `<select>` dropdown at Products.tsx:679.
// The dropdown worked but felt vestigial next to the rest of the
// design language. This is the Apple-Music / Linear-style toggle:
// two pill-shaped buttons inside a track, with a sliding indicator
// (Framer Motion `layoutId`) that animates between selections.
//
// The toggle is purely visual — URL state ownership (?view=all)
// stays in Products.tsx so deep links + back-button work.

import { LayoutGrid, List as ListIcon } from "lucide-react";

export type ProductsView = "categories" | "all";

interface Props {
  value: ProductsView;
  onChange: (v: ProductsView) => void;
}

const OPTIONS: ReadonlyArray<{
  id: ProductsView;
  label: string;
  Icon: typeof LayoutGrid;
}> = [
  { id: "categories", label: "By category", Icon: LayoutGrid },
  { id: "all",        label: "All SKUs",    Icon: ListIcon },
];

// Styled to match the Public Companies tab strip (Overview / Risk Radar /
// Geographic Map) — 2026-07-26 per operator: a rounded-xl track with a static
// bg-surface active pill + subtle shadow, rather than the old sliding
// rounded-full segmented control.
export function ViewToggle({ value, onChange }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Products view mode"
      data-testid="products-view-toggle"
      className="inline-flex p-1 rounded-xl border border-rule/60 bg-bg-2/40 gap-1"
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.id)}
            data-testid={`view-toggle-${opt.id}`}
            data-active={active}
            className={`
              inline-flex items-center gap-1.5
              h-8 px-3 rounded-lg
              text-[12.5px] font-medium
              transition-colors
              ${active
                ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.2)]"
                : "text-ink-soft hover:text-ink"}
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
            `}
          >
            <opt.Icon size={13} strokeWidth={1.75} className="shrink-0" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
