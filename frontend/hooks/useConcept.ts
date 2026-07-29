// F5.0 Phase 1 — Concept lookup hook.
//
// Thin wrapper around lookupConcept + runtime context assembly.
//
// Phase 1: returns the concept and a context that contains the concept's
// own embedded benchmark (when present). Phase 2 will fold in dataset-
// specific sector + period count so interpretation narratives can vary
// per user. Phase 4 will swap embedded benchmarks for per-industry
// lookups via the sector_risk_library.

import { useMemo } from "react";
import {
  lookupConcept,
  type Concept,
  type ConceptContext,
} from "@/lib/learning/concepts";

interface UseConceptResult {
  concept: Concept | undefined;
  context: ConceptContext;
}

/** Resolve a concept by key + assemble its runtime context. Memoized so
 *  consumers passing the result into render-children don't bust render
 *  caches. */
export function useConcept(conceptKey: string): UseConceptResult {
  return useMemo(() => {
    const concept = lookupConcept(conceptKey);
    const context: ConceptContext = concept?.benchmark
      ? { benchmark: concept.benchmark }
      : {};
    return { concept, context };
  }, [conceptKey]);
}
