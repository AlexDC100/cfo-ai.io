// CurrencyMenu — compact display-currency dropdown for the TopHeader.
//
// 2026-08-04 header redesign: replaces the 3-segment CurrencyToggle pill
// (~150px) with the active code alone ("RON ▾", ~64px). The dropdown lists
// RON / EUR / USD; picking one drives the same global useCurrency() store,
// so every <Money> instance re-renders exactly as before.

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrency } from "@/stores/currency";
import type { Currency } from "@/lib/rates";

const CURRENCIES: Currency[] = ["RON", "EUR", "USD"];

export function CurrencyMenu() {
  const { t } = useTranslation();
  const { display, setDisplay, rates } = useCurrency();
  const [open, setOpen] = useState(false);
  const stale = !!rates?.stale;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("topbar.displayCurrency")}
          data-testid="currency-menu-trigger"
          className="
            relative inline-flex items-center gap-1
            h-11 sm:h-8 px-2.5 rounded-full
            border border-rule bg-bg-2
            text-[11.5px] font-medium tracking-wide text-ink-soft
            hover:text-ink hover:border-rule-strong
            data-[state=open]:text-ink data-[state=open]:border-brand/40
            transition-colors duration-150
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
          "
        >
          <span className="tabular-nums">{display}</span>
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={`opacity-60 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          />
          {stale && (
            <span
              aria-label={t("topbar.staleRates", { date: rates?.as_of ?? "" })}
              title={t("topbar.staleRates", { date: rates?.as_of ?? "" })}
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-brand ring-1 ring-[hsl(var(--surface))]"
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="min-w-[120px] p-1 rounded-xl bg-surface/95 backdrop-blur-xl border border-rule shadow-[0_18px_50px_-12px_rgba(0,0,0,0.45)]"
      >
        <div role="radiogroup" aria-label={t("topbar.displayCurrency")}>
          {CURRENCIES.map((c) => {
            const active = display === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`currency-menu-${c.toLowerCase()}`}
                onClick={() => {
                  setDisplay(c);
                  setOpen(false);
                }}
                className={`
                  w-full inline-flex items-center justify-between gap-3
                  px-2.5 py-2 min-h-[40px] rounded-lg text-left text-[12.5px]
                  transition-colors duration-150
                  ${active ? "text-ink bg-brand/[0.08]" : "text-ink-soft hover:text-ink hover:bg-bg-2/70"}
                `}
              >
                <span className="tabular-nums font-medium">{c}</span>
                {active && <Check size={13} strokeWidth={2.5} className="text-brand-d" />}
              </button>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
