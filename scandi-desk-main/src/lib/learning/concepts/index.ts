// F5.0 Phase 1 — Concept library barrel + lookup.
//
// Phase 1 reads from the SEED_CONCEPTS map pre-banked in seed.ts (5
// concepts: ebitda, ebitda_margin, revenue, net_income, gross_margin).
// Phase 4 will expand to 50-80 by adding category files (profitability.ts,
// liquidity.ts, etc.) and merging them into the registry below.
//
// Lock #11 anchor: every consumer (LearnableNumber, QuickExplainPopover,
// the future /learn route) resolves concepts through this barrel — never
// imports SEED_CONCEPTS directly. That way Phase 4's merge happens here
// in one place and call sites stay unchanged.

import type { Concept } from "./_schema";
import { SEED_CONCEPTS } from "./seed";
import { STATEMENT_CONCEPTS } from "./statements";
import { ANALYTICS_CONCEPTS } from "./analytics";
import { PUBLIC_COMPANY_CONCEPTS } from "./publicCompany";
import { RECOMMENDATIONS_CONCEPTS } from "./recommendations";
import { PRODUCTS_CONCEPTS } from "./products";

const PUBLIC_BY_KEY: Record<string, Concept> = Object.fromEntries(
  PUBLIC_COMPANY_CONCEPTS.map((c) => [c.key, c]),
);
const RECOMMENDATIONS_BY_KEY: Record<string, Concept> = Object.fromEntries(
  RECOMMENDATIONS_CONCEPTS.map((c) => [c.key, c]),
);
const PRODUCTS_BY_KEY: Record<string, Concept> = Object.fromEntries(
  PRODUCTS_CONCEPTS.map((c) => [c.key, c]),
);

/** Master registry. Merged from per-pack files; Phase 4 will split further
 *  by category but the lookup API stays unchanged. */
export const CONCEPTS_BY_KEY: Readonly<Record<string, Concept>> = {
  ...SEED_CONCEPTS,
  ...STATEMENT_CONCEPTS,
  ...ANALYTICS_CONCEPTS,
  ...PUBLIC_BY_KEY,
  ...RECOMMENDATIONS_BY_KEY,
  ...PRODUCTS_BY_KEY,
};

/** Lookup. Returns undefined for unregistered keys — callers MUST handle
 *  the undefined case (typically: render Layer 1 only, no popover). The
 *  graceful fallback prevents a broken popover from breaking the whole
 *  page when a developer references a concept that hasn't been seeded yet. */
export function lookupConcept(key: string): Concept | undefined {
  return CONCEPTS_BY_KEY[key];
}

/** All concepts in a category. Phase 5 `/learn` route will use this for
 *  the category-browser landing page. */
export function conceptsByCategory(category: string): Concept[] {
  return Object.values(CONCEPTS_BY_KEY).filter((c) => c.category === category);
}

// Re-export shape so consumers can `import { Concept } from "@/lib/learning/concepts"`.
export type {
  Concept,
  ConceptCategory,
  ConceptBenchmark,
  ConceptContext,
  Sentiment,
  LocalizedString,
} from "./_schema";
