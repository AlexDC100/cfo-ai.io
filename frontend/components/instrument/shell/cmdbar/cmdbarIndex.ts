// cmdbarIndex.ts — the command bar's index and its search, built ONLY from
// payloads already in the query cache (design C2): the served period body,
// the comparatives document for the same-length prior, the sector-benchmark
// document, the company list and each company's years. A keystroke reads
// this index and nothing else — no fetch, no model.
//
// FIVE GROUPS, in this order, always:
//   Răspuns   a served figure with its context (value, Δ vs prior with the
//             engine's change_kind, its share of turnover, vs sector)
//   Cont      an account by code or name, over the served line items
//   Pagină    every statement tab, ratios, benchmark, report, … and any
//             company × year
//   Acțiune   upload, compare, export, switch company, add a period
//   Întreabă  CFO AI — always last; it is the only row that spends, and it
//             spends in the chat, not here
//
// PURE. `buildCmdbarIndex` tokenises once per data change; `searchCmdbar`
// is the per-keystroke function and touches no I/O.

import terms from "./cmdbarTerms.json";
import { accountNameTokens, accountQueryTokens, bestScore, codeKey, termPhrases, tokensOf } from "./cmdbarSearch";
import { ratioLabelForKey, type RatioTableRow } from "@/lib/ratioTable";
import type { PeriodLineItem } from "@/lib/activePeriod";
import { ratioTableRows } from "./cmdbarSources";

export type CmdbarGroup = "answer" | "account" | "page" | "action" | "ask";

/** The fixed group order. Întreabă is last, always. */
export const GROUP_ORDER: readonly CmdbarGroup[] = ["answer", "account", "page", "action", "ask"];

/** How many rows each group shows. A budget, not a preference: the panel
 *  fits these above the composer at 1440 and 390 without scrolling. */
export const GROUP_CAP: Readonly<Record<Exclude<CmdbarGroup, "ask">, number>> = {
  answer: 3,
  account: 3,
  page: 3,
  action: 3,
};

export interface AnswerDef {
  id: string;
  line: string;
  reader: "line" | "ebitda" | "net_result";
  statement?: "pl" | "bs";
  field?: string;
  tab: string;
  margin?: string;
  ratio?: string;
  sector?: string;
  inventoryDays?: boolean;
  terms: string[];
}

export const ANSWERS: readonly AnswerDef[] = terms.answers as AnswerDef[];
export const RATIO_ALIASES: Readonly<Record<string, string[]>> = terms.ratioAliases;
export const ACCOUNT_METRICS: Readonly<Record<string, string>> = terms.accountMetrics;

/** The ratio_table row that is an account's key metric: the LONGEST
 *  declared prefix of the code wins ("5121" → 512 → cash_ratio). */
export function accountMetricKey(code: string): string | null {
  let best: string | null = null;
  for (const prefix of Object.keys(ACCOUNT_METRICS)) {
    if (code.startsWith(prefix) && (best === null || prefix.length > best.length)) best = prefix;
  }
  return best === null ? null : ACCOUNT_METRICS[best];
}

// ── entries ─────────────────────────────────────────────────────────────

export type EntryRef =
  | { kind: "statement"; answer: AnswerDef }
  | { kind: "ratio"; key: string }
  | { kind: "account"; item: PeriodLineItem }
  | { kind: "page"; id: string; label: string; href: string }
  | { kind: "action"; id: string; label: string };

export interface CmdbarEntry {
  id: string;
  group: Exclude<CmdbarGroup, "ask">;
  /** Tokenised terms; a query matches when every token meets one phrase. */
  phrases: string[][];
  /** Declared order — the tie-break after the score. */
  order: number;
  ref: EntryRef;
}

export interface PageDef {
  id: string;
  label: string;
  href: string;
  /** More words that find it (both languages). */
  terms?: string[];
}

export interface ActionDef {
  id: string;
  label: string;
  terms?: string[];
}

export interface CmdbarIndexInput {
  /** The served period body — null while it loads or when none is open. */
  body: { statements?: unknown; assembled_metrics?: Record<string, unknown> | null; line_items?: PeriodLineItem[] } | null;
  pages: readonly PageDef[];
  actions: readonly ActionDef[];
}

export interface CmdbarIndex {
  entries: CmdbarEntry[];
  /** The ratio-table rows the answers read (never metrics[]). */
  ratios: Map<string, RatioTableRow>;
}

/** Every label a ratio row answers to: its label in BOTH languages (the
 *  Ratios tab's own words), its key, and the declared aliases. */
function ratioTerms(key: string): string[] {
  const out = [key.replace(/_/g, " ")];
  for (const lang of ["en", "ro"] as const) {
    const l = ratioLabelForKey(key, lang);
    if (l) out.push(l);
  }
  return out.concat(RATIO_ALIASES[key] ?? []);
}

export function buildCmdbarIndex(input: CmdbarIndexInput): CmdbarIndex {
  const entries: CmdbarEntry[] = [];
  let order = 0;
  const ratios = ratioTableRows(input.body as never);
  if (input.body) {
    for (const a of ANSWERS) {
      entries.push({ id: `answer:${a.id}`, group: "answer", phrases: termPhrases(a.terms), order: order++,
                     ref: { kind: "statement", answer: a } });
    }
    for (const key of ratios.keys()) {
      entries.push({ id: `ratio:${key}`, group: "answer", phrases: termPhrases(ratioTerms(key)), order: order++,
                     ref: { kind: "ratio", key } });
    }
    const items = Array.isArray(input.body.line_items) ? input.body.line_items : [];
    const sorted = [...items]
      .filter((li) => li && typeof li.ro_account_code === "string" && li.statement !== "IGNORED")
      .sort((a, b) => a.ro_account_code.localeCompare(b.ro_account_code));
    for (const item of sorted) {
      // The code is ONE token (separators removed) and the name's words
      // carry no digit token: a typed code meets only the START of a whole
      // code (cmdbarSearch accountQueryTokens), never an inner segment
      // ("401" ≠ 167.401) nor a number inside the name.
      const phrases = [[codeKey(item.ro_account_code)], accountNameTokens(item.ro_account_name ?? "")]
        .filter((p) => p.length > 0 && p[0] !== "");
      entries.push({ id: `account:${item.ro_account_code}:${item.bucket}`, group: "account", phrases,
                     order: order++, ref: { kind: "account", item } });
    }
  }
  for (const p of input.pages) {
    entries.push({ id: `page:${p.id}`, group: "page", phrases: termPhrases([p.label, ...(p.terms ?? [])]),
                   order: order++, ref: { kind: "page", id: p.id, label: p.label, href: p.href } });
  }
  for (const a of input.actions) {
    entries.push({ id: `action:${a.id}`, group: "action", phrases: termPhrases([a.label, ...(a.terms ?? [])]),
                   order: order++, ref: { kind: "action", id: a.id, label: a.label } });
  }
  return { entries, ratios };
}

// ── search ──────────────────────────────────────────────────────────────

export interface CmdbarHit {
  entry: CmdbarEntry;
  score: number;
}

export interface CmdbarResults {
  query: string;
  groups: { group: Exclude<CmdbarGroup, "ask">; hits: CmdbarHit[]; more: number }[];
  /** Întreabă CFO AI — present for every non-empty query, always last. */
  ask: { query: string } | null;
}

/** An answer entry names the same figure as another: the statement answer
 *  for inventory and the dio ratio are one claim, shown once. */
const SAME_FIGURE: Readonly<Record<string, string>> = {
  "ratio:dio": "answer:inventory",
  "ratio:dso": "answer:receivables",
  "ratio:dpo": "answer:payables",
};

export function searchCmdbar(index: CmdbarIndex, query: string): CmdbarResults {
  const q = query.trim();
  const toks = tokensOf(q);
  // Accounts read the query their own way: a word with a digit is a whole
  // code prefix, never split on its dots (cmdbarSearch accountQueryTokens).
  const accountToks = accountQueryTokens(q);
  const groups: CmdbarResults["groups"] = [];
  if (toks.length === 0) return { query: q, groups, ask: null };
  const byGroup = new Map<string, CmdbarHit[]>();
  for (const entry of index.entries) {
    const score = bestScore(entry.ref.kind === "account" ? accountToks : toks, entry.phrases);
    if (score === null) continue;
    const list = byGroup.get(entry.group) ?? [];
    list.push({ entry, score });
    byGroup.set(entry.group, list);
  }
  for (const g of GROUP_ORDER) {
    if (g === "ask") continue;
    const hits = (byGroup.get(g) ?? []).sort((a, b) => b.score - a.score || a.entry.order - b.entry.order);
    let kept = hits;
    if (g === "answer") {
      const ids = new Set(hits.map((h) => h.entry.id));
      kept = hits.filter((h) => !(SAME_FIGURE[h.entry.id] && ids.has(SAME_FIGURE[h.entry.id])));
    }
    if (kept.length === 0) continue;
    const cap = GROUP_CAP[g];
    groups.push({ group: g, hits: kept.slice(0, cap), more: Math.max(0, kept.length - cap) });
  }
  return { query: q, groups, ask: { query: q } };
}

/** The rows in keyboard order: every group's hits, then the ask row. */
export function flatRows(results: CmdbarResults): Array<CmdbarHit | { ask: string }> {
  const out: Array<CmdbarHit | { ask: string }> = [];
  for (const g of results.groups) out.push(...g.hits);
  if (results.ask) out.push({ ask: results.ask.query });
  return out;
}
