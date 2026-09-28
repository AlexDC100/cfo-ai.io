// evidenceLines.ts — typed door onto evidenceLines.json: which statement
// lines an evidence link may name, the SERVED path each is read from, the
// ONE reader that prints it, and the buckets whose leaves feed it.
//
// The JSON is a mirror of the engine's comparatives line registry
// (src/engine/comparatives/lines.py). tests/engine/test_evidence_lines.py
// holds every entry to it — path, buckets, constituent lines — and holds
// each name to the attention pack / the command bar, so the account view
// can never name a line differently from the item that opened it.

import data from "./evidenceLines.json";

export interface Bilingual {
  ro: string;
  en: string;
}

export interface EvidenceLineSpec {
  key: string;
  statement: "pl" | "bs";
  reader: "line" | "ebitda" | "net_result";
  field: string;
  /** Classification buckets whose leaves feed the line (empty: derived). */
  buckets: readonly string[];
  /** Lines this one is the engine's sum of (their buckets are `buckets`). */
  fromLines: readonly string[];
  /** Account-code prefixes the served field sums, where it is narrower than
   *  its buckets (the registry's `source_accounts`): the line's feeds are
   *  the buckets' leaves under these prefixes. Empty: every leaf feeds it. */
  sourceAccounts: readonly string[];
  /** A line that IS an account (the net result → 121). */
  accounts: readonly string[];
  /** The statement row that renders a derived line. */
  highlight: string | null;
  name: Bilingual;
}

type Raw = {
  statement: string;
  reader: string;
  field: string;
  buckets: string[];
  from_lines?: string[];
  source_accounts?: string[];
  accounts?: string[];
  highlight?: string;
  name: Bilingual;
};

const RAW = (data as { lines: Record<string, Raw> }).lines;

export const EVIDENCE_LINES: Readonly<Record<string, EvidenceLineSpec>> = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW).map(([key, r]) => [
      key,
      {
        key,
        statement: r.statement === "bs" ? "bs" : "pl",
        reader: r.reader === "ebitda" ? "ebitda" : r.reader === "net_result" ? "net_result" : "line",
        field: r.field,
        buckets: r.buckets ?? [],
        fromLines: r.from_lines ?? [],
        sourceAccounts: r.source_accounts ?? [],
        accounts: r.accounts ?? [],
        highlight: r.highlight ?? null,
        name: r.name,
      } satisfies EvidenceLineSpec,
    ]),
  ),
);

export function evidenceLine(key: string | null | undefined): EvidenceLineSpec | null {
  return key ? EVIDENCE_LINES[key] ?? null : null;
}
