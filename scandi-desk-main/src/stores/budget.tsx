// F6.0.1b (2026-06-21) — Budget comparison store (hook, device-local).
//
// Holds the user's UPLOADED budget/last-year comparison dataset for the
// variance report, persisted per device in localStorage. Hook-based (no
// provider) since only the variance page tree consumes it. The demo seed for
// the test workspace is NOT stored here — it's derived from live actuals in
// the page, so a real upload always wins.

import { useCallback, useEffect, useState } from "react";
import type { ComparisonDataset } from "@/lib/comparison/types";

const KEY = "cfo:budget-comparison:v1";

function read(): ComparisonDataset | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ComparisonDataset;
    if (parsed && typeof parsed === "object" && parsed.budget) return parsed;
    return null;
  } catch {
    return null;
  }
}

function write(ds: ComparisonDataset | null): void {
  if (typeof window === "undefined") return;
  try {
    if (ds) window.localStorage.setItem(KEY, JSON.stringify(ds));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* private mode — fail soft */
  }
}

export interface BudgetComparisonStore {
  /** The uploaded dataset, or null if none uploaded on this device. */
  uploaded: ComparisonDataset | null;
  /** Persist a freshly parsed upload. */
  save: (ds: ComparisonDataset) => void;
  /** Remove the upload (falls back to demo / empty state). */
  clear: () => void;
}

export function useBudgetComparison(): BudgetComparisonStore {
  const [uploaded, setUploaded] = useState<ComparisonDataset | null>(() => read());

  // Cross-tab sync — pick up an upload made in another tab.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === KEY) setUploaded(read());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const save = useCallback((ds: ComparisonDataset) => {
    write(ds);
    setUploaded(ds);
  }, []);

  const clear = useCallback(() => {
    write(null);
    setUploaded(null);
  }, []);

  return { uploaded, save, clear };
}
