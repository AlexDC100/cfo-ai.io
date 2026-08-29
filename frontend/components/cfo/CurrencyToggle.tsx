// Apple-quality segmented control for currency display.
//
//   ┌────────────────────────────────┐
//   │ ●  RON    EUR    USD           │
//   └────────────────────────────────┘
//   ▲ active segment, slides smoothly between positions on click
//
// Implementation:
//   - 3 buttons inside a pill container with a single absolutely-positioned
//     indicator that animates between positions via Framer Motion's
//     `layoutId` (FLIP under the hood — spring physics, not linear ease).
//   - Active segment text fades to high-contrast; inactive text dims.
//   - Stale-rates indicator: subtle dot in the corner when rates.stale=true,
//     hover for tooltip.
//
// Sizing: 32px tall, ~150px wide. Sits next to the AccountMenu in TopHeader.

import { useCurrency } from "@/stores/currency";
import type { Currency } from "@/lib/rates";

const CURRENCIES: Currency[] = ["RON", "EUR", "USD"];

export function CurrencyToggle() {
  const { display, setDisplay, rates } = useCurrency();
  const stale = !!rates?.stale;

  return (
    <div
      role="radiogroup"
      aria-label="Display currency"
      className="
        relative inline-flex items-center gap-0.5 p-0.5
        rounded-full border border-rule bg-bg-2
        h-8 select-none
      "
    >
      {CURRENCIES.map((c) => {
        const isActive = display === c;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => setDisplay(c)}
            className="
              relative z-10
              inline-flex items-center justify-center
              px-3 h-7 min-w-[44px]
              text-[11.5px] font-medium tracking-wide
              rounded-full
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
              transition-colors duration-150
            "
            style={{
              color: isActive
                ? "hsl(var(--ink))"
                : "hsl(var(--ink-soft))",
            }}
            data-testid={`currency-toggle-${c.toLowerCase()}`}
          >
            {/* Active indicator — plain static span. This used to be a
                framer-motion shared-layout element (layoutId), but layout
                projections re-measure during route transitions and the
                indicator would animate in from stale viewport coordinates
                (visibly flying from the top/bottom of the screen on tab
                switches). A static per-segment indicator can't glitch. */}
            {isActive && (
              <span
                aria-hidden="true"
                className="
                  ask-ai-anim-fill
                  absolute inset-0 z-[-1]
                  rounded-full border border-brand/40
                "
              />
            )}
            <span className="relative">{c}</span>
          </button>
        );
      })}

      {/* Stale-rates indicator — subtle amber dot in top-right corner.
          Hover for tooltip with rate source + date. */}
      {stale && (
        <span
          aria-label={`Exchange rates from ${rates.as_of} (offline fallback)`}
          title={`Exchange rates from ${rates.as_of} (offline fallback). Refresh in Settings.`}
          className="
            absolute -top-0.5 -right-0.5
            h-2 w-2 rounded-full bg-caution
            ring-1 ring-[hsl(var(--surface))]
          "
        />
      )}
    </div>
  );
}
