// F6.1 (2026-06-21) — Dashboard view mode store (Snapshot ↔ Trend).
//
// A tiny Context store holding whether the configurable dashboard renders its
// metric cards as a single-period SNAPSHOT (the F6.0.4 default) or as a
// multi-year TREND (sparkline + CAGR badge per card). Persisted per device in
// localStorage so the choice sticks across navigation. Provider wraps the
// dashboard region; the Snapshot/Trend toggle and the cards both read it.
//
// Mirrors the lightweight Context+useState+localStorage convention used by the
// other FE stores (NO zustand). The Trend toggle is only meaningful when the
// active period carries ≥2 years of history — the toggle itself is gated by
// the caller (series.available), this store just holds the preference.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { setPref, usePrefSync } from "@/lib/prefs";

export type DashboardView = "snapshot" | "trend";

const KEY = "cfo:dashboard-view:v1";
/** Key inside `org_prefs.prefs` — see supabase/schema_phase_prefs.sql. */
const PREF_KEY = "dashboard_view";

function read(): DashboardView {
  if (typeof window === "undefined") return "snapshot";
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === "trend" ? "trend" : "snapshot";
  } catch {
    return "snapshot";
  }
}

function write(v: DashboardView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, v);
  } catch {
    /* private mode — fail soft */
  }
}

interface DashboardViewStore {
  view: DashboardView;
  setView: (v: DashboardView) => void;
}

const Ctx = createContext<DashboardViewStore | null>(null);

export function DashboardViewProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<DashboardView>(() => read());

  const setView = useCallback((v: DashboardView) => {
    write(v);
    setViewState(v);
    // Company-level: whether you read this business as a snapshot or a trend
    // depends on the business (and how many periods it has), not on you.
    setPref("org", PREF_KEY, v);
  }, []);

  const adopt = useCallback((v: DashboardView) => {
    if (v !== "snapshot" && v !== "trend") return;
    write(v);
    setViewState(v);
  }, []);
  usePrefSync<DashboardView>("org", PREF_KEY, view, adopt);

  // Cross-tab sync — pick up a toggle made in another tab.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === KEY) setViewState(read());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<DashboardViewStore>(() => ({ view, setView }), [view, setView]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDashboardView(): DashboardViewStore {
  const ctx = useContext(Ctx);
  // Outside a provider (e.g. an isolated card render), default to snapshot so
  // the dashboard never crashes — it just won't offer the Trend toggle.
  if (!ctx) return { view: "snapshot", setView: () => {} };
  return ctx;
}
