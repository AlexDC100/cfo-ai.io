// THE CAPSULE — TIER 0, the answer that arrives before the model
// (Part A, tier 2 of 3).
//
// A large share of what people actually type at a CFO surface is a
// LOOKUP wearing a question mark: "total assets", "cât e cifra de
// afaceri", "how much cash do we have", "is it balanced". None of those
// need a language model. They need a map.
//
// `resolveTier0` is that map's front door. It is pure, synchronous, and
// costs zero network: given the folded question and a built
// `FactIndex`, it either returns a resolved answer with provenance, or
// returns null and gets out of the way so Tier 1 can run.
//
// ── The shapes it claims ──────────────────────────────────────────────
//
//   FACT     one metric, one period — "total assets", "EBITDA margin";
//            also a bare ACCOUNT CODE — "what is sitting in 461"
//   COMPARE  one or more metrics across periods — "what changed vs
//            December", "revenue vs last year", "the revenue trend"
//   META     a property of the workspace rather than of the business —
//            "how many periods", "is it balanced", "where does the
//            imbalance sit", "what findings fired", "what period is
//            this", and DEFINITIONS out of the shipped glossary
//
// The published `kind` stays three-valued; definitions and refusals ride
// on "meta" with a note key, so another lane's exhaustive switch over
// `Tier0Kind` never has to grow a case.
//
// ── The three it refuses to claim ─────────────────────────────────────
//
// T1  ANYTHING THAT ASKS FOR AN INTERPRETATION. "why is cash down",
//     "should we refinance", "what drove inventory" — a lookup cannot
//     answer those and must not pretend to. Those return null, which is
//     the routing decision "this one is worth a model call".
//     "What does EBITDA mean" is NOT one of them: a definition is a
//     lookup in reviewed copy this app already ships, so it is answered
//     here for free rather than billed to a model.
// T2  ANYTHING WITH LEFTOVER MEANING. A metric term inside a longer
//     phrase only claims the question when everything ELSE in it is
//     filler. "cash" claims "how much cash do we have"; it does not
//     claim "cash conversion cycle by product line".
// T3  ANYTHING THE DATA CANNOT SUPPORT. A recognised question whose
//     fact is absent, or a compare across periods that are unlabelled,
//     in different currencies or belonging to different entities,
//     returns an HONEST REFUSAL — never a fabricated zero and never a
//     silent fall-through that lets the model invent it instead. The
//     refusal vocabulary mirrors `_capsule_tools`' own tool gaps, and
//     like them it never carries a number.
//
// Everything user-visible here is an i18n KEY. This module has no
// strings bundle of its own by design — it stays pure and renderable in
// a worker or a benchmark. See the cross-lane note at the bottom.

import {
  factFor,
  lookupFacts,
  matchFactKeys,
  standingContextFacts,
  METRIC_TERMS,
  FACT_PERIOD_COUNT,
  FACT_FINDING_COUNT,
  type FactIndex,
  type FactIndexPeriod,
  type FactRef,
} from "./capsuleFactIndex";
import { foldQuery } from "./capsuleRouter";
import { GLOSSARY } from "./glossary";
import {
  mark,
  record,
  LAT_CAPSULE_OPEN,
  LAT_SPECULATIVE,
} from "./capsuleLatency";

// ══════════════════════════════════════════════════════════════════════
// THE PUBLISHED CONTRACT
// ══════════════════════════════════════════════════════════════════════

export type Tier0Kind = "fact" | "compare" | "meta";

/** One metric's movement between two periods. Additive to the published
 *  minimum — `deltaPct` below mirrors `deltas[0].deltaPct` whenever
 *  exactly one metric was compared. */
export interface Tier0Delta {
  factKey: string;
  /** The baseline period's fact. */
  from: FactRef;
  /** The active period's fact. */
  to: FactRef;
  /** Absolute movement in the fact's own unit. */
  delta: number;
  /** Percent change from `from` to `to`. Undefined when the baseline is
   *  0 — a percentage against nothing is not infinity, it is
   *  unanswerable. */
  deltaPct?: number;
}

export type Tier0Answer = {
  kind: Tier0Kind;
  facts: FactRef[];
  /** Percent change, when exactly one metric was compared. */
  deltaPct?: number;
  /** i18n KEY, never rendered copy. `capsuleTier0.note.*`. */
  note?: string;

  // ── additive ────────────────────────────────────────────────────────
  /** Interpolation params for `note`. Never contains a figure — a
   *  number reaches the DOM only through the money path. */
  noteParams?: Record<string, string>;
  /** Present on kind "compare". */
  deltas?: readonly Tier0Delta[];
  /** Which metric names the question resolved to, in order. */
  factKeys?: readonly string[];
  /** True when this is an honest refusal rather than an answer (T3).
   *  `facts` is empty and `note` names the reason. */
  refused?: boolean;
};

/** null means NOT a Tier-0 question — hand it to the model (T1/T2). */
export function resolveTier0(q: string, index: FactIndex): Tier0Answer | null {
  if (!index || !index.periods || index.periods.length === 0) return null;
  const folded = foldQuery(q ?? "");
  if (!folded) return null;

  // DEFINE runs BEFORE the interpretation gate, because "what does X
  // mean" is a LOOKUP — in a shipped, reviewed glossary, with no model
  // and no numbers. Routing it to the model would pay for a sentence
  // this app already wrote (`lib/glossary.ts`, gate M2).
  const define = resolveDefine(folded, index);
  if (define) return define;

  // T1 — an interpretation request is never a lookup, even when it names
  // a metric. Checked before the fact branches so "why is cash down" can
  // never be claimed by the "cash" branch.
  if (hasAny(folded, INTERPRETATION_TRIGGERS)) return null;

  const meta = resolveMeta(folded, index);
  if (meta) return meta;

  const account = resolveAccount(folded, index);
  if (account) return account;

  const compare = resolveCompare(folded, index);
  if (compare) return compare;

  return resolveFact(folded, index);
}

// ══════════════════════════════════════════════════════════════════════
// Vocabulary (data, not branches)
// ══════════════════════════════════════════════════════════════════════

/** Anything here means the question wants a JUDGEMENT, not a figure.
 *  EN + RO, folded. */
export const INTERPRETATION_TRIGGERS: readonly string[] = Object.freeze([
  "why", "de ce", "explain", "explica", "explicati",
  "reason", "motiv", "cauza", "because", "pentru ca",
  "should", "ar trebui", "recommend", "recomanda", "recomandare", "advice",
  "sfat", "risk", "risc", "riscuri",
  "forecast", "predict", "prognoza", "estimate", "estimeaza",
  "what if", "ce ar fi", "scenario", "scenariu", "simulate", "simuleaza",
  "mean", "means", "meaning", "inseamna", "semnifica",
  "interpret", "assess", "evalueaza", "opinion", "parere",
  "improve", "imbunatati", "fix", "repara", "optimize", "optimizeaza",
  "worry", "ingrijoreaza", "healthy", "sanatos", "good", "bad",
  "how do", "how can", "cum pot", "cum sa",
]);

/** Words that carry no meaning of their own INSIDE a lookup (T2). Used
 *  by the leftover test, where "what is the total revenue" must reduce
 *  to `revenue` with "total" forgiven. */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "our", "my", "your", "their", "its",
  "is", "are", "was", "were", "be", "been",
  "do", "does", "did", "have", "has", "had", "got",
  "we", "i", "us", "you", "it", "this", "that", "there",
  "of", "for", "in", "on", "at", "to", "and", "with",
  "now", "today", "currently", "please", "value", "figure", "number",
  "amount", "right", "much", "many", "how", "what", "whats",
  "total", "totals",
  // Words that only ever POINT at a figure: "what is sitting in account
  // 461" is the account 461 lookup with three signposts in front of it.
  "sitting", "account", "accounts", "balance", "line", "row",
  "cont", "contul", "cod", "codul", "soldul", "sold", "stam", "stau",
  // RO. "cifra" is deliberately ABSENT — it opens "cifra de afaceri",
  // and stripping it would turn the commonest Romanian revenue question
  // into an unrecognised fragment.
  "ce", "care", "cat", "cata", "cate", "cati",
  "este", "e", "sunt", "era", "au", "avem", "am", "ai", "are",
  "noastra", "noastre", "nostru", "nostri", "mea", "mele",
  "un", "o", "al", "ale", "la", "pe", "si", "cu", "din",
  "acum", "azi", "prezent", "valoarea", "suma",
  "arata", "spune", "mi", "da",
  "totalul", "totala", "totale",
]);

/** The subset stripped from the EDGES of a query. Narrower than
 *  `FILLER_WORDS` on purpose: "total" is forgivable in the middle of a
 *  phrase but stripping it off the front would rewrite "total assets"
 *  before the exact-term lookup ever sees it. */
const EDGE_FILLER: ReadonlySet<string> = new Set(
  Array.from(FILLER_WORDS).filter(
    (w) => ["total", "totals", "totalul", "totala", "totale"].indexOf(w) < 0,
  ),
);

/** Leading question openers, longest first so "what is the" strips
 *  before "what is". None of them may END on a word that also opens a
 *  metric name — "what is the total" would eat half of "total assets". */
const OPENERS: readonly string[] = Object.freeze([
  "what is the value of", "what is the", "what is",
  "whats the", "whats", "what are the", "what are",
  "how much is the", "how much is", "how much", "how many",
  "tell me the", "tell me", "show me the", "show me",
  "give me the", "give me", "can you show me", "can you tell me",
  "care este valoarea", "care este", "care e",
  "cum stam cu", "cum sta", "cum stau",
  "cat este", "cat e", "cat de mult", "care sunt", "care ii",
  "spune mi", "arata mi", "da mi", "vreau sa stiu",
]);

/** Compare shapes, EN + RO. */
const COMPARE_TRIGGERS: readonly string[] = Object.freeze([
  " vs ", " versus ", " fata de ", " compared to ", " comparativ cu ",
  "compare", "compara", "comparatie",
  "changed", "change", "s a schimbat", "schimbat", "schimbari",
  "evolutie", "evolutia", "variatie", "variation", "movement",
  "since", "fata de perioada", "delta",
  // A trend across the loaded periods is a compare with more than two
  // points; the guards (labelled, same currency, same entity) are
  // identical, so it routes here rather than to a branch of its own.
  "trend", "over time", "in timp", "istoric", "history",
]);

/** "the other period", without naming it. */
const PRIOR_PERIOD_WORDS: readonly string[] = Object.freeze([
  "last", "previous", "prior", "before", "last month", "last year",
  "anterior", "anterioara", "precedenta", "precedent", "trecuta",
  "luna trecuta", "anul trecut", "perioada anterioara",
]);

/** Metrics reported when a compare names no metric of its own. */
export const HEADLINE_COMPARE_METRICS: readonly string[] = Object.freeze([
  "revenue", "ebitda", "net_result", "total_assets", "cash",
]);

// ── Note keys ─────────────────────────────────────────────────────────
// The surface lane registers these under `capsuleTier0.note.*`.

export const NOTE_BALANCED = "capsuleTier0.note.balanced";
export const NOTE_NOT_BALANCED = "capsuleTier0.note.notBalanced";
export const NOTE_ACTIVE_PERIOD = "capsuleTier0.note.activePeriod";
export const NOTE_CURRENCY = "capsuleTier0.note.currency";
export const NOTE_ABSENT = "capsuleTier0.note.absent";
export const NOTE_SINGLE_PERIOD = "capsuleTier0.note.singlePeriod";
export const NOTE_UNLABELLED_PERIOD = "capsuleTier0.note.unlabelledPeriod";
export const NOTE_CURRENCY_MISMATCH = "capsuleTier0.note.currencyMismatch";
export const NOTE_ENTITY_MISMATCH = "capsuleTier0.note.entityMismatch";
export const NOTE_NO_BASELINE = "capsuleTier0.note.noBaseline";
export const NOTE_DEFINITION = "capsuleTier0.note.definition";
export const NOTE_FINDINGS = "capsuleTier0.note.findings";
export const NOTE_IMBALANCE = "capsuleTier0.note.imbalance";
export const NOTE_NO_BREAKDOWN = "capsuleTier0.note.noBreakdown";

export const TIER0_NOTE_KEYS: readonly string[] = Object.freeze([
  NOTE_BALANCED, NOTE_NOT_BALANCED, NOTE_ACTIVE_PERIOD, NOTE_CURRENCY,
  NOTE_ABSENT, NOTE_SINGLE_PERIOD, NOTE_UNLABELLED_PERIOD,
  NOTE_CURRENCY_MISMATCH, NOTE_ENTITY_MISMATCH, NOTE_NO_BASELINE,
  NOTE_DEFINITION, NOTE_FINDINGS, NOTE_IMBALANCE, NOTE_NO_BREAKDOWN,
]);

// ══════════════════════════════════════════════════════════════════════
// META
// ══════════════════════════════════════════════════════════════════════

const META_PERIOD_COUNT: readonly string[] = Object.freeze([
  "how many periods", "how many period", "number of periods", "period count",
  "cate perioade", "numar de perioade", "cate perioade avem",
]);

const META_BALANCED: readonly string[] = Object.freeze([
  "is it balanced", "is this balanced", "is the balance sheet balanced",
  "does it balance", "does the balance sheet balance", "is bs balanced",
  "balance sheet balanced", "are we balanced",
  "este echilibrat", "e echilibrat", "bilantul este echilibrat",
  "bilantul e echilibrat", "este in echilibru", "se echilibreaza",
  "e echilibrata", "este echilibrata",
]);

const META_ACTIVE_PERIOD: readonly string[] = Object.freeze([
  "what period is this", "which period", "what period am i on",
  "what period is loaded", "current period",
  "ce perioada", "care perioada", "perioada curenta", "ce perioada este",
]);

const META_CURRENCY: readonly string[] = Object.freeze([
  "what currency", "which currency", "reporting currency",
  "ce moneda", "ce valuta", "in ce moneda", "moneda de raportare",
]);

/** "where does the imbalance sit" is the same question as "is it
 *  balanced" with a follow-up attached. The engine already computed the
 *  answer — the served DIAGNOSIS codes — so it is a lookup, not an
 *  investigation. Only the CODES travel; the diagnosis `detail` strings
 *  carry figures and a figure reaches the DOM through the money path. */
const META_IMBALANCE: readonly string[] = Object.freeze([
  "where does the imbalance sit", "where is the imbalance",
  "which side", "on which side", "imbalance", "the drift",
  "unde este diferenta", "unde e diferenta", "dezechilibru",
  "pe ce parte",
]);

const META_FINDINGS: readonly string[] = Object.freeze([
  "what findings", "which findings", "findings fired", "any findings",
  "show findings", "how many findings",
  "ce constatari", "cate constatari", "ce probleme",
]);

/** Questions asking for a per-COUNTERPARTY or per-PRODUCT split.
 *
 *  A trial balance carries the trade-receivables TOTAL and no customer
 *  list; the served statements carry no product dimension at all. So the
 *  honest answer is a refusal that names what IS held — and the refusal
 *  belongs at Tier 0, not at Tier 1, because the model is working from
 *  the same facts. Sending it upstairs buys a hedge or an invention. */
const META_NO_BREAKDOWN: readonly {
  phrases: readonly string[]; concept: string; held: string;
}[] = Object.freeze([
  {
    concept: "customers",
    held: "bs.row.ar_trade_gross",
    phrases: [
      "biggest customers", "largest customers", "top customers",
      "who are our customers", "by customer", "per customer",
      "customer concentration", "customer breakdown",
      "cei mai mari clienti", "cine sunt clientii", "top clienti",
      "pe client", "concentrare clienti",
    ],
  },
  {
    concept: "suppliers",
    held: "bs.row.ap_trade",
    phrases: [
      "biggest suppliers", "largest suppliers", "top suppliers",
      "by supplier", "per supplier", "supplier breakdown",
      "cei mai mari furnizori", "top furnizori", "pe furnizor",
    ],
  },
  {
    concept: "products",
    held: "revenue",
    phrases: [
      "by product", "per product", "by sku", "per sku", "by segment",
      "product breakdown", "pe produs", "pe segment",
    ],
  },
]);

function resolveMeta(folded: string, index: FactIndex): Tier0Answer | null {
  const active = index.periods[0];

  for (const rule of META_NO_BREAKDOWN) {
    if (!hasAnyPhrase(folded, rule.phrases)) continue;
    return refusal(NOTE_NO_BREAKDOWN, {
      concept: rule.concept,
      held: rule.held,
      period: active.periodLabel,
    });
  }

  if (hasAnyPhrase(folded, META_PERIOD_COUNT)) {
    const fact = factFor(index, FACT_PERIOD_COUNT);
    if (!fact) return refusal(NOTE_ABSENT, { metric: FACT_PERIOD_COUNT });
    return { kind: "meta", facts: [fact], factKeys: [FACT_PERIOD_COUNT] };
  }

  if (hasAnyPhrase(folded, META_BALANCED)) {
    const fact = factFor(index, "difference");
    if (!fact) return refusal(NOTE_ABSENT, { metric: "difference" });
    // The verdict is the ENGINE's served status, never a local
    // comparison against a tolerance this module invented.
    const balanced = active.bsStatus === "BALANCED" || active.bsStatus === "RECONCILED";
    return {
      kind: "meta",
      facts: [fact],
      factKeys: ["difference"],
      note: balanced ? NOTE_BALANCED : NOTE_NOT_BALANCED,
      noteParams: {
        status: String(active.bsStatus ?? "UNVERIFIED"),
        period: active.periodLabel,
      },
    };
  }

  if (hasAnyPhrase(folded, META_IMBALANCE)) {
    const fact = factFor(index, "difference");
    if (!fact) return refusal(NOTE_ABSENT, { metric: "difference" });
    return {
      kind: "meta",
      facts: [fact],
      factKeys: ["difference"],
      note: NOTE_IMBALANCE,
      noteParams: {
        status: String(active.bsStatus ?? "UNVERIFIED"),
        period: active.periodLabel,
        diagnosis: active.diagnosisCodes.join(", "),
      },
    };
  }

  if (hasAnyPhrase(folded, META_FINDINGS)) {
    const fact = factFor(index, FACT_FINDING_COUNT);
    // No findings ARRAY supplied is "not loaded", not "none fired".
    if (!fact) return refusal(NOTE_ABSENT, { metric: FACT_FINDING_COUNT });
    return {
      kind: "meta",
      facts: [fact],
      factKeys: [FACT_FINDING_COUNT],
      note: NOTE_FINDINGS,
      noteParams: { period: active.periodLabel },
    };
  }

  if (hasAnyPhrase(folded, META_ACTIVE_PERIOD)) {
    return {
      kind: "meta",
      facts: [],
      note: NOTE_ACTIVE_PERIOD,
      noteParams: { period: active.periodLabel, entity: active.entity },
    };
  }

  if (hasAnyPhrase(folded, META_CURRENCY)) {
    return {
      kind: "meta",
      facts: [],
      note: NOTE_CURRENCY,
      noteParams: { currency: active.currency, period: active.periodLabel },
    };
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════
// DEFINE — a reviewed sentence, not a generated one
// ══════════════════════════════════════════════════════════════════════

/** Phrases that ask what a term MEANS. Deliberately narrower than the
 *  interpretation triggers they overlap with: "explain" is absent,
 *  because "explain the 461 balance" wants this company's 461, not the
 *  dictionary entry for a receivable. */
const DEFINE_TRIGGERS: readonly string[] = Object.freeze([
  "what does", "mean", "means", "meaning", "define", "definition",
  "inseamna", "semnifica", "ce reprezinta", "definitie",
]);

/** Folded glossary label → glossary id. Built once from `GLOSSARY`
 *  itself, so a new entry is reachable the moment it is written. */
const GLOSSARY_TERMS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [id, entry] of Object.entries(GLOSSARY)) {
    for (const label of [entry.term.en, entry.term.ro, id.replace(/_/g, " ")]) {
      const folded = foldQuery(label);
      if (folded && !map.has(folded)) map.set(folded, id);
    }
  }
  return map;
})();

/** Metric names whose glossary entry lives under a different id. */
const GLOSSARY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  net_result: "net_profit",
  bank_debt_total: "leverage",
  cash_from_operating: "cash_flow",
  "bs.row.ar_trade_gross": "receivables",
  "bs.row.ap_trade": "payables",
});

function resolveDefine(folded: string, index: FactIndex): Tier0Answer | null {
  if (!hasAny(folded, DEFINE_TRIGGERS)) return null;

  // Strip the trigger words, then apply the SAME leftover discipline as
  // a plain lookup (T2). That is what keeps the long production-log
  // question — "Tell me more about Operating Revenue (413.73M RON)… what
  // does this value mean in context, what's typical for my industry" —
  // out of here: it says "mean", but it is asking for a comparison, and
  // the leftovers say so.
  let residue = stripOpeners(folded);
  for (const trigger of DEFINE_TRIGGERS) residue = removePhrase(residue, trigger);
  residue = stripOpeners(residue);
  if (!residue) return null;

  const direct = GLOSSARY_TERMS.get(residue);
  const viaMetric = direct ? null : claimMetric(residue, index);
  const glossaryId =
    direct ??
    (viaMetric
      ? (GLOSSARY[viaMetric] ? viaMetric : GLOSSARY_ALIASES[viaMetric] ?? null)
      : null);
  if (!glossaryId || !GLOSSARY[glossaryId]) return null;

  return {
    kind: "meta",
    facts: [],
    note: NOTE_DEFINITION,
    // The surface renders the reviewed copy through `<Term>` /
    // `plainFor(id, lang)`; this layer names the entry, never the prose,
    // so the RO/EN split stays with the glossary that owns it.
    noteParams: { glossaryId },
  };
}

// ══════════════════════════════════════════════════════════════════════
// ACCOUNT — "what is sitting in 461"
// ══════════════════════════════════════════════════════════════════════

/** Anchored, exactly like `capsuleRouter`'s account-code entity rule: a
 *  bare digit run only reads as an account when it is the WHOLE residue.
 *  Unanchored, the "2025" in "Dec 2025 — where does the imbalance sit"
 *  would become account 2025 and answer a question nobody asked. */
const ACCOUNT_RE = /^(?:cont|contul|account|acc|cod)?\s*([0-9]{3,8})$/;

function resolveAccount(folded: string, index: FactIndex): Tier0Answer | null {
  const match = ACCOUNT_RE.exec(stripOpeners(folded));
  if (!match) return null;
  const code = match[1];

  const active = index.periods[0];
  const hits = index.facts.filter(
    (fact) =>
      fact.periodId === active.periodId &&
      (fact.accountCodes ?? []).some(
        (c) => c === code || c.startsWith(`${code}.`) || c.startsWith(code),
      ),
  );
  if (hits.length === 0) {
    // The code is a well-formed question this period cannot answer. Say
    // so instantly instead of paying a model to discover the same thing.
    return refusal(NOTE_ABSENT, { account: code, period: active.periodLabel });
  }
  return {
    kind: "fact",
    facts: hits,
    factKeys: hits.map((f) => f.factKey),
  };
}

// ══════════════════════════════════════════════════════════════════════
// FACT
// ══════════════════════════════════════════════════════════════════════

function resolveFact(folded: string, index: FactIndex): Tier0Answer | null {
  const factKey = claimMetric(folded, index);
  if (!factKey) return null;               // T2 — leftover meaning
  const fact = factFor(index, factKey);
  if (!fact) return refusal(NOTE_ABSENT, { metric: factKey });  // T3
  return { kind: "fact", facts: [fact], factKeys: [factKey] };
}

/** The single metric a question is ENTIRELY about, or null.
 *
 *  A term claims the question only when every word the term does not
 *  cover is filler (T2). Longest covering term wins, so "current ratio"
 *  beats "current assets" on "what is the current ratio". */
export function claimMetric(folded: string, index: FactIndex): string | null {
  const residue = stripOpeners(folded);
  if (!residue) return null;

  const exact = index.termIndex.get(residue);
  if (exact && exact.length) return exact[0];

  let best: { key: string; termLength: number } | null = null;
  for (const [term, keys] of index.termIndex) {
    if (!containsPhrase(residue, term)) continue;
    const leftover = removePhrase(residue, term)
      .split(" ")
      .filter((w) => w && !FILLER_WORDS.has(w));
    if (leftover.length > 0) continue;     // T2
    const candidate = { key: keys[0], termLength: term.length };
    if (!best || candidate.termLength > best.termLength ||
        (candidate.termLength === best.termLength &&
         candidate.key.localeCompare(best.key) < 0)) {
      best = candidate;
    }
  }
  return best ? best.key : null;
}

// ══════════════════════════════════════════════════════════════════════
// COMPARE
// ══════════════════════════════════════════════════════════════════════

function resolveCompare(folded: string, index: FactIndex): Tier0Answer | null {
  if (!hasAny(folded, COMPARE_TRIGGERS)) return null;

  const active = index.periods[0];
  if (index.periods.length < 2) return refusal(NOTE_SINGLE_PERIOD, {});

  const resolved = resolveBaseline(folded, index);
  if (!resolved) return refusal(NOTE_NO_BASELINE, {});
  const baseline = resolved.period;

  // A question that NAMES a period the workspace does not hold must not
  // be answered about a different one. "compare December and November
  // revenue" against a workspace holding FY 2025 and FY 2024 is not a
  // near-miss to be smoothed over — silently substituting the loaded
  // pair produces a delta that reads exactly like the one asked for.
  const named = namedPeriodTokens(folded);
  if (named.length > 0 && !resolved.matchedByLabel) {
    return refusal(NOTE_NO_BASELINE, {
      asked: named.join(", "),
      loaded: index.periods.map((p) => p.periodLabel).filter(Boolean).join(", "),
    });
  }

  // The same three guards `_capsule_tools.compare_periods` applies, for
  // the same reasons: an unlabelled period cannot tell the reader which
  // months it covers, and a cross-currency or cross-entity delta reads
  // exactly like a real one.
  if (!active.periodLabel || !baseline.periodLabel) {
    return refusal(NOTE_UNLABELLED_PERIOD, {
      period: (!active.periodLabel ? active.periodId : baseline.periodId),
    });
  }
  if (active.currency !== baseline.currency) {
    return refusal(NOTE_CURRENCY_MISMATCH, {
      a: active.currency, b: baseline.currency,
    });
  }
  if (active.entity && baseline.entity && active.entity !== baseline.entity) {
    return refusal(NOTE_ENTITY_MISMATCH, {
      a: active.entity, b: baseline.entity,
    });
  }

  const wanted = metricsNamedIn(folded, index);
  const keys = wanted.length ? wanted : HEADLINE_COMPARE_METRICS;

  const deltas: Tier0Delta[] = [];
  const facts: FactRef[] = [];
  for (const key of keys) {
    const from = factFor(index, key, baseline.periodId);
    const to = factFor(index, key, active.periodId);
    if (!from || !to) continue;            // T3, per metric
    if (from.unit !== to.unit) continue;   // never subtract across units
    const delta = to.value - from.value;
    const entry: Tier0Delta = { factKey: key, from, to, delta };
    if (from.value !== 0) entry.deltaPct = (delta / Math.abs(from.value)) * 100;
    deltas.push(entry);
    facts.push(from, to);
  }

  if (deltas.length === 0) {
    return refusal(NOTE_ABSENT, { metric: keys.join(", ") });
  }

  const answer: Tier0Answer = {
    kind: "compare",
    facts,
    deltas,
    factKeys: deltas.map((d) => d.factKey),
  };
  if (deltas.length === 1 && deltas[0].deltaPct !== undefined) {
    answer.deltaPct = deltas[0].deltaPct;
  }
  return answer;
}

interface BaselineMatch {
  period: FactIndexPeriod;
  /** True when the question NAMED this period (whole label or a
   *  distinctive word of it), false when it was inferred. */
  matchedByLabel: boolean;
}

/** The period a compare measures FROM: one named in the question, else
 *  "the previous one" when the question says so, else — with exactly two
 *  periods loaded — the other one. Three periods and no name is
 *  ambiguous, and ambiguity refuses. */
function resolveBaseline(folded: string, index: FactIndex): BaselineMatch | null {
  const others = index.periods.slice(1);
  for (const period of others) {
    const label = foldQuery(period.periodLabel);
    if (label && containsPhrase(folded, label)) {
      return { period, matchedByLabel: true };
    }
  }
  // A label the user typed in part — "december" for "December 2024".
  for (const period of others) {
    const label = foldQuery(period.periodLabel);
    if (!label) continue;
    for (const word of label.split(" ")) {
      if (word.length >= 4 && containsPhrase(folded, word)) {
        return { period, matchedByLabel: true };
      }
    }
  }
  if (hasAny(folded, PRIOR_PERIOD_WORDS) && others.length > 0) {
    return { period: others[0], matchedByLabel: false };
  }
  return others.length === 1
    ? { period: others[0], matchedByLabel: false }
    : null;
}

/** Month names (EN + RO) and four-digit years. A question containing one
 *  of these is naming a specific period, so an inferred baseline is not
 *  an acceptable substitute. */
const MONTH_TOKENS: readonly string[] = Object.freeze([
  "january", "february", "march", "april", "june", "july",
  "august", "september", "october", "november", "december",
  "ianuarie", "februarie", "martie", "aprilie", "iunie", "iulie",
  "septembrie", "octombrie", "noiembrie", "decembrie",
  // "may" (EN modal) and "mai" (RO "more", as in "cel mai mare") are
  // deliberately ABSENT. Both are common function words, and a false
  // "the user named a period" reading turns an answerable compare into a
  // refusal. A May period is still reached by its year or full label.
]);

const YEAR_RE = /\b(?:19|20)\d{2}\b/g;

export function namedPeriodTokens(folded: string): string[] {
  const out: string[] = [];
  for (const month of MONTH_TOKENS) {
    if (containsPhrase(folded, month) && out.indexOf(month) < 0) out.push(month);
  }
  const years = folded.match(YEAR_RE);
  if (years) for (const year of years) if (out.indexOf(year) < 0) out.push(year);
  return out;
}

/** Metric names the question explicitly asks about — for a compare,
 *  where leftover words ("vs December") are expected and therefore do
 *  not disqualify a match the way T2 does for a plain lookup. */
export function metricsNamedIn(folded: string, index: FactIndex): string[] {
  const hits: { key: string; termLength: number }[] = [];
  const seen = new Set<string>();
  for (const [term, keys] of index.termIndex) {
    if (term.length < 3) continue;
    if (!containsPhrase(folded, term)) continue;
    for (const key of keys) {
      if (seen.has(key)) continue;
      // A statement-line key is too fine-grained to headline a compare
      // unless the user named the account itself.
      seen.add(key);
      hits.push({ key, termLength: term.length });
    }
  }
  hits.sort((a, b) => b.termLength - a.termLength || a.key.localeCompare(b.key));
  return hits.map((h) => h.key);
}

// ══════════════════════════════════════════════════════════════════════
// Speculative retrieval (the Tier-1 hook)
// ══════════════════════════════════════════════════════════════════════

/** Long enough that a fast typist does not fire one per keystroke,
 *  short enough that the facts are in hand before Enter lands. */
export const SPECULATION_DEBOUNCE_MS = 250;

export interface SpeculativeResult {
  query: string;
  /** Metric names the partial query implies. */
  terms: readonly string[];
  /** Their facts, already resolved — this is what "pre-resolve" means. */
  facts: readonly FactRef[];
  /** The Tier-0 answer, when the partial query already is one. */
  tier0: Tier0Answer | null;
}

/** Metric names a PARTIAL query implies, most specific first. Looser
 *  than `claimMetric` on purpose: speculation may over-fetch (it costs a
 *  map read), but `resolveTier0` still decides what is answerable. */
export function speculativeTerms(q: string, index: FactIndex): string[] {
  const folded = foldQuery(q ?? "");
  if (!folded || folded.length < 2) return [];
  const direct = matchFactKeys(index, stripOpeners(folded) || folded);
  if (direct.length) return direct;
  return metricsNamedIn(folded, index);
}

export interface SpeculativeResolverOptions {
  index: FactIndex;
  debounceMs?: number;
  onResolve?: (result: SpeculativeResult) => void;
  /** Test seam — defaults to setTimeout/clearTimeout. */
  scheduler?: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
}

export interface SpeculativeResolver {
  /** Feed a keystroke. Debounced. */
  input(q: string): void;
  /** Resolve immediately (Enter landed — do not wait out the debounce). */
  flush(q?: string): SpeculativeResult | null;
  cancel(): void;
  latest(): SpeculativeResult | null;
}

export function createSpeculativeResolver(
  options: SpeculativeResolverOptions,
): SpeculativeResolver {
  const debounceMs = options.debounceMs ?? SPECULATION_DEBOUNCE_MS;
  const scheduler = options.scheduler ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let handle: unknown = null;
  let pending = "";
  let last: SpeculativeResult | null = null;

  const run = (q: string): SpeculativeResult => {
    const started = nowMs();
    const terms = speculativeTerms(q, options.index);
    const result: SpeculativeResult = {
      query: q,
      terms,
      facts: lookupFacts(options.index, terms),
      tier0: resolveTier0(q, options.index),
    };
    record(LAT_SPECULATIVE, nowMs() - started);
    last = result;
    if (options.onResolve) options.onResolve(result);
    return result;
  };

  return {
    input(q) {
      pending = q ?? "";
      if (handle !== null) scheduler.clear(handle);
      handle = scheduler.set(() => {
        handle = null;
        run(pending);
      }, debounceMs);
    },
    flush(q) {
      if (handle !== null) {
        scheduler.clear(handle);
        handle = null;
      }
      const query = q ?? pending;
      if (!query) return last;
      return run(query);
    },
    cancel() {
      if (handle !== null) scheduler.clear(handle);
      handle = null;
    },
    latest() {
      return last;
    },
  };
}

/** Called when the Capsule OPENS. Stamps the latency origin and returns
 *  the standing period context the Tier-1 prompt is cached against — as
 *  FACTS, so no figure ever originates inside a prompt string. */
export function prewarmCapsule(index: FactIndex): FactRef[] {
  mark(LAT_CAPSULE_OPEN);
  return standingContextFacts(index);
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
}

function refusal(note: string, params: Record<string, string>): Tier0Answer {
  return { kind: "meta", facts: [], note, noteParams: params, refused: true };
}

/** Word-boundary containment on a folded string. */
function containsPhrase(folded: string, phrase: string): boolean {
  if (!phrase) return false;
  return ` ${folded} `.indexOf(` ${phrase} `) >= 0;
}

function removePhrase(folded: string, phrase: string): string {
  return ` ${folded} `.replace(` ${phrase} `, " ").trim();
}

function hasAnyPhrase(folded: string, phrases: readonly string[]): boolean {
  for (const phrase of phrases) if (containsPhrase(folded, phrase)) return true;
  return false;
}

/** Substring containment — the trigger lists deliberately include
 *  padded forms (" vs ") where a boundary matters and bare stems
 *  ("compara") where RO inflection does not deserve a morphology table. */
function hasAny(folded: string, needles: readonly string[]): boolean {
  const padded = ` ${folded} `;
  for (const needle of needles) {
    if (needle.startsWith(" ") || needle.endsWith(" ")) {
      if (padded.indexOf(needle) >= 0) return true;
    } else if (containsPhrase(folded, needle) || padded.indexOf(` ${needle}`) >= 0) {
      return true;
    }
  }
  return false;
}

/** Strip a leading question opener and any leading filler left behind. */
export function stripOpeners(folded: string): string {
  let out = folded;
  for (const opener of OPENERS) {
    if (out === opener) return "";
    if (out.startsWith(`${opener} `)) {
      out = out.slice(opener.length + 1);
      break;
    }
  }
  const words = out.split(" ").filter(Boolean);
  while (words.length && EDGE_FILLER.has(words[0])) words.shift();
  while (words.length && EDGE_FILLER.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/** Every metric term the index knows, for the fixture gate and for a
 *  surface that wants to show what Tier 0 can answer. */
export function knownMetricTerms(): readonly string[] {
  const out: string[] = [];
  for (const terms of Object.values(METRIC_TERMS)) out.push(...terms);
  return Object.freeze(out.slice().sort());
}

// ── CROSS-LANE NOTE ───────────────────────────────────────────────────
//
// The surface lane must register a strings bundle (EN + RO, RO informal
// tu-form) for:
//
//   · `capsuleTier0.note.*` — every key in `TIER0_NOTE_KEYS`. Each is
//     rendered with `noteParams`; none of those params is ever a figure,
//     so the copy must not leave a slot for one.
//   · `capsule.metric.*` — one per `METRIC_TERMS` key, plus
//     `capsule.metric.finding_count` / `.period_count`. The engine
//     already declares this key space (`_capsule_tools.MetricSpec
//     .label_key`), so EN copy can be lifted from there.
//   · `capsuleTier0.trace.*` — the Tier-2 step labels.
//
// `capsuleTier0.note.definition` is the one that needs care: its param
// is a GLOSSARY ID, and the reviewed sentence for it already exists in
// both languages in `lib/glossary.ts` (`plainFor(id, lang)`). The copy
// should frame that sentence, not restate it.
//
// This module emits KEYS only, on purpose: it must stay importable
// without i18n so it can run in a worker, a test and a benchmark.
