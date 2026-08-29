// DataDepthBanner — surface what level of analysis the current data
// supports. Used at the top of any page that renders financial data,
// so the user always knows whether they're looking at "Level 1 — public
// summary" (where EBITDA, cost structure, DIO/DSO etc. aren't possible)
// or "Level 3 — full trial balance" (where everything is computable).
//
// Visual: a small inline pill with a popover that lists what's available
// AND what's gated above this depth, with an honest "upload X to unlock"
// CTA. We never hide the limitations — the user has to be able to trust
// what's on screen.

import { useState } from "react";
import { Info, ChevronDown, Check, Lock } from "lucide-react";
import type { DataDepth } from "@/lib/dataDepth";

interface Props {
  depth: DataDepth;
  /** Optional company label shown next to the depth pill ("PRO TV SRL"). */
  subject?: string | null;
  /** Compact mode: just the pill, no expanded list. Used in dense headers. */
  compact?: boolean;
}

export function DataDepthBanner({ depth, subject, compact }: Props) {
  const [open, setOpen] = useState(false);

  // All depth levels share the single product accent — depth is a fact,
  // not an alarm. Tokens only; the raw-hex inline styles are gone.

  if (compact) {
    return (
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-transparent bg-brand-tint px-2 py-0.5 text-[11px] font-medium text-brand-d dark:text-brand-l"
        title={`Data depth: ${depth.label}`}
      >
        <Info className="h-3 w-3" />
        Data depth: {depth.shortLabel}
      </button>
    );
  }

  return (
    <div className="mb-4 overflow-hidden rounded-md border border-rule bg-bg-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Info className="h-4 w-4 shrink-0 text-brand-d dark:text-brand-l" />
          <span className="text-[12px] font-semibold text-brand-d dark:text-brand-l">
            Data depth: {depth.label}
          </span>
          {subject && (
            <span className="text-[12px] text-ink-soft truncate">
              · {subject}
            </span>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-brand-d transition-transform dark:text-brand-l ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] font-semibold mb-1.5 text-brand-d dark:text-brand-l">
              Available at this depth
            </div>
            <ul className="space-y-1">
              {depth.available.map((a) => (
                <li key={a} className="flex items-start gap-1.5 text-[12px] text-ink">
                  <Check className="h-3 w-3 mt-0.5 shrink-0 text-brand-d dark:text-brand-l" />
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </div>
          {depth.unavailable.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-[0.06em] font-semibold mb-1.5 text-ink-soft">
                Requires deeper data
              </div>
              <ul className="space-y-1">
                {depth.unavailable.map((u) => (
                  <li key={u} className="flex items-start gap-1.5 text-[12px] text-ink-soft">
                    <Lock className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>{u}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {depth.upgradeHint && (
            <div className="md:col-span-2 mt-2 border-t border-rule-soft pt-2 text-[12px] text-ink-soft">
              <span className="font-medium text-brand-d dark:text-brand-l">To unlock:&nbsp;</span>
              {depth.upgradeHint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
