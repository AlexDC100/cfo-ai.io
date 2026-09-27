// cmdbar-search — the typed query meets a term (design C2): diacritics
// optional, RO+EN synonyms, a one-edit typo forgiven on WORDS of five
// characters or more, and a token that holds a DIGIT matched exactly or as
// a prefix only — an account code one digit off is another account.
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11): a fuzzy match on a digit token
// ("4112" reaching 4111xx); a typo tolerance loosened past one edit or down
// to four-letter words; a synonym table that stops joining a RO word to its
// figure; a non-deterministic order. WHAT IT CANNOT SEE: the rendered rows
// (commandBar.test.tsx).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  codeKey,
  editDistance,
  hasDigit,
  phraseScore,
  tokenMatch,
  tokensOf,
} from "../cmdbarSearch";
import { buildCmdbarIndex, searchCmdbar, accountMetricKey } from "../cmdbarIndex";

const REPO = resolve(__dirname, "../../../../../..");
const SCANDIA = JSON.parse(
  readFileSync(resolve(REPO, "e2e/fixtures/workspace_v2/scandia_fy2025.json"), "utf-8"),
).period;

const AGRAS = JSON.parse(
  readFileSync(resolve(REPO, "e2e/fixtures/workspace_v2/agras_fy2025.json"), "utf-8"),
).period;

const index = buildCmdbarIndex({
  body: SCANDIA,
  pages: [
    { id: "tab:balance_sheet", label: "Bilanț", href: "/dashboard?tab=balance_sheet", terms: ["Balance sheet", "bilant"] },
    { id: "tab:pl", label: "Contul de profit și pierdere", href: "/dashboard?tab=pl", terms: ["Profit and loss", "p&l"] },
  ],
  actions: [{ id: "upload", label: "Încarcă o balanță", terms: ["upload", "trial balance"] }],
});

function topAnswer(q: string): string | null {
  const g = searchCmdbar(index, q).groups.find((x) => x.group === "answer");
  return g?.hits[0]?.entry.id ?? null;
}

function accountCodes(q: string): string[] {
  const g = searchCmdbar(index, q).groups.find((x) => x.group === "account");
  return (g?.hits ?? []).map((h) => (h.entry.ref.kind === "account" ? h.entry.ref.item.ro_account_code : ""));
}

describe("folding — diacritics are optional, punctuation splits", () => {
  it("folds Romanian letters and splits on punctuation", () => {
    expect(tokensOf("Cifră de afaceri")).toEqual(["cifra", "de", "afaceri"]);
    expect(tokensOf("Clienti int.TT")).toEqual(["clienti", "int", "tt"]);
    expect(tokensOf("„profit”")).toEqual(["profit"]);
  });
  it("the same query with and without accents finds the same figure", () => {
    expect(topAnswer("cifră de afaceri")).toBe("answer:turnover");
    expect(topAnswer("cifra de afaceri")).toBe("answer:turnover");
    expect(topAnswer("creanțe")).toBe(topAnswer("creante"));
  });
});

describe("synonyms — Romanian and English meet in one term list", () => {
  it.each([
    ["profit", "answer:net_result"],
    ["profitul net", "answer:net_result"],
    ["net income", "answer:net_result"],
    ["rezultat", "answer:net_result"],
    ["revenue", "answer:turnover"],
    ["venituri", "answer:turnover"],
    ["turnover", "answer:turnover"],
    ["ebitda", "answer:ebitda"],
    ["numerar", "answer:cash"],
    ["cash", "answer:cash"],
    ["datorii", "answer:debt"],
    ["debt", "answer:debt"],
    ["stocuri", "answer:inventory"],
    ["inventory", "answer:inventory"],
    ["clienti", "answer:receivables"],
    ["furnizori", "answer:payables"],
    ["suppliers", "answer:payables"],
  ])("%j → %s", (q, id) => {
    expect(topAnswer(q)).toBe(id);
  });
  it("a ratio answers to its label in either language (the Ratios tab's own words)", () => {
    expect(topAnswer("current ratio")).toBe("ratio:current_ratio");
    expect(topAnswer("lichiditate curentă")).toBe("ratio:current_ratio");
  });
  it("one figure is shown once: the inventory answer and the dio row are one claim", () => {
    const g = searchCmdbar(index, "zile stoc").groups.find((x) => x.group === "answer");
    const ids = (g?.hits ?? []).map((h) => h.entry.id);
    expect(ids).toContain("answer:inventory");
    expect(ids).not.toContain("ratio:dio");
  });
});

describe("typos — one edit, on words of five characters or more", () => {
  it("measures a transposition as one edit", () => {
    expect(editDistance("clineti", "clienti")).toBe(1);
    expect(editDistance("bilnat", "bilant")).toBe(1);
    expect(editDistance("profitt", "profit")).toBe(1);
    expect(editDistance("profxyz", "profit")).toBeGreaterThan(1);
  });
  it.each([
    ["profitt", "answer:net_result"],
    ["clineti", "answer:receivables"],
    ["furnizrii", "answer:payables"],
  ])("%j is forgiven → %s", (q, id) => {
    expect(topAnswer(q)).toBe(id);
  });
  it("a misspelt page is still found: 'bilnat' opens the balance sheet", () => {
    const g = searchCmdbar(index, "bilnat").groups.find((x) => x.group === "page");
    expect(g?.hits[0]?.entry.id).toBe("page:tab:balance_sheet");
  });
  it("a short word is never fuzzed: 'cahs' is not 'cash'", () => {
    expect(tokenMatch("cahs", "cash")).toBeNull();
    expect(topAnswer("cahs")).toBeNull();
  });
  it("two edits are never forgiven", () => {
    expect(tokenMatch("proifte", "profit")).toBeNull();
  });
});

describe("THE DIGIT RULE — exact or prefix, never fuzzy", () => {
  it("a token holding a digit never matches by edit distance", () => {
    expect(hasDigit("4112")).toBe(true);
    expect(tokenMatch("4112", "4111")).toBeNull();
    expect(tokenMatch("4112", "411201")).toBe("prefix");
    expect(tokenMatch("5121", "5121")).toBe("exact");
  });
  it("'4111' lists the 4111xx leaves; '4112' lists none of them", () => {
    const hits = accountCodes("4111");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((c) => c.startsWith("4111"))).toBe(true);
    expect(accountCodes("4112").some((c) => c.startsWith("4111"))).toBe(false);
  });
  it("a code one digit off never silently picks another account", () => {
    // REAL six-digit leaves of the served book — long enough that a word
    // rule (edit distance 1 on 5+ characters) WOULD match them if the digit
    // rule were not there. A four-digit probe could not tell.
    const codes: string[] = SCANDIA.line_items.map((li: { ro_account_code: string }) => li.ro_account_code);
    const have = new Set(codes);
    let probed = 0;
    for (const code of codes) {
      if (code.length < 6) continue;
      for (let d = 1; d <= 9; d++) {
        const off = code.slice(0, -1) + String((Number(code.slice(-1)) + d) % 10);
        if (have.has(off)) continue;
        const hits = accountCodes(off);
        expect(hits.filter((c) => !c.startsWith(off)), `"${off}" (one digit off ${code})`).toEqual([]);
        probed++;
        break;
      }
      if (probed >= 25) break;
    }
    expect(probed, "VACUITY: no one-digit-off probe was run").toBeGreaterThanOrEqual(20);
  });
  it("an account's key metric is the longest declared prefix", () => {
    expect(accountMetricKey("411101")).toBe("dso");
    expect(accountMetricKey("401001")).toBe("dpo");
    expect(accountMetricKey("512421")).toBe("cash_ratio");
    expect(accountMetricKey("301001")).toBe("dio");
    expect(accountMetricKey("999999")).toBeNull();
  });
});

describe("THE WHOLE-CODE RULE — a typed code meets the START of a whole code, nothing else", () => {
  // Agras is a SAGA-style dotted book (167.401, 628.401, 709.401 …) whose
  // account names carry numbers ("… 2420.42"); Scandia is plain six-digit.
  // Splitting a code on its dots made "401" an EXACT match of 167.401's
  // second segment — a loan account first under "401", selected, opened by
  // Enter (design C2: a code query never silently picks another account).
  const BOOKS = [
    { name: "scandia", body: SCANDIA },
    { name: "agras", body: AGRAS },
  ] as const;
  const leaves = (body: { line_items: { ro_account_code: string; statement: string }[] }) =>
    body.line_items.filter((li) => typeof li.ro_account_code === "string" && li.statement !== "IGNORED");

  for (const book of BOOKS) {
    it(`${book.name}: every 3- and 4-digit prefix and every inner segment returns ONLY codes that start with it, and all of them`, () => {
      const idx = buildCmdbarIndex({ body: book.body, pages: [], actions: [] });
      const items = leaves(book.body);
      const probes = new Set<string>();
      for (const li of items) {
        const k = codeKey(li.ro_account_code);
        if (k.length >= 3) probes.add(k.slice(0, 3));
        if (k.length >= 4) probes.add(k.slice(0, 4));
        // Every segment after the first — the shape the old tokeniser
        // matched EXACTLY inside another account's code.
        for (const seg of li.ro_account_code.split(/[^0-9A-Za-z]+/).slice(1)) if (seg.length >= 3) probes.add(seg);
      }
      let probed = 0;
      let innerOnly = 0;
      const wrong: string[] = [];
      const missed: string[] = [];
      for (const p of probes) {
        const g = searchCmdbar(idx, p).groups.find((x) => x.group === "account");
        const codes = (g?.hits ?? []).map((h) => (h.entry.ref.kind === "account" ? h.entry.ref.item.ro_account_code : ""));
        for (const c of codes) if (!codeKey(c).startsWith(p)) wrong.push(`"${p}" → ${c}`);
        const want = items.filter((li) => codeKey(li.ro_account_code).startsWith(p)).length;
        const got = (g?.hits.length ?? 0) + (g?.more ?? 0);
        if (got !== want) missed.push(`"${p}": ${got} rows, ${want} codes start with it`);
        if (want === 0) innerOnly++;
        probed++;
      }
      expect(wrong, `${book.name}: accounts whose code does not start with the typed prefix`).toEqual([]);
      expect(missed, `${book.name}: prefixes whose account count is not every code that starts with them`).toEqual([]);
      expect(probed, "VACUITY: prefixes probed").toBeGreaterThanOrEqual(50);
      if (book.name === "agras") {
        // POSITIVE CONTROL: the dotted book HAS inner segments that are no
        // code's start — the probes the old tokeniser answered wrongly.
        expect(innerOnly, "inner segments that start no code").toBeGreaterThanOrEqual(1);
      }
      console.log(`GATE-WORK cmdbar-whole-code ${book.name} prefixes=${probed} inner_only=${innerOnly}`);
    });
  }

  it("agras: '401' lists the 401 accounts — never 167.401, 628.401 or 709.401", () => {
    const idx = buildCmdbarIndex({ body: AGRAS, pages: [], actions: [] });
    const g = searchCmdbar(idx, "401").groups.find((x) => x.group === "account")!;
    const codes = g.hits.map((h) => (h.entry.ref.kind === "account" ? h.entry.ref.item.ro_account_code : ""));
    expect(codes.length).toBeGreaterThan(0);
    for (const inner of ["167.401", "628.401", "709.401"]) expect(codes).not.toContain(inner);
    expect(codes.every((c) => c.startsWith("401"))).toBe(true);
    // The whole dotted code, typed with its dot, is still found — first.
    const exact = searchCmdbar(idx, "167.401").groups.find((x) => x.group === "account")!;
    expect(exact.hits[0].entry.ref.kind === "account" && exact.hits[0].entry.ref.item.ro_account_code).toBe("167.401");
  });

  it("agras: a number inside an account's NAME answers no code query", () => {
    const idx = buildCmdbarIndex({ body: AGRAS, pages: [], actions: [] });
    const items = leaves(AGRAS) as { ro_account_code: string; ro_account_name?: string; statement: string }[];
    let probed = 0;
    for (const li of items) {
      const num = /(\d{4})\.\d+/.exec(li.ro_account_name ?? "")?.[1];
      if (!num || items.some((x) => codeKey(x.ro_account_code).startsWith(num))) continue;
      const g = searchCmdbar(idx, num).groups.find((x) => x.group === "account");
      expect(g?.hits.length ?? 0, `"${num}" (from the name of ${li.ro_account_code})`).toBe(0);
      if (++probed >= 25) break;
    }
    expect(probed, "VACUITY: name numbers probed").toBeGreaterThanOrEqual(20);
  });
});

describe("ranking — deterministic, whole phrases first", () => {
  it("scores exact over prefix over fuzzy, and a covered phrase above a touched one", () => {
    const exact = phraseScore(["profit"], ["profit"])!;
    const prefix = phraseScore(["prof"], ["profit"])!;
    const fuzzy = phraseScore(["profitt"], ["profit"])!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(fuzzy);
    expect(phraseScore(["cifra"], ["cifra", "de", "afaceri"])!)
      .toBeLessThan(phraseScore(["cifra", "de", "afaceri"], ["cifra", "de", "afaceri"])!);
  });
  it("the same query gives the same rows every time", () => {
    const a = JSON.stringify(searchCmdbar(index, "cont").groups.map((g) => g.hits.map((h) => h.entry.id)));
    for (let i = 0; i < 5; i++) {
      expect(JSON.stringify(searchCmdbar(index, "cont").groups.map((g) => g.hits.map((h) => h.entry.id)))).toBe(a);
    }
  });
  it("groups come in the fixed order and 'Întreabă CFO AI' is always offered, last", () => {
    const r = searchCmdbar(index, "clienti");
    const order = r.groups.map((g) => g.group);
    const want = ["answer", "account", "page", "action"].filter((g) => order.includes(g as never));
    expect(order).toEqual(want);
    expect(r.ask).toEqual({ query: "clienti" });
    expect(searchCmdbar(index, "   ").ask).toBeNull();
  });
});
