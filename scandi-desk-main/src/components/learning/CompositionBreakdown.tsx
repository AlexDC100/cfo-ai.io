// LEARN-FIX-1 (2026-06-08) — Composition view for source accounts.
//
// Replaces the flat "list of source accounts" rendering that lived
// inline in LearningPopover. The new view shows each account as a
// proportional bar so the user perceives the composition first and
// the individual amounts second. Sorted largest first; tier-coloured
// (top contributor gets full accent, next two get 70%, rest 40%); a
// staggered entry animation so the structure visually assembles.
//
// Why this exists separately from the existing flat list:
//   · The 0-RON bug made the source-account list useless — clearing
//     zero rows is half the fix, but without a visual share the
//     user still has to do mental math to spot the dominant
//     contributor. Bars make that instant.
//   · A future Part 3 will apply this same view to EBITDA / COGS /
//     OpEx / Debt / WC / Cash by branching on whether the concept
//     resolves to accounts vs a formula. This component is the
//     reusable primitive that work will compose against.
//
// Sign convention:
//   · Positive amounts render as full bars.
//   · Negative amounts (contra-revenue, contra-asset) render as a
//     compact line under the bars with a leading "−" — they reduce
//     the total but aren't useful as bars of their own.
//
// Honours `prefers-reduced-motion` via `useReducedMotion()` so the
// stagger animation doesn't fire when the OS disables motion.

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Money } from "@/components/ui/Money";
import type { Currency } from "@/lib/rates";
import type { ResolvedSourceAccount } from "@/lib/learning/sourceAccountMap";

interface Props {
  accounts: ResolvedSourceAccount[];
  /** Display currency for the Money component. */
  currency: string;
  /** Optional locale hint — when "ro" prefer `labelRo` if available. */
  locale?: "en" | "ro";
}

/** Tier accent class — top contributor accented, next two 70%, rest 40%. */
function tierBarClass(rank: number): string {
  if (rank === 0) return "bg-[hsl(165,75%,55%)]";
  if (rank < 3) return "bg-[hsl(165,75%,55%)]/70";
  return "bg-[hsl(165,75%,55%)]/40";
}

export function CompositionBreakdown({ accounts, currency, locale = "en" }: Props) {
  const reduce = useReducedMotion();

  // LEARN-MOBILE F3 (2026-06-16) — Container-ready gate.
  //
  // The mobile sheet enters with a translate + scale animation (~250ms).
  // If we animate bar widths to `${share * 100}%` immediately on mount,
  // the percentage is computed against the container width AT t=0 — when
  // the sheet is still scaling from ~95% to 100%. Bars render at slightly
  // off proportions, then snap once the sheet settles. Result on mobile:
  // visible jank, bars that look wrong-sized for a beat.
  //
  // Fix: gate the bar animation behind two `requestAnimationFrame`s. By
  // the time both have fired, the sheet has fully entered and the parent
  // container has its final width. Then we kick the bar animation —
  // proportions are correct on first paint.
  //
  // On `prefers-reduced-motion` we skip the gate and render at final
  // width immediately (no animation at all).
  const [containerReady, setContainerReady] = useState(reduce);
  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => {
        if (!cancelled) setContainerReady(true);
      });
      return () => cancelAnimationFrame(id2);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id1);
    };
  }, [reduce]);

  // Cohort split — positive bars vs negative (contra) line items.
  const positives = accounts.filter((a) => a.amount > 0);
  const negatives = accounts.filter((a) => a.amount < 0);

  // Build display labels respecting locale.
  const displayLabel = (a: ResolvedSourceAccount): string =>
    locale === "ro" && a.labelRo ? a.labelRo : a.label;

  // Empty state — composition can't be drawn without populated cohort.
  if (positives.length === 0 && negatives.length === 0) {
    return (
      <p className="text-[11.5px] text-white/45">
        No source accounts carry a non-zero balance this period.
      </p>
    );
  }

  return (
    <div
      data-testid="composition-breakdown"
      className="space-y-3"
    >
      {positives.map((acc, i) => (
        <motion.div
          key={acc.code}
          initial={reduce ? undefined : { opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{
            delay: reduce ? 0 : i * 0.04,
            duration: 0.3,
            ease: [0.16, 1, 0.3, 1],
          }}
          className="space-y-1.5"
          data-testid={`composition-row-${acc.code}`}
        >
          {/* Bar + percentage */}
          <div className="flex items-baseline gap-3">
            <div className="relative flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
              <motion.div
                initial={reduce ? { width: `${(acc.share ?? 0) * 100}%` } : { width: 0 }}
                // F3: only animate to final width once `containerReady`
                // fires — otherwise the bar would compute its width
                // against the sheet mid-enter-animation and render
                // slightly off proportions.
                animate={{
                  width: containerReady ? `${(acc.share ?? 0) * 100}%` : 0,
                }}
                transition={{
                  delay: reduce ? 0 : i * 0.04 + 0.05,
                  duration: 0.6,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className={`h-full rounded-full ${tierBarClass(i)}`}
                aria-hidden
              />
            </div>
            <span className="text-[10.5px] font-medium tabular-nums text-white/55 flex-shrink-0 w-10 text-right">
              {((acc.share ?? 0) * 100).toFixed(1)}%
            </span>
          </div>

          {/* Code + label + amount row */}
          <div className="flex items-baseline justify-between gap-3 min-w-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="font-mono text-[10px] text-white/40 flex-shrink-0">
                {acc.code}
              </span>
              <span className="text-[12px] truncate text-white/75">
                {displayLabel(acc)}
              </span>
            </div>
            <span className="text-[12px] font-semibold tabular-nums flex-shrink-0 text-white/90">
              <Money
                value={acc.amount}
                fromCurrency={currency as Currency}
                compact
              />
            </span>
          </div>
        </motion.div>
      ))}

      {negatives.length > 0 && (
        <div className="pt-2 mt-2 border-t border-white/[0.06] space-y-1">
          {negatives.map((acc) => (
            <div
              key={acc.code}
              data-testid={`composition-row-${acc.code}`}
              className="flex items-baseline justify-between gap-3 min-w-0 py-1"
            >
              <span className="inline-flex items-baseline gap-2 min-w-0 text-[11px] text-white/55">
                <span className="font-mono text-white/35 flex-shrink-0">−</span>
                <span className="font-mono text-[10px] text-white/40 flex-shrink-0">
                  {acc.code}
                </span>
                <span className="truncate">{displayLabel(acc)}</span>
              </span>
              <span className="text-[11px] tabular-nums flex-shrink-0 text-white/75">
                −
                <Money
                  value={acc.magnitude}
                  fromCurrency={currency as Currency}
                  compact
                />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
