// FIGURE PROVENANCE BY CONCEPT — how a configurable tile learns its origin.
//
// The dashboard's `MetricCard` renders whatever `resolveConceptValue`
// returns: `{ value, format }`, keyed by a concept ("ebitda", "cash",
// "ebitda_margin"…). The resolver reads a metrics snapshot and a map of
// engine-routed overrides, and neither carries a provenance. The origin of
// the headline figures exists exactly once — in `pages/cfo/FinancialStatements`,
// beside the numbers, as `buildHeadlineProvenance` output — and the card is
// three components away from it through props this lane does not own.
//
// So it travels by context instead. The page provides a map of
// concept → { value, provenance }; the card looks its concept up and
// wears the affordance ONLY when the value it is about to paint equals
// the value the provenance was built for, to the cent. A concept the map
// does not name, or a value that differs, renders plain — a derived
// margin the resolver computed is not the figure the page vouched for,
// and the card must not borrow the headline's origin for it.

import { createContext, useContext, type ReactNode } from "react";

import type { AmountProvenance } from "@/components/instrument/Provenance";

export interface FigureProvenanceEntry {
  /** The figure this provenance was built for. The consumer compares
   *  before it claims. */
  value: number;
  provenance: AmountProvenance | null;
}

export type FigureProvenanceMap = Readonly<Record<string, FigureProvenanceEntry | undefined>>;

const FigureProvenanceContext = createContext<FigureProvenanceMap>({});

export function FigureProvenanceProvider({
  value,
  children,
}: {
  value: FigureProvenanceMap;
  children: ReactNode;
}) {
  return (
    <FigureProvenanceContext.Provider value={value}>{children}</FigureProvenanceContext.Provider>
  );
}

const CENT = 0.005;

/**
 * The provenance for `conceptKey`, if the page vouched for it AND the
 * figure about to be painted is the one it vouched for. Null otherwise.
 */
export function useFigureProvenance(
  conceptKey: string,
  value: number | null | undefined,
): AmountProvenance | null {
  const map = useContext(FigureProvenanceContext);
  const entry = map[conceptKey];
  if (!entry || !entry.provenance) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (Math.abs(value - entry.value) > CENT) return null;
  return entry.provenance;
}
