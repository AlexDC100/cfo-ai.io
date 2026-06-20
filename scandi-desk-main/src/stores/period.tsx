// F6.0.1 Phase 1 foundation (2026-06-20) — Period comparison store.
//
// Single source of truth for what's being compared, globally available via
// React Context. Every financial component subscribes here. This is the
// FOUNDATION for variance analysis (F6.0.3) and scenarios (F6.0.5) — the
// dependency-ordered approach means we ship multi-period infrastructure
// first, then variance views layer on top.
//
// Pattern: matches src/stores/currency.tsx + src/stores/learningMode.tsx —
// React Context + localStorage + useMemo'd value. NO new state library
// introduced. F6.0.1 spec called for zustand but this codebase has zero
// zustand dependency; following existing convention keeps the bundle
// lean and the mental model uniform across all stores.
//
// CRITICAL PERSISTENCE DISCIPLINE (spec lock):
//   Only `comparisonMode` is persisted across sessions. The
//   `comparisonDatasetId` is intentionally NOT persisted — it re-resolves
//   from the current dataset set every time the primary dataset changes.
//   Without this guard, a user who uploads a new FY2026 period would still
//   see a comparison against the now-stale FY2024 dataset id in
//   localStorage. The re-resolve-on-hydrate pattern prevents the entire
//   class of "stale comparison" bugs.
//
// Math discipline (enforced downstream in computeDeltas + DeltaBadge):
//   The delta of a ratio is in PERCENTAGE POINTS (pp), NOT percentage.
//   12% → 14% = +2pp, NOT +16.7%. The type system + DeltaBadge format
//   props enforce this so the renderer can't accidentally show the
//   misleading percent-of-percent number.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** Six comparison modes — covers Prior Year (default), Prior Period,
 *  Budget (when Budget-tagged dataset exists), YTD vs YTD prior year,
 *  Same-Quarter prior year, and the "no comparison" single-period view
 *  which preserves the current behavior pre-F6.0.1. */
export type ComparisonMode =
  | "none"
  | "prior_year"
  | "prior_period"
  | "budget"
  | "ytd_vs_ytd_prior"
  | "qoq";

export interface PeriodState {
  /** Primary period — usually the latest available dataset. Owned by the
   *  Datasets store currently; mirrored here so comparison resolution can
   *  re-trigger when the primary changes. Null until first dataset loads. */
  primaryDatasetId: string | null;
  /** User's preferred comparison mode. Persisted across sessions. */
  comparisonMode: ComparisonMode;
  /** Resolved comparison dataset id given the mode + primary. NULL when
   *  mode === "none" OR no matching dataset exists in the current set.
   *  Re-resolved on every primary change; never persisted. */
  comparisonDatasetId: string | null;
}

export interface PeriodActions {
  setPrimary: (datasetId: string | null) => void;
  setComparisonMode: (mode: ComparisonMode) => void;
  /** Manual override — pin a specific dataset as the comparison regardless
   *  of mode. Used by future Variance UI where user picks a specific Budget
   *  scenario. Sets mode to "budget" implicitly when called. */
  setComparisonDataset: (datasetId: string | null) => void;
  reset: () => void;
  /** Derived: true when a comparison is actively in play (mode !== "none"
   *  AND a resolved dataset exists). Components use this to decide whether
   *  to render DeltaBadge alongside their numeric values. */
  hasComparison: () => boolean;
}

export type PeriodContextValue = PeriodState & PeriodActions;

const MODE_KEY = "cfo:period-comparison-mode:v1";
const DEFAULT_MODE: ComparisonMode = "prior_year";

function readModeFromStorage(): ComparisonMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (
      v === "none" ||
      v === "prior_year" ||
      v === "prior_period" ||
      v === "budget" ||
      v === "ytd_vs_ytd_prior" ||
      v === "qoq"
    ) {
      return v;
    }
  } catch {
    // ignore quota / private-mode errors
  }
  return DEFAULT_MODE;
}

function writeModeToStorage(mode: ComparisonMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore
  }
}

const PeriodContext = createContext<PeriodContextValue | null>(null);

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [primaryDatasetId, setPrimaryDatasetId] = useState<string | null>(null);
  const [comparisonMode, setComparisonModeState] = useState<ComparisonMode>(
    () => readModeFromStorage(),
  );
  const [comparisonDatasetId, setComparisonDatasetIdState] = useState<
    string | null
  >(null);

  // Persistence side-effect: write mode preference to localStorage on every
  // change. Dataset id is deliberately NOT persisted (re-resolve discipline).
  useEffect(() => {
    writeModeToStorage(comparisonMode);
  }, [comparisonMode]);

  const setPrimary = useCallback<PeriodActions["setPrimary"]>((datasetId) => {
    setPrimaryDatasetId(datasetId);
    // Comparison dataset re-resolution happens in the consumer — the store
    // doesn't know about the dataset universe, only its identifiers.
    // ConceptContextProvider (future page-wiring phase) reads both stores
    // and resolves the comparison via periodResolution helper. Clearing
    // the stale id here keeps the comparison consistent until that resolver
    // fires.
    setComparisonDatasetIdState(null);
  }, []);

  const setComparisonMode = useCallback<PeriodActions["setComparisonMode"]>(
    (mode) => {
      setComparisonModeState(mode);
      // Clear the resolved id so the next render picks a fresh resolution
      // matching the new mode. The page-wiring layer's resolver does the
      // actual lookup against the dataset universe.
      setComparisonDatasetIdState(null);
    },
    [],
  );

  const setComparisonDataset = useCallback<
    PeriodActions["setComparisonDataset"]
  >((datasetId) => {
    setComparisonDatasetIdState(datasetId);
  }, []);

  const reset = useCallback<PeriodActions["reset"]>(() => {
    setPrimaryDatasetId(null);
    setComparisonModeState(DEFAULT_MODE);
    setComparisonDatasetIdState(null);
  }, []);

  const value = useMemo<PeriodContextValue>(() => {
    const hasComparison = () =>
      comparisonMode !== "none" && comparisonDatasetId !== null;
    return {
      primaryDatasetId,
      comparisonMode,
      comparisonDatasetId,
      setPrimary,
      setComparisonMode,
      setComparisonDataset,
      reset,
      hasComparison,
    };
  }, [
    primaryDatasetId,
    comparisonMode,
    comparisonDatasetId,
    setPrimary,
    setComparisonMode,
    setComparisonDataset,
    reset,
  ]);

  return (
    <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>
  );
}

export function usePeriod(): PeriodContextValue {
  const ctx = useContext(PeriodContext);
  if (!ctx) {
    // Defensive default — when consumers render outside the provider (e.g.
    // public marketing pages that don't mount PeriodProvider), return a
    // no-op shape so the components don't crash. This matches the pattern
    // used by ReportingContextProvider's default value.
    return {
      primaryDatasetId: null,
      comparisonMode: "none",
      comparisonDatasetId: null,
      setPrimary: () => {},
      setComparisonMode: () => {},
      setComparisonDataset: () => {},
      reset: () => {},
      hasComparison: () => false,
    };
  }
  return ctx;
}
