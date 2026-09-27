// cmdbarSearch.ts — how a typed query meets a term. Pure, deterministic,
// no network, no model.
//
// THE RULES (design C2):
//   · diacritics are optional: both sides go through `foldQuery`, the one
//     normaliser the router and the engine's `_fold` share;
//   · Romanian and English meet in ONE term list per subject (the synonym
//     table in cmdbarTerms.json — "profit", "rezultat net", "net income");
//   · a typo is forgiven on WORDS only: Damerau-Levenshtein distance ≤ 1
//     (a transposition counts one) between tokens of five characters or
//     more — "profitt", "clineti", "bilnat";
//   · a token that holds a DIGIT matches exactly or as a prefix, never
//     fuzzily: "4112" must never silently open 4111. An account code one
//     digit off is a different account;
//   · an ACCOUNT CODE is matched as a whole, from its start: a typed word
//     that holds a digit is compared with the code with its separators
//     removed (`codeKey`) — "401" finds 401.003 and 401.01, never 167.401
//     (a loan account whose SECOND segment happens to read 401), and the
//     digits inside an account's NAME ("… 457.364") are not code tokens.
//     `accountQueryTokens` / `accountNameTokens` are the only way an
//     account entry is tokenised (cmdbarIndex.ts).
//
// A query matches a phrase when EVERY query token matches some token of the
// phrase. The score rewards exact over prefix over fuzzy and a phrase the
// query covers completely, so "cifra de afaceri" outranks "cifra" alone and
// the tie-break is deterministic (score, then the caller's own order).

import { foldQuery } from "@/lib/capsuleRouter";

/** Tokens of five characters or more may carry one edit. */
export const FUZZY_MIN_LEN = 5;
export const FUZZY_MAX_DISTANCE = 1;

/** Folded word tokens. `foldQuery` first (the shared normaliser), then any
 *  remaining non-letter, non-digit character splits — "Clienti int.TT"
 *  is ["clienti", "int", "tt"], "„profit”" is ["profit"]. */
export function tokensOf(text: string): string[] {
  const folded = foldQuery(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return folded ? folded.split(" ").filter((t) => t !== "") : [];
}

export function hasDigit(token: string): boolean {
  return /\d/.test(token);
}

/** An account code's matching form: folded, every separator removed —
 *  "167.401" → "167401", "4111" → "4111". The code is ONE token. */
export function codeKey(text: string): string {
  return foldQuery(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The query as an ACCOUNT entry reads it: a word that holds a digit is a
 *  code (or the start of one) and stays ONE token, separators removed —
 *  "167.401" → ["167401"], "401" → ["401"]; every other word is tokenised
 *  as usual. So a digit word can only meet the START of a whole code. */
export function accountQueryTokens(query: string): string[] {
  const out: string[] = [];
  for (const word of foldQuery(query).split(" ")) {
    if (!word) continue;
    if (hasDigit(word)) {
      const k = codeKey(word);
      if (k) out.push(k);
    } else {
      out.push(...tokensOf(word));
    }
  }
  return out;
}

/** An account NAME's words, without the ones that hold a digit: a number
 *  inside a name is not the account's code and must not answer a code. */
export function accountNameTokens(name: string): string[] {
  return tokensOf(name).filter((t) => !hasDigit(t));
}

/** Optimal-string-alignment distance (Damerau-Levenshtein with adjacent
 *  transpositions), cut off above `max`: returns max + 1 as soon as the
 *  distance is known to exceed it. */
export function editDistance(a: string, b: string, max: number = FUZZY_MAX_DISTANCE): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  let prev2: number[] = new Array(m + 1).fill(0);
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur: number[] = new Array(m + 1).fill(0);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

export type TokenMatch = "exact" | "prefix" | "fuzzy";

/** How one query token meets one term token, or null. */
export function tokenMatch(q: string, term: string): TokenMatch | null {
  if (!q || !term) return null;
  if (q === term) return "exact";
  if (term.startsWith(q)) return "prefix";
  // THE DIGIT RULE: exact or prefix only.
  if (hasDigit(q) || hasDigit(term)) return null;
  if (q.length >= FUZZY_MIN_LEN && term.length >= FUZZY_MIN_LEN
      && editDistance(q, term, FUZZY_MAX_DISTANCE) <= FUZZY_MAX_DISTANCE) {
    return "fuzzy";
  }
  // A typo inside a word still being typed: "profi" is a prefix; "prfit"
  // (five letters) is one edit from "profit".
  return null;
}

const WEIGHT: Record<TokenMatch, number> = { exact: 3, prefix: 2, fuzzy: 1 };

/** The score of a query against ONE phrase, or null when some query token
 *  matches nothing in it. Each phrase token is used at most once. */
export function phraseScore(queryTokens: readonly string[], phrase: readonly string[]): number | null {
  if (queryTokens.length === 0 || phrase.length === 0) return null;
  const used = new Array(phrase.length).fill(false);
  let score = 0;
  for (const q of queryTokens) {
    let best: { i: number; m: TokenMatch } | null = null;
    for (let i = 0; i < phrase.length; i++) {
      if (used[i]) continue;
      const m = tokenMatch(q, phrase[i]);
      if (m && (!best || WEIGHT[m] > WEIGHT[best.m])) best = { i, m };
      if (best?.m === "exact") break;
    }
    if (!best) return null;
    used[best.i] = true;
    score += WEIGHT[best.m];
  }
  // A phrase the query covers completely ranks above one it only touches.
  const covered = used.every(Boolean);
  return score * 10 + (covered ? 5 : 0) - (phrase.length - queryTokens.length);
}

/** The best score of a query over a list of phrases (a subject's terms),
 *  or null when none matches. */
export function bestScore(queryTokens: readonly string[], phrases: readonly (readonly string[])[]): number | null {
  let best: number | null = null;
  for (const p of phrases) {
    const s = phraseScore(queryTokens, p);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

/** Pre-tokenise a subject's terms once, when the index is built. */
export function termPhrases(terms: readonly string[]): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    const toks = tokensOf(t);
    const key = toks.join(" ");
    if (toks.length && !seen.has(key)) {
      seen.add(key);
      out.push(toks);
    }
  }
  return out;
}
