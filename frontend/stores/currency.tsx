// Global currency display store — React Context-based.
//
// State:
//   - display: user's chosen currency (RON/EUR/USD), persisted in localStorage
//   - rates: latest FX payload (rates + source + stale flag)
//   - refresh(): force-fetch fresh rates from /api/fx-rates
//   - setDisplay(c): change display currency
//
// Persistence:
//   - User choice in localStorage (`cfo:currency-display:v1`)
//   - Rates cached separately in lib/rates.ts (`cfo:fx-rates:v1`)
//
// Render perf:
//   - Context value is memoized; consumer re-renders only when display OR
//     rates change (not on every render of CurrencyProvider's children).
//   - The `<Money>` component reads display + rates from this context —
//     toggling currency re-renders all Money instances in one pass.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  type Currency,
  type RatesPayload,
  getInitialRates,
  fetchRates,
} from "@/lib/rates";
import { formatAmountFrom } from "@/lib/money";
import { useIsMobile } from "@/hooks/use-mobile";

const DISPLAY_KEY = "cfo:currency-display:v1";
// Default display currency. This is a Romanian-SME platform — trial balances
// are denominated in RON, source-of-truth values live in RON, and the briefing
// + statements + ratios all originate in RON before any conversion. Defaulting
// to EUR meant every new user saw FX-converted values on first paint with no
// inline signal that conversion was happening (RON × ~0.1906 = EUR), which
// felt like the engine was lying about the trial-balance numbers they
// uploaded. Defaulting to RON makes the dashboard match the source document.
// The currency toggle still lets anyone flip to EUR/USD; their choice
// persists in localStorage (DISPLAY_KEY above), so existing EUR-toggled
// users keep EUR — only first-load / never-toggled users see the new default.
const DEFAULT_DISPLAY: Currency = "RON";

function readDisplayFromStorage(): Currency {
  try {
    const v = localStorage.getItem(DISPLAY_KEY);
    if (v === "RON" || v === "EUR" || v === "USD") return v;
  } catch {
    // ignore
  }
  return DEFAULT_DISPLAY;
}

function writeDisplayToStorage(c: Currency): void {
  try {
    localStorage.setItem(DISPLAY_KEY, c);
  } catch {
    // ignore
  }
}

export interface CurrencyContextValue {
  /** Currency the user is currently viewing in. */
  display: Currency;
  /** Latest FX rates payload (always populated — falls back to bundled). */
  rates: RatesPayload;
  /** Switch display currency (persists to localStorage). */
  setDisplay: (c: Currency) => void;
  /** Force-refresh rates from /api/fx-rates (settings "Refresh now" button). */
  refresh: () => Promise<void>;
  /** True while a refresh is in flight. */
  refreshing: boolean;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  // First paint reads localStorage + bundled-fallback rates synchronously
  // so there's no flash of unstyled (or wrong-currency) content.
  const [display, setDisplayState] = useState<Currency>(() => readDisplayFromStorage());
  const [rates, setRates] = useState<RatesPayload>(() => getInitialRates());
  const [refreshing, setRefreshing] = useState(false);

  // On mount: kick off a background fetch. If the cache is fresh,
  // fetchRates returns it without a network call.
  useEffect(() => {
    let cancelled = false;
    fetchRates().then((payload) => {
      if (!cancelled) setRates(payload);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setDisplay = useCallback((c: Currency) => {
    setDisplayState(c);
    writeDisplayToStorage(c);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const payload = await fetchRates({ forceRefresh: true });
      setRates(payload);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Memoize the context value so consumers only re-render when one of
  // {display, rates, refreshing} actually changes — not on every parent render.
  const value = useMemo<CurrencyContextValue>(
    () => ({ display, rates, setDisplay, refresh, refreshing }),
    [display, rates, setDisplay, refresh, refreshing],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

/** Hook returning a curried formatter for amounts in a given source
 *  currency. Use in P&L / BS / CF table renderers that previously called
 *  formatRON(value) — replace with:
 *    const fmt = useAmountFormatter(statements.currency);
 *    {fmt(value)}                       → converted, no symbol
 *    {fmt(value, {sign: "positive"})}   → forced + prefix
 *    {fmt(value, {paren: true})}        → (1,234.56) for negatives (cash-flow convention)
 *
 *  The returned function is memoized on (display, rates, fromCurrency)
 *  so passing it to memoized child rows doesn't bust memo caches. */
export function useAmountFormatter(fromCurrency: Currency | string) {
  const { display, rates } = useCurrency();
  const isMobile = useIsMobile();
  return useMemo(() => {
    const src = (fromCurrency as Currency) || "RON";
    return (
      value: number | null | undefined,
      opts: { signed?: boolean; sign?: "positive" | "negative"; paren?: boolean; compact?: boolean } = {},
    ) =>
      // Auto-compact on mobile <768px so long Romanian amounts like
      // "10.922.666,19" become "10,9 mil." and fit in 160px BS/PL/CF
      // grid cells without overflow. Caller-explicit `compact` still
      // wins. Added 2026-06-02 alongside the BS/PL/CF CSS mobile grid
      // collapse.
      formatAmountFrom(value, src, display, rates.rates, {
        ...opts,
        compact: opts.compact ?? isMobile,
      });
  }, [fromCurrency, display, rates, isMobile]);
}

/** Read the currency context. Throws (in dev) when used outside provider —
 *  prevents the "silent fallback to wrong currency" class of bug. */
export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) {
    if (import.meta.env.DEV) {
      throw new Error("useCurrency must be used inside <CurrencyProvider>");
    }
    // Production fallback: return a non-reactive default rather than crash.
    return {
      display: DEFAULT_DISPLAY,
      rates: getInitialRates(),
      setDisplay: () => {},
      refresh: async () => {},
      refreshing: false,
    };
  }
  return ctx;
}

/** Convenience: read just the display currency. */
export function useDisplayCurrency(): Currency {
  return useCurrency().display;
}

/** Convenience: read just the rates payload. */
export function useRates(): RatesPayload {
  return useCurrency().rates;
}
