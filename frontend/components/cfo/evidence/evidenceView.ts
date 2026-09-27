// evidenceView.ts — what the account view SHOWS, as plain data, from the
// served period body only (design C4). Pure: EvidenceDrawer renders it, the
// gates read it.
//
// THE ACCOUNT RULE (owner spec, "opens the account with provenance"):
//   · the leaves are the served line items whose code IS the requested code
//     or starts with it — a synthetic code ("4111") shows its analytic
//     leaves ("411101 …"); a digit-bearing code never fuzzes to a neighbour;
//   · a TOTAL is printed only when the engine serves one for exactly that
//     code: a canonical balance-sheet row whose account codes are that one
//     code (account 121 → "Current year profit"). Leaves are NEVER summed
//     here — a sum the engine did not serve is a second authority;
//   · the balance-sheet row the account rolls into is named with its own
//     served amount and its own codes, labelled as that row, not as the
//     account's balance;
//   · nothing matches → the account is absent from this book, said in
//     words. Never 0.
//
// THE LINE RULE: a statement line (a comparatives line key) prints its
// served figure through the SAME reader the command bar prints it with
// (servedLine / servedEbitda / servedNetResult — one reader per moving
// figure), then the leaves that feed it: the line items of the buckets the
// engine's line registry declares for it (evidenceLines.json, held to
// src/engine/comparatives/lines.py). A finding that cited accounts for the
// line lists THOSE accounts instead. A derived line (EBITDA, the operating
// result) has no accounts of its own and says so.

import type { PeriodLineItem } from "@/lib/activePeriod";
import {
  EVIDENCE_ACCOUNT_PARAM,
  EVIDENCE_FINDING_PARAM,
  EVIDENCE_LINE_PARAM,
  EVIDENCE_MEASURE_PARAM,
} from "@/lib/evidence/evidenceLink";
import { readInsights, type InsightMeasure } from "@/lib/insights";
import { evidenceLine, type EvidenceLineSpec } from "@/lib/evidence/evidenceLines";
import {
  servedEbitda,
  servedLine,
  servedNetResult,
  type ServedFigure,
} from "@/components/instrument/shell/cmdbar/cmdbarSources";

export interface EvidenceRequest {
  /** Requested account codes, in the order the link named them. */
  accounts: string[];
  /** A comparatives line key (`pl.revenue`), or null. */
  line: string | null;
  /** A finding (statements.insights id) and the measure it heads with. */
  finding: { id: string; measure: string } | null;
}

/** The request a URL carries, or null when it carries none. */
export function readEvidenceRequest(params: URLSearchParams): EvidenceRequest | null {
  const accounts: string[] = [];
  for (const raw of params.getAll(EVIDENCE_ACCOUNT_PARAM)) {
    const c = raw.trim();
    if (c && !accounts.includes(c)) accounts.push(c);
  }
  const lineRaw = params.get(EVIDENCE_LINE_PARAM);
  const line = lineRaw && lineRaw.trim() ? lineRaw.trim() : null;
  const fid = (params.get(EVIDENCE_FINDING_PARAM) ?? "").trim();
  const fmeasure = (params.get(EVIDENCE_MEASURE_PARAM) ?? "").trim();
  const finding = fid && fmeasure ? { id: fid, measure: fmeasure } : null;
  if (accounts.length === 0 && !line && !finding) return null;
  return { accounts, line, finding };
}

export type EvidenceBody = {
  statements?: unknown;
  assembled_metrics?: Record<string, unknown> | null;
  line_items?: PeriodLineItem[] | null;
} | null;

export interface EvidenceLeaf {
  code: string;
  name: string;
  statement: "BS" | "PL";
  bucket: string;
  /** The served amount, or null when the item carries none. */
  amount: number | null;
  /** The leaf IS a requested code (not only under one). */
  exact: boolean;
}

export interface EvidenceServedTotal {
  amount: number;
  label: string;
  /** Where it was read: `canonical_bs.rows[id=…]`. */
  source: string;
  /** The row's own leaf ids, as served (a leaf the line items do not list
   *  — account 121 — is still named). */
  leafIds: string[];
}

export interface EvidenceRollup {
  id: string;
  label: string;
  codes: string[];
  amount: number | null;
  source: string;
}

export interface EvidenceAccountBlock {
  code: string;
  /** The exact leaf's name, else the served total's label, else null. */
  name: string | null;
  statement: "BS" | "PL" | null;
  leaves: EvidenceLeaf[];
  total: EvidenceServedTotal | null;
  /** The balance-sheet rows this code rolls into (or that roll up under
   *  it), each with its own served amount and codes. */
  rollups: EvidenceRollup[];
  absent: boolean;
}

export interface EvidenceLineBlock {
  spec: EvidenceLineSpec;
  figure: ServedFigure;
  /** Leaves by the line's buckets — empty when the line is derived, or when
   *  a finding's cited accounts are listed instead. */
  leaves: EvidenceLeaf[];
  /** No buckets and no accounts of its own. */
  derived: boolean;
}

/** A finding's own measure, read from the served statements.insights —
 *  the SAME object the "Ce contează acum" item printed. */
export interface EvidenceFindingBlock {
  id: string;
  measure: InsightMeasure | null;
  /** The block's currency (statements.insights.currency). */
  currency: string;
  /** Where it was read. */
  source: string;
}

export interface EvidenceModel {
  request: EvidenceRequest;
  /** The finding the link named, when it named one: the view's headline. */
  finding: EvidenceFindingBlock | null;
  line: EvidenceLineBlock | null;
  /** A `line` the link named that no declared line is. */
  unknownLine: string | null;
  accounts: EvidenceAccountBlock[];
  /** The account blocks are the accounts a finding CITED for the line. */
  cited: boolean;
}

// ── served-body readers (no arithmetic) ────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function lineItems(body: EvidenceBody): PeriodLineItem[] {
  const items = body?.line_items;
  return Array.isArray(items)
    ? items.filter((li) => li && typeof li.ro_account_code === "string" && li.statement !== "IGNORED")
    : [];
}

interface CanonicalRowLite {
  id: string;
  label: string;
  amount: number | null;
  codes: string[];
  leafIds: string[];
}

function canonicalRows(body: EvidenceBody): CanonicalRowLite[] {
  const st = body?.statements;
  const cbs = isObj(st) ? st.canonical_bs : null;
  const rows = isObj(cbs) && Array.isArray(cbs.rows) ? cbs.rows : [];
  const out: CanonicalRowLite[] = [];
  for (const r of rows) {
    if (!isObj(r) || typeof r.id !== "string") continue;
    out.push({
      id: r.id,
      label: typeof r.label === "string" ? r.label : r.id,
      amount: num(r.amount),
      codes: Array.isArray(r.account_codes) ? r.account_codes.filter((c): c is string => typeof c === "string") : [],
      leafIds: Array.isArray(r.leaf_ids) ? r.leaf_ids.filter((c): c is string => typeof c === "string") : [],
    });
  }
  return out;
}

function toLeaf(li: PeriodLineItem, exact: boolean): EvidenceLeaf {
  return {
    code: li.ro_account_code,
    name: li.ro_account_name ?? "",
    statement: li.statement === "PL" ? "PL" : "BS",
    bucket: li.bucket,
    amount: num(li.amount),
    exact,
  };
}

const byCode = (a: EvidenceLeaf, b: EvidenceLeaf) =>
  a.code.localeCompare(b.code, "en", { numeric: true }) || a.bucket.localeCompare(b.bucket);

/** One requested code: its served leaves, a served total if the engine
 *  serves one for exactly this code, the rows it rolls into. */
export function accountBlock(body: EvidenceBody, code: string): EvidenceAccountBlock {
  const items = lineItems(body);
  const leaves = items
    .filter((li) => li.ro_account_code === code || li.ro_account_code.startsWith(code))
    .map((li) => toLeaf(li, li.ro_account_code === code))
    .sort(byCode);
  const rows = canonicalRows(body);
  const own = rows.find((r) => r.codes.length === 1 && r.codes[0] === code && r.amount !== null) ?? null;
  const total: EvidenceServedTotal | null = own
    ? { amount: own.amount as number, label: own.label, source: `canonical_bs.rows[id=${own.id}]`, leafIds: own.leafIds }
    : null;
  const rollups: EvidenceRollup[] = rows
    .filter((r) => r !== own && r.codes.some((c) => code.startsWith(c) || c.startsWith(code)))
    .map((r) => ({ id: r.id, label: r.label, codes: r.codes, amount: r.amount, source: `canonical_bs.rows[id=${r.id}]` }));
  const exactLeaf = leaves.find((l) => l.exact) ?? null;
  return {
    code,
    name: exactLeaf?.name || total?.label || null,
    statement: exactLeaf?.statement ?? (leaves[0]?.statement ?? (total ? "BS" : null)),
    leaves,
    total,
    rollups,
    absent: leaves.length === 0 && total === null,
  };
}

/** Where a served figure was read, as the READER names it — a declared
 *  label (`evidence.source.<key>`, RO/EN), never the engine's path. The
 *  path itself ("statements.insights.insights[id=…]", "assembled_pl.ebitda",
 *  "canonical_bs.rows[id=…]") stays in a developer attribute
 *  (`data-source`) and is printed nowhere (review round 1 of stage CB-I). */
export type EvidenceSourceKey = "pl" | "bs" | "cf" | "metrics" | "findings" | "served";

export function sourceLabelKey(source: string): EvidenceSourceKey {
  if (source.startsWith("assembled_pl.")) return "pl";
  if (source.startsWith("assembled_bs.") || source.startsWith("canonical_bs.")) return "bs";
  if (source.startsWith("assembled_cf.")) return "cf";
  if (source.startsWith("assembled_metrics.")) return "metrics";
  if (source.startsWith("statements.insights")) return "findings";
  return "served";
}

/** The line's served figure, through the ONE reader for it. */
export function lineFigure(body: EvidenceBody, spec: EvidenceLineSpec): ServedFigure {
  const b = body as never;
  if (spec.reader === "ebitda") return servedEbitda(b);
  if (spec.reader === "net_result") return servedNetResult(b);
  return servedLine(b, spec.statement, spec.field);
}

/** The finding's measure, as served — or a block with `measure: null`
 *  when the period serves no such finding / measure (said in words). */
export function findingBlock(body: EvidenceBody, id: string, measureKey: string): EvidenceFindingBlock {
  const block = readInsights(body?.statements ?? null);
  const ins = block?.insights.find((i) => i.id === id) ?? null;
  const measure = ins?.measures.find((m) => m.key === measureKey) ?? null;
  return {
    id,
    measure,
    currency: block?.currency ?? "",
    source: `statements.insights.insights[id=${id}].measures[key=${measureKey}]`,
  };
}

export function buildEvidenceModel(body: EvidenceBody, request: EvidenceRequest): EvidenceModel {
  const spec = evidenceLine(request.line);
  const cited = (spec !== null || request.finding !== null) && request.accounts.length > 0;
  let line: EvidenceLineBlock | null = null;
  let codes = request.accounts;
  if (spec) {
    const leaves = cited || spec.buckets.length === 0
      ? []
      : lineItems(body)
          .filter((li) => spec.buckets.includes(li.bucket))
          .map((li) => toLeaf(li, false))
          .sort(byCode);
    if (!cited && spec.accounts.length > 0) codes = [...spec.accounts];
    line = {
      spec,
      figure: lineFigure(body, spec),
      leaves,
      derived: spec.buckets.length === 0 && spec.accounts.length === 0,
    };
  }
  return {
    request,
    finding: request.finding ? findingBlock(body, request.finding.id, request.finding.measure) : null,
    line,
    unknownLine: request.line && !spec ? request.line : null,
    accounts: codes.map((c) => accountBlock(body, c)),
    cited,
  };
}
