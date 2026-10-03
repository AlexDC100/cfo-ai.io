// Global currency display store — React Context-based.
//
// State:
//   - display: user's chosen currency (RON/EUR/USD), persisted in localStorage
//   - rates: latest FX payload (rates + source + stale flag)
//   - refresh(): force-fetch fresh rates (lib/rates.ts: the fx-rates function,
//     then the engine)
//   - setDisplay(c): change display currency
//
// Persistence:
//   - User choice in localStorage (`cfo:currency-display:v1`)
//   - Rates cached separately in lib/rates.ts (`cfo:fx-rates:v1`)
//
// THE RATES ARE KEPT CURRENT FOR AS LONG AS THE PROVIDER IS MOUNTED.
//   Until 2026-10-03 the rates were fetched once, in a mount-only effect, and
//   nothing asked again: a tab left open — or the mobile shell's WebView,
//   which lives for days — kept the rate of the day it was opened, shown as
//   current (measured: mounted Monday 07:00 with BNR's file of 2 October; 96
//   hours later, after focus, visibilitychange and online events, still that
//   rate, `stale: false`, and not one more request). A reader whose mount
//   fetch failed kept the stale rate until a reload.
//   Now (law: frontend/lib/__tests__/fxOpenTab.test.tsx, gate fx-browser):
//   · WHAT IS SHOWN is derived at read time from what is held — the payload
//     and the moment a source answered it (`ratesAsShown`): past its day a
//     rate is marked stale, whether or not anyone answers.
//   · THE SOURCES ARE ASKED AGAIN whenever no current rate is held: on a
//     timer (`TICK_MS`), when the tab becomes visible or gains focus, when
//     the browser comes back online — one attempt at a time, never from a
//     hidden tab. Inside the held day nothing is asked.
//   · NO REQUEST STORM. The timer, focus and visibility ask at most once per
//     `RETRY_MS` (five minutes — see the constant for why five). `online`
//     may ask once without waiting — a network that came back makes the last
//     failure say nothing about now — and that pass is itself spent for
//     `RETRY_MS`. So, whatever events fire and however fast: never more than
//     TWO attempts (four GETs) in any five minutes, and never more than one
//     without an `online` event.
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
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type Currency,
  type HeldRates,
  type RatesPayload,
  fetchHeldRates,
  getHeldRates,
  getInitialRates,
  ratesAsShown,
  ratesNeedAttempt,
  sameRates,
} from "@/lib/rates";
import { formatAmountFrom, moneyLocaleFor } from "@/lib/money";
import { useActiveLocale } from "@/lib/locale";
import { setPref, usePrefSync } from "@/lib/prefs";
import { useIsMobile } from "@/hooks/use-mobile";

const DISPLAY_KEY = "cfo:currency-display:v1";
/** Key inside `org_prefs.prefs` — see supabase/schema_phase_prefs.sql. */
const PREF_KEY = "currency_display";
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

/** How often an open tab looks at the clock. A look costs no request: it
 *  marks a rate stale once its day has ended and decides whether to ask. */
export const TICK_MS = 60_000;
/** While no current rate is held, the sources are asked at most this often.
 *  WHY FIVE MINUTES. It is the failure cooldown of both sources (the engine's
 *  `_FAILURE_COOLDOWN_SECONDS`, the function's `FAILURE_COOLDOWN_MS`): a
 *  source that could not read BNR does not try again sooner, so asking it
 *  sooner can only be answered the same thing — and one that has just come
 *  back is seen within one window. The cost while BOTH sources stay stale
 *  (two months, in 2026): at most 12 attempts — 24 GETs — per hour per
 *  VISIBLE tab, none from a hidden one. Before this the cost was one attempt
 *  per page load and the tab never healed. */
export const RETRY_MS = 5 * 60_000;

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
  /** Force-refresh the rates (lib/rates.ts `fetchHeldRates({forceRefresh})`). */
  refresh: () => Promise<void>;
  /** True while a refresh is in flight. */
  refreshing: boolean;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  // First paint reads localStorage + bundled-fallback rates synchronously
  // so there's no flash of unstyled (or wrong-currency) content.
  const [display, setDisplayState] = useState<Currency>(() => readDisplayFromStorage());
  // What this tab holds: the payload AND the moment a source answered it.
  // `rates` — what is shown — is derived from it at read time, so a rate
  // stops being "current" when its day ends, not when someone reloads.
  const heldRef = useRef<HeldRates | null>(null);
  if (heldRef.current === null) heldRef.current = getHeldRates();
  const [rates, setRates] = useState<RatesPayload>(() => ratesAsShown(heldRef.current!, Date.now()));
  const [refreshing, setRefreshing] = useState(false);

  /** Hold `next` (when given) and show what is held as it may be shown NOW.
   *  The state object is replaced only when something a reader could see
   *  changed, so a look at the clock re-renders nothing. */
  const show = useCallback((next?: HeldRates) => {
    // A tab never swaps what it holds for something a source answered
    // EARLIER — with localStorage unavailable a failed attempt comes back as
    // "nothing held" (the bundled fallback, answered never), and the rate on
    // screen is still the better figure. It is marked stale by the clock.
    // (Unless what it holds is stamped in the future — a clock set back —
    // where "earlier" means nothing and the answer just received is taken.)
    const now = Date.now();
    const own = heldRef.current!;
    if (next && (next.cached_at >= own.cached_at || own.cached_at > now)) heldRef.current = next;
    const shown = ratesAsShown(heldRef.current!, now);
    setRates((prev) => (sameRates(prev, shown) ? prev : shown));
  }, []);

  // On mount: kick off a background fetch. If the cache is fresh,
  // fetchHeldRates returns it without a network call. Then keep looking at
  // the clock for as long as the provider is mounted (header comment).
  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    let lastAttemptAt: number | null = null; // any attempt
    let lastOnlinePassAt: number | null = null; // an attempt `online` was let through for

    const attempt = () => {
      inFlight = true;
      lastAttemptAt = Date.now();
      fetchHeldRates()
        .then((got) => {
          if (mounted) show(got);
        })
        .finally(() => {
          inFlight = false;
        });
    };

    /** Has RETRY_MS passed since `last`? (Never asked: yes. A `last` in the
     *  future — the clock was set back — says nothing: yes.) */
    const spaced = (last: number | null, now: number) => last === null || now - last >= RETRY_MS || now < last;

    /** Look at the clock. `cameOnline`: the browser just came back online —
     *  the last failure says nothing about now, so this look may ask without
     *  waiting for the spacing, ONCE per RETRY_MS. */
    const look = (cameOnline: boolean) => {
      const now = Date.now();
      show(); // read time: a held rate past its day is marked stale here
      if (inFlight || !ratesNeedAttempt(heldRef.current!, now)) return;
      // A hidden tab shows nothing to anyone: it asks when it is looked at.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!spaced(lastAttemptAt, now)) {
        if (!cameOnline || !spaced(lastOnlinePassAt, now)) return;
        lastOnlinePassAt = now;
      }
      attempt();
    };

    attempt();
    const onTick = () => look(false);
    const onSeen = () => look(false);
    const onOnline = () => look(true);
    const timer = setInterval(onTick, TICK_MS);
    document.addEventListener("visibilitychange", onSeen);
    window.addEventListener("focus", onSeen);
    window.addEventListener("online", onOnline);
    return () => {
      mounted = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onSeen);
      window.removeEventListener("focus", onSeen);
      window.removeEventListener("online", onOnline);
    };
  }, [show]);

  const setDisplay = useCallback((c: Currency) => {
    setDisplayState(c);
    writeDisplayToStorage(c);
    // Company-level, not personal: a RON manufacturer and a EUR property
    // vehicle are different workspaces and should each remember their own
    // reporting currency.
    setPref("org", PREF_KEY, c);
  }, []);

  // Adopt a currency chosen on another device (or by a teammate in this
  // workspace). localStorage still wins first paint; this only fires when the
  // synced value actually differs.
  const adoptDisplay = useCallback((c: Currency) => {
    if (c !== "RON" && c !== "EUR" && c !== "USD") return;
    setDisplayState(c);
    writeDisplayToStorage(c);
  }, []);
  usePrefSync<Currency>("org", PREF_KEY, display, adoptDisplay);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      show(await fetchHeldRates({ forceRefresh: true }));
    } finally {
      setRefreshing(false);
    }
  }, [show]);

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
 *  The returned function is memoized on (display, rates, fromCurrency,
 *  language) so passing it to memoized child rows doesn't bust memo
 *  caches. The digits follow the READER'S LANGUAGE ("1,234,567.89" in
 *  English, "1.234.567,89" in Romanian — lib/money moneyLocaleFor), and a
 *  language switch hands out a new printer. */
export function useAmountFormatter(fromCurrency: Currency | string) {
  const { display, rates } = useCurrency();
  const locale = moneyLocaleFor(useActiveLocale());
  const isMobile = useIsMobile();
  return useMemo(() => {
    const src = (fromCurrency as Currency) || "RON";
    return (
      value: number | null | undefined,
      opts: { signed?: boolean; sign?: "positive" | "negative"; paren?: boolean; compact?: boolean } = {},
    ) =>
      // Auto-compact on mobile <768px so long amounts like
      // "10.922.666,19" become "10,9 mil." and fit in 160px BS/PL/CF
      // grid cells without overflow. Caller-explicit `compact` still
      // wins. Added 2026-06-02 alongside the BS/PL/CF CSS mobile grid
      // collapse.
      formatAmountFrom(value, src, display, rates.rates, {
        ...opts,
        compact: opts.compact ?? isMobile,
        locale,
      });
  }, [fromCurrency, display, rates, isMobile, locale]);
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
