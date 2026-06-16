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

import { motion } from "framer-motion";
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

export function ViewToggle({ value, onChange }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Products view mode"
      data-testid="products-view-toggle"
      className="
        inline-flex items-center p-0.5 rounded-full
        bg-bg-2/60 border border-rule
        shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]
      "
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
              relative inline-flex items-center gap-1.5
              px-3 py-1.5 rounded-full
              text-[12px] font-medium
              transition-colors duration-150
              ${active ? "text-ink" : "text-ink-mute hover:text-ink-soft"}
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
            `}
          >
            {/* Sliding indicator — Framer Motion `layoutId` smoothly
                animates the pill from one option to the other on click.
                Sits BEHIND the label/icon (z-0) so they stay readable. */}
            {active && (
              <motion.span
                layoutId="products-view-toggle-pill"
                className="
                  absolute inset-0 rounded-full
                  bg-surface border border-rule
                  shadow-[0_1px_2px_rgba(0,0,0,0.06)]
                "
                transition={{ type: "spring", stiffness: 500, damping: 32 }}
              />
            )}
            <opt.Icon
              size={12}
              strokeWidth={2}
              className="relative z-10 shrink-0"
            />
            <span className="relative z-10">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
