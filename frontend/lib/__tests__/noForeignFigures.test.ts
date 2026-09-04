// GATE F4-NO-FOREIGN-FIGURES — no company's ledger entry may appear as a
// constant inside another company's formula.
//
// ── THE DEFECT ────────────────────────────────────────────────────────
//
// `periodFacts.ts` computed the debt-service coverage ratio as
//
//     dscr: mOr("dscr", safeDiv(
//       ebitdaStatutory,
//       plFacts.interest_expense + Math.max(773894.83, plFacts.depreciation)))
//
// and 773,894.83 is not a threshold, a materiality cutoff or a country
// pack figure. It is ONE COMPANY'S FIELD: EEI Imobiliara's year-to-date
// debit movement on account 1621 (CREDITE BANCARE PE TERMEN LUNG) for
// December 2025 — the long-term loan principal EEI actually repaid that
// year. The provenance is in this repo, twice:
//
//   e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json
//     {"code": "1621", …, "ytd_debit": 773894.83, …}
//   e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_ratios.json
//     "_dscr_note": "…Schedule shows 773,894.83 LT debt principal paid YTD…"
//
// It entered the product in commit bde8847 and was the principal proxy
// for EVERY company whose own depreciation is smaller than EEI's 2025
// repayment. DSCR is a lender-facing covenant ratio; the rule
// `true_debt_service_distress` fires "critical" below 1.0×.
//
// This is not the absent-read-as-zero class. It is worse: a real,
// specific, correctly-extracted number belonging to a DIFFERENT
// COMPANY'S BOOKS, doing arithmetic on this one's.
//
// ── WHAT THIS GATE ASSERTS ────────────────────────────────────────────
//
// §1 the value a consumer receives, through the real builder, on the
//     critic's scenario (EBITDA 800k / interest 50k / D&A 20k → 11.43×);
// §2 the constant is absent from the executable source of the product's
//     ratio modules — so it cannot come back by another route;
// §3 the sibling sweep: every numeric literal above 1,000 that sits in an
//     arithmetic position inside a financial formula is a ROUND
//     materiality threshold, never a ledger-shaped figure.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildPeriodFacts } from "@/lib/periodFacts";
import type { Statements } from "@/lib/financialReport";

const repoRoot = resolve(__dirname, "../../..");

/** EEI's own 1621 YTD debit, read out of the ground-truth fixture so the
 *  gate names the real provenance rather than a number a test author
 *  believed. */
const EEI_1621_YTD_DEBIT: number = (() => {
  const g = JSON.parse(
    readFileSync(
      resolve(repoRoot, "e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json"),
      "utf-8",
    ),
  ) as { accounts?: { code: string; ytd_debit?: number }[] } & Record<string, unknown>;
  const flat: { code: string; ytd_debit?: number }[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.code === "string" && typeof o.ytd_debit === "number") {
        flat.push({ code: o.code, ytd_debit: o.ytd_debit });
      }
      return void Object.values(o).forEach(walk);
    }
  };
  walk(g);
  const row = flat.find((r) => r.code === "1621");
  if (!row || typeof row.ytd_debit !== "number") {
    throw new Error(
      "ground-truth fixture no longer carries account 1621's ytd_debit — " +
        "this gate lost the provenance it exists to name.",
    );
  }
  return row.ytd_debit;
})();

// ── the harness: one company, its own books, nothing else ──────────────

const ZERO_BS = {
  cash: 0, accountsReceivable: 0, inventory: 0, otherCurrentAssets: 0,
  propertyPlantEquipment: 0, intangibles: 0, otherNonCurrentAssets: 0,
  accountsPayable: 0, shortTermDebt: 0, otherCurrentLiabilities: 0,
  longTermDebt: 0, otherNonCurrentLiabilities: 0,
  shareCapital: 0, retainedEarnings: 0, otherEquity: 0,
};

/** The critic's scenario, expressed as the engine-shaped assembled views
 *  the builder actually reads. `bank_debt_total` is 0: this company has
 *  no bank debt, so the ONLY principal term available is its own D&A. */
function scenario(opts: {
  ebitda: number;
  interest: number;
  depreciation: number;
  bankDebt?: number;
}): Statements {
  const { ebitda, interest, depreciation, bankDebt = 0 } = opts;
  return {
    companyName: "Subject SRL",
    currency: "RON",
    periodLabel: "FY 2025",
    balanceSheet: { ...ZERO_BS, longTermDebt: bankDebt },
    // `buildPeriodFacts` reads EBITDA off the P&L BUILDER, which
    // reconstructs it as revenue − COGS − opex. Revenue alone with no
    // costs makes EBITDA exactly the scenario's figure, so the only
    // moving parts in this suite are the three the critic named.
    incomeStatement: {
      revenue: ebitda, costOfGoodsSold: 0, operatingExpenses: 0,
      depreciationAmortization: depreciation, interestExpense: interest,
      otherIncome: 0, taxExpense: 0,
    },
    supplementary: {},
    assembled_pl: {
      ebitda_statutory: ebitda,
      ebitda: ebitda,
      operating_ebit: ebitda - depreciation,
      depreciation,
      interest_expense: interest,
      net_income_statutory: 0,
      revenue: 0,
    },
    assembled_bs: { total_debt: bankDebt, cash: 0 },
  } as unknown as Statements;
}

/** `RatioFacts.dscr` is `number | null` — an absent operand refuses the
 *  ratio rather than substituting a 0 (see periodFacts' safeDiv). Every
 *  scenario in this suite supplies EBITDA, interest and depreciation, so
 *  the DSCR here is always MEASURABLE; the assertion below states that
 *  rather than casting the absence away, so a future change that makes
 *  these scenarios unmeasurable fails loudly instead of comparing
 *  `null` against a threshold by coercion. */
function dscrOf(s: Statements): number {
  const dscr = buildPeriodFacts({
    periodId: "p1",
    statements: s,
    lineItems: [],
    valuation: null,
    industry: null,
  }).ratios.dscr;
  if (dscr === null) {
    throw new Error(
      "DSCR came back ABSENT for a scenario that supplies EBITDA, interest " +
        "and depreciation — the ratio should be measurable here.",
    );
  }
  return dscr;
}

// ── §1 THE VALUE ───────────────────────────────────────────────────────

describe("§1 — the debt-service ratio through the real builder", () => {
  it("the critic's scenario: EBITDA 800k / interest 50k / D&A 20k → 11.43×", () => {
    const dscr = dscrOf(scenario({ ebitda: 800_000, interest: 50_000, depreciation: 20_000 }));
    // 800,000 / (50,000 + 20,000) — the company's own interest and its own
    // depreciation, nothing else.
    expect(dscr).toBeCloseTo(800_000 / 70_000, 4);
    expect(dscr).toBeCloseTo(11.43, 2);
  });

  it("the shipped ratio was EEI's loan schedule dividing this company's EBITDA", () => {
    const dscr = dscrOf(scenario({ ebitda: 800_000, interest: 50_000, depreciation: 20_000 }));
    const withEeiConstant = 800_000 / (50_000 + Math.max(EEI_1621_YTD_DEBIT, 20_000));
    // ~0.97× — below the 1.0 covenant floor, i.e. the rule
    // `true_debt_service_distress` fires "critical" on a company whose
    // real coverage is 11×.
    expect(withEeiConstant).toBeLessThan(1.0);
    expect(
      Math.abs(dscr - withEeiConstant),
      `the builder still computes DSCR against ${EEI_1621_YTD_DEBIT} — ` +
        "EEI Imobiliara's 2025 long-term loan principal (account 1621).",
    ).toBeGreaterThan(0.5);
  });

  it("the ratio MOVES with this company's own depreciation", () => {
    // Under the constant, any D&A below 773,894.83 was invisible: the
    // `Math.max` swallowed it and the denominator never changed. That is
    // the signature of a foreign figure — the subject's own book has no
    // effect on its own ratio.
    const low = dscrOf(scenario({ ebitda: 800_000, interest: 50_000, depreciation: 20_000 }));
    const high = dscrOf(scenario({ ebitda: 800_000, interest: 50_000, depreciation: 300_000 }));
    expect(low).not.toBeCloseTo(high, 4);
    expect(high).toBeLessThan(low);
  });

  it("the principal term comes from THIS company's bank debt when it has any", () => {
    // 10% of own bank debt is the proxy `financialReport.ts` has always
    // stated on its legacy path; both entry points now share one formula.
    const dscr = dscrOf(
      scenario({ ebitda: 800_000, interest: 50_000, depreciation: 20_000, bankDebt: 5_000_000 }),
    );
    expect(dscr).toBeCloseTo(800_000 / (50_000 + 500_000), 4);
  });

  it("the 0-DSCR encoding can never coincide with a rule that PRINTS it", () => {
    // RESIDUAL, made safe by construction rather than by reading.
    // `RatioFacts.dscr` stays `number` because three rules call
    // `.toFixed(2)` on it unguarded (recommendationRules.ts:248, :288,
    // :316), and 0 is this structure's established "stay silent"
    // encoding. Those three rules all guard on
    // `bank_debt_total < 3_000_000 → return null`, and the principal
    // proxy is 10% of that same figure — so wherever a rule can print
    // the ratio, the denominator is at least 300,000 and the 0 branch is
    // unreachable. If someone lowers that guard, this reds.
    const RULE_DEBT_FLOOR = 3_000_000;
    const dscr = dscrOf(
      scenario({
        ebitda: 800_000,
        interest: 0,
        depreciation: 0,
        bankDebt: RULE_DEBT_FLOOR,
      }),
    );
    expect(dscr).toBeGreaterThan(0);
    expect(dscr).toBeCloseTo(800_000 / (RULE_DEBT_FLOOR * 0.1), 4);
  });

  it("a debt-free company is not graded on a debt schedule it does not have", () => {
    // The pre-fix denominator was floored at 773,894.83 even for a company
    // with no borrowings at all.
    const dscr = dscrOf(scenario({ ebitda: 800_000, interest: 0, depreciation: 100_000 }));
    expect(dscr).toBeCloseTo(8, 4);
  });
});

// ── §2 THE SOURCE ──────────────────────────────────────────────────────

describe("§2 — the constant is not in the executable source", () => {
  /** Comments and string literals blanked, offsets preserved. A gate that
   *  greps raw text would be defeated by the explanatory comment this fix
   *  deliberately leaves behind. */
  function stripCommentsAndStrings(src: string): string {
    const out = src.split("");
    const n = src.length;
    let i = 0;
    const blank = (a: number, b: number): void => {
      for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " ";
    };
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === "/" && d === "/") {
        let j = src.indexOf("\n", i);
        if (j < 0) j = n;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === "/" && d === "*") {
        let j = src.indexOf("*/", i + 2);
        j = j < 0 ? n : j + 2;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < n) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === c) break;
          j++;
        }
        blank(i, j + 1);
        i = j + 1;
        continue;
      }
      i++;
    }
    return out.join("");
  }

  const RATIO_MODULES = [
    "frontend/lib/periodFacts.ts",
    "frontend/lib/financialReport.ts",
    "frontend/lib/financialValuation.ts",
    "frontend/lib/recommendationRules.ts",
    "frontend/lib/publicCompanyAdapters.ts",
  ];

  it.each(RATIO_MODULES)("%s carries no EEI ledger figure in code", (rel) => {
    const code = stripCommentsAndStrings(
      readFileSync(resolve(repoRoot, rel), "utf-8"),
    );
    expect(
      code.includes(String(EEI_1621_YTD_DEBIT)),
      `${rel} contains ${EEI_1621_YTD_DEBIT} — EEI Imobiliara's account-1621 ` +
        "YTD principal repayment — as executable code.",
    ).toBe(false);
  });

  it("the sibling sweep: every literal >1000 in a formula is a ROUND threshold", () => {
    // A materiality cutoff is round (500_000, 3_000_000, 1.25). A figure
    // lifted out of a ledger carries cents or odd precision. This is the
    // shape test that catches the NEXT one, whatever its value.
    const NUM = /(?<![\w.$_])(\d{1,3}(?:_\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)(?![\w.]|_\d)/g;
    const ARITH_BEFORE = /[+\-*/%]\s*$|Math\.(max|min|abs|round|pow)\(\s*$|[<>]=?\s*$/;
    const ARITH_AFTER = /^\s*[+\-*/%<>)]/;
    const offenders: string[] = [];
    for (const rel of RATIO_MODULES) {
      const code = stripCommentsAndStrings(readFileSync(resolve(repoRoot, rel), "utf-8"));
      code.split("\n").forEach((line, i) => {
        let m: RegExpExecArray | null;
        NUM.lastIndex = 0;
        while ((m = NUM.exec(line))) {
          const raw = m[1];
          const val = Number(raw.replace(/_/g, ""));
          if (!Number.isFinite(val) || Math.abs(val) <= 1000) continue;
          const before = line.slice(0, m.index);
          const after = line.slice(m.index + raw.length);
          if (!ARITH_BEFORE.test(before) && !ARITH_AFTER.test(after)) continue;
          // ROUNDNESS is the discriminator: a threshold is a multiple of
          // 100 with no fractional part.
          if (Number.isInteger(val) && val % 100 === 0) continue;
          offenders.push(`${rel}:${i + 1}  ${raw}  ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(
      offenders,
      "an unround numeric literal in an arithmetic position inside a " +
        "financial formula. Either it is a real threshold from the country " +
        "pack — then name it as a documented constant — or it is a figure " +
        "from somebody's books, which may never divide another company's.",
    ).toEqual([]);
  });
});
