// comparativesView — which comparative columns the statements show, and
// against which prior period. User-controlled, persisted, ONE CHOICE PER
// COMPANY.
//
// Same shape as dashboardView: localStorage is the source of first paint,
// `setPref("org", …)` mirrors the choice to the company, `usePrefSync`
// adopts another device's choice, and an `adopting` guard keeps the
// adoption from echoing straight back. Company-scoped on purpose: which
// year you read a business against belongs to the business.
//
// THE COMPANY IS IN THE KEY (2026-09-26, the live walkthrough). The choice
// used to live under one browser-wide key, so a prior picked on Scandia's
// dashboard was still "the choice" on EEI's: the dashboard asked the engine
// to compare EEI's period with Scandia's, and the Overview printed the
// engine's refusal with Scandia's raw period id in it. The provider now
// takes the company it holds the choice for (`orgId`), reads and writes
// `cfo:comparatives-view:v1:<orgId>`, starts from the default for a company
// it has no choice for, and only adopts or writes the company preference bag
// of THAT company. The old browser-wide key is never read: nothing says
// which company it was chosen for.
//
// The page still checks every stored choice against the company's own
// periods before it is used (`lib/comparatives.ts`, `comparisonChoiceOf`):
// a stored id that is not one of them is ignored silently.
//
// `priorPeriodId: null` means AUTO — the previous fiscal year-end, picked
// by `pickDefaultPrior`. `priorPeriodId: "none"` means the reader turned
// comparatives off for this company.
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

import { prefsOrgId, setPref, usePrefSync } from "@/lib/prefs";

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

/** One key per company: `${KEY_PREFIX}${orgId}`. */
export const COMPARATIVES_VIEW_KEY_PREFIX = "cfo:comparatives-view:v1:";
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

function storageKey(orgId: string): string {
  return `${COMPARATIVES_VIEW_KEY_PREFIX}${orgId}`;
}

/** The company's stored choice, or the default (no company, none stored,
 *  unreadable storage). */
export function readComparativesView(orgId: string | null): ComparativesView {
  if (!orgId || typeof window === "undefined") return DEFAULT_VIEW;
  try {
    const raw = window.localStorage.getItem(storageKey(orgId));
    return raw ? normalize(JSON.parse(raw)) : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

function write(orgId: string, v: ComparativesView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(orgId), JSON.stringify(v));
  } catch {
    /* private mode — fail soft */
  }
}

interface Store {
  /** The company this choice belongs to (null: no company yet — the default
   *  view, nothing persisted). */
  orgId: string | null;
  view: ComparativesView;
  setPriorPeriodId: (id: string | null | "none") => void;
  setColumn: (col: keyof ComparativeColumns, on: boolean) => void;
}

const Ctx = createContext<Store | null>(null);

export function ComparativesViewProvider({
  orgId,
  children,
}: {
  /** The company open now — the one whose choice this provider holds. */
  orgId: string | null;
  children: ReactNode;
}) {
  const [held, setHeld] = useState<{ orgId: string | null; view: ComparativesView }>(() => ({
    orgId,
    view: readComparativesView(orgId),
  }));
  // A company switch reads THAT company's choice in the same render: the
  // previous company's never reaches a child, not even for one frame.
  const view = held.orgId === orgId ? held.view : readComparativesView(orgId);
  useEffect(() => {
    if (held.orgId !== orgId) setHeld({ orgId, view: readComparativesView(orgId) });
  }, [held.orgId, orgId]);
  const adopting = useRef(false);

  const commit = useCallback(
    (next: ComparativesView) => {
      if (!orgId) return;
      write(orgId, next);
      setHeld({ orgId, view: next });
      // The company preference bag is written only while it is THIS
      // company's (a switch in flight holds the next company's bag).
      if (!adopting.current && prefsOrgId() === orgId) setPref("org", PREF_KEY, next);
    },
    [orgId],
  );

  const setPriorPeriodId = useCallback(
    (id: string | null | "none") => commit({ ...readComparativesView(orgId), priorPeriodId: id }),
    [commit, orgId],
  );
  const setColumn = useCallback(
    (col: keyof ComparativeColumns, on: boolean) => {
      const cur = readComparativesView(orgId);
      commit({ ...cur, columns: { ...cur.columns, [col]: on } });
    },
    [commit, orgId],
  );

  const adopt = useCallback(
    (remote: ComparativesView) => {
      // usePrefSync hands over only this company's bag (the owner below);
      // checked again here, where the value is written.
      if (!orgId || prefsOrgId() !== orgId) return;
      adopting.current = true;
      try {
        const next = normalize(remote);
        write(orgId, next);
        setHeld({ orgId, view: next });
      } finally {
        adopting.current = false;
      }
    },
    [orgId],
  );
  usePrefSync<ComparativesView>("org", PREF_KEY, view, adopt, orgId);

  useEffect(() => {
    if (!orgId) return;
    function onStorage(e: StorageEvent) {
      if (e.key === storageKey(orgId as string)) setHeld({ orgId, view: readComparativesView(orgId) });
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [orgId]);

  const value = useMemo<Store>(
    () => ({ orgId, view, setPriorPeriodId, setColumn }),
    [orgId, view, setPriorPeriodId, setColumn],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useComparativesView(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) {
    return { orgId: null, view: DEFAULT_VIEW, setPriorPeriodId: () => {}, setColumn: () => {} };
  }
  return ctx;
}
