// comparativesView — which comparative columns the statements show, and
// against which prior period. User-controlled, persisted.
//
// Same shape as dashboardView: localStorage is the source of first paint,
// `setPref("org", …)` mirrors the choice to the workspace, `usePrefSync`
// adopts another device's choice, and an `adopting` guard keeps the
// adoption from echoing straight back. Company-scoped on purpose: which
// year you read a business against belongs to the business.
//
// `priorPeriodId: null` means AUTO — the previous fiscal year-end, picked
// by `pickDefaultPrior`. `priorPeriodId: "none"` means the reader turned
// comparatives off for this workspace.
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

import { setPref, usePrefSync } from "@/lib/prefs";

export interface ComparativeColumns {
  prior: boolean;
  delta: boolean;
  deltaPct: boolean;
  share: boolean;
}

export interface ComparativesView {
  priorPeriodId: string | null | "none";
  columns: ComparativeColumns;
}

const KEY = "cfo:comparatives-view:v1";
/** Key inside `org_prefs.prefs` — see supabase/schema_phase_prefs.sql. */
const PREF_KEY = "comparatives_view";

export const DEFAULT_VIEW: ComparativesView = {
  priorPeriodId: null,
  columns: { prior: true, delta: true, deltaPct: true, share: true },
};

function normalize(raw: unknown): ComparativesView {
  if (!raw || typeof raw !== "object") return DEFAULT_VIEW;
  const r = raw as Partial<ComparativesView>;
  const cols = (r.columns ?? {}) as Partial<ComparativeColumns>;
  const prior = r.priorPeriodId;
  return {
    priorPeriodId: prior === "none" ? "none" : typeof prior === "string" && prior ? prior : null,
    columns: {
      prior: cols.prior !== false,
      delta: cols.delta !== false,
      deltaPct: cols.deltaPct !== false,
      share: cols.share !== false,
    },
  };
}

function read(): ComparativesView {
  if (typeof window === "undefined") return DEFAULT_VIEW;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? normalize(JSON.parse(raw)) : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

function write(v: ComparativesView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode — fail soft */
  }
}

interface Store {
  view: ComparativesView;
  setPriorPeriodId: (id: string | null | "none") => void;
  setColumn: (col: keyof ComparativeColumns, on: boolean) => void;
}

const Ctx = createContext<Store | null>(null);

export function ComparativesViewProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<ComparativesView>(() => read());
  const adopting = useRef(false);

  const commit = useCallback((next: ComparativesView) => {
    write(next);
    setViewState(next);
    if (!adopting.current) setPref("org", PREF_KEY, next);
  }, []);

  const setPriorPeriodId = useCallback(
    (id: string | null | "none") => commit({ ...read(), priorPeriodId: id }),
    [commit],
  );
  const setColumn = useCallback(
    (col: keyof ComparativeColumns, on: boolean) => {
      const cur = read();
      commit({ ...cur, columns: { ...cur.columns, [col]: on } });
    },
    [commit],
  );

  const adopt = useCallback((remote: ComparativesView) => {
    adopting.current = true;
    try {
      const next = normalize(remote);
      write(next);
      setViewState(next);
    } finally {
      adopting.current = false;
    }
  }, []);
  usePrefSync<ComparativesView>("org", PREF_KEY, view, adopt);

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === KEY) setViewState(read());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<Store>(
    () => ({ view, setPriorPeriodId, setColumn }),
    [view, setPriorPeriodId, setColumn],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useComparativesView(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) {
    return { view: DEFAULT_VIEW, setPriorPeriodId: () => {}, setColumn: () => {} };
  }
  return ctx;
}
