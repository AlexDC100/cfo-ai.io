// industrySignal.ts — the reader for `GET /api/period/{id}`'s
// `industry_signal` block.
//
// THE BLOCK IS COMPUTED ONCE, ENGINE-SIDE. `src/engine/industry/
// structural_signal.py` reads the account mix, ranks the candidate
// families with their evidence, compares the reading with
// `organizations.industry_key`, and emits ONE verdict. This file does not
// re-derive any of that — a second spelling of the comparison is exactly
// how a banner ends up saying one thing while the block that hides the
// sector content does another.
//
// What the FE decides here: nothing about the industry. Only how to
// present the block, and — via `blocksSectorContent` — which of the
// report's sections are allowed to render.

/** One scored observation about the account mix, with its accounts. */
export interface IndustryMarker {
  key: string;
  family: string;
  weight: number;
  /** Human-readable groups the numerator was summed over. */
  reads: string[];
  accounts: Array<{ code: string; amount: number }>;
  amount: number;
  basis: string;
  basis_amount: number;
  basis_source: string;
  test: string;
  /** False when the basis (revenue / assets) is not measurable at all —
   *  a marker that could not be evaluated, NOT one that failed. */
  available: boolean;
  fired: boolean;
  share: number | null;
  statement: string;
}

export interface IndustryCandidate {
  family: string;
  display: string;
  score: number;
  points: number;
  available_weight: number;
  max_weight: number;
  markers: IndustryMarker[];
}

export type IndustryAgreement = "agree" | "disagree" | "unspecified" | "unverifiable";

export interface IndustrySignal {
  schema_version: string;
  verdict: "decided" | "undetermined";
  family: string | null;
  display: string | null;
  score: number;
  margin: number;
  candidates: IndustryCandidate[];
  thresholds: {
    min_score: number;
    min_margin: number;
    min_available_weight: number;
  };
  undetermined_because: string[];
  cannot_resolve: string;
  agreement: IndustryAgreement;
  block_sector_content: boolean;
  reason: string;
  workspace: {
    industry_key: string | null;
    display: string | null;
    claims_families: string[];
    catalog_note: string | null;
    in_catalog: boolean;
  };
}

/** Narrow the served value. A payload without the block (an older
 *  period response, or an engine that failed to read the mix) yields
 *  null — the report then shows no banner and blocks nothing, which is
 *  the behaviour that existed before this check. */
export function readIndustrySignal(value: unknown): IndustrySignal | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<IndustrySignal>;
  if (typeof v.agreement !== "string") return null;
  if (typeof v.verdict !== "string") return null;
  return v as IndustrySignal;
}

/** THE one authority the report asks before rendering sector-calibrated
 *  content. Never re-derived from `agreement` at a call site. */
export function blocksSectorContent(signal: IndustrySignal | null): boolean {
  return signal?.block_sector_content === true;
}

/** The strongest reading, for the banner's evidence list. */
export function leadingCandidate(signal: IndustrySignal | null): IndustryCandidate | null {
  if (!signal || signal.candidates.length === 0) return null;
  return signal.candidates[0];
}

/** Only the markers that actually fired — the evidence a reader checks.
 *  A marker that did not fire is not evidence FOR the reading and is
 *  deliberately not listed as if it were. */
export function firedMarkers(candidate: IndustryCandidate | null): IndustryMarker[] {
  if (!candidate) return [];
  return candidate.markers.filter((m) => m.fired);
}
