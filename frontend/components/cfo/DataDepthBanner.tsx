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

  const accent = depth.level >= 3 ? "#2AA89B" : depth.level === 2 ? "#2AA89B" : "#2AA89B";
  const accentBg =
    depth.level >= 3 ? "rgba(42,168,155,0.08)" :
    depth.level === 2 ? "rgba(42,168,155,0.08)" :
    "rgba(92,211,197,0.10)";
  const accentBorder =
    depth.level >= 3 ? "rgba(42,168,155,0.30)" :
    depth.level === 2 ? "rgba(42,168,155,0.30)" :
    "rgba(92,211,197,0.40)";

  if (compact) {
    return (
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] font-medium rounded-md px-2 py-0.5"
        style={{ color: accent, background: accentBg, border: `1px solid ${accentBorder}` }}
        title={`Data depth: ${depth.label}`}
      >
        <Info className="h-3 w-3" />
        Data depth: {depth.shortLabel}
      </button>
    );
  }

  return (
    <div
      className="rounded-lg overflow-hidden mb-4"
      style={{ background: accentBg, border: `1px solid ${accentBorder}` }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Info className="h-4 w-4 shrink-0" style={{ color: accent }} />
          <span className="text-[12px] font-semibold" style={{ color: accent }}>
            Data depth: {depth.label}
          </span>
          {subject && (
            <span className="text-[12px] text-ink-soft truncate">
              · {subject}
            </span>
          )}
        </div>
        <ChevronDown
          className="h-4 w-4 shrink-0 transition-transform"
          style={{
            color: accent,
            transform: open ? "rotate(180deg)" : "rotate(0)",
          }}
        />
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] font-semibold mb-1.5" style={{ color: accent }}>
              Available at this depth
            </div>
            <ul className="space-y-1">
              {depth.available.map((a) => (
                <li key={a} className="flex items-start gap-1.5 text-[12px] text-ink">
                  <Check className="h-3 w-3 mt-0.5 shrink-0" style={{ color: accent }} />
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
            <div className="md:col-span-2 mt-2 pt-2 text-[12px] text-ink-soft"
                 style={{ borderTop: `1px solid ${accentBorder}` }}>
              <span className="font-medium" style={{ color: accent }}>To unlock:&nbsp;</span>
              {depth.upgradeHint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
