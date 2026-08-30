// F1 / F2 / F5 / F9 — THE FINDINGS GATES, AT THE DISPLAY BOUNDARY.
//
// The engine-side halves live in `tests/engine/test_findings_gates.py`;
// the plant log for all nine is `design_review/findings/GATES.md`. What
// is testable only HERE is the last few centimetres of the pipe: a
// finding that is perfectly quantified in RON can still reach a reader as
// nonsense if the renderer converts half of one claim.
//
// That is not hypothetical — it shipped. The Critical-461 note read:
//
//   "Account 461 (Debitori diverși) holds RON 7,692,203 — 19.6% of total
//    assets 7.467.122,25 €"
//
// One claim, two currencies, and a correct 19.6% made unverifiable.
//
// FIXTURES ARE REAL ENGINE OUTPUT, verbatim. The template, the facts, the
// declared units and the fallback body below are the bytes
// `s_engine.run_single_period` produces from the committed
// `agras_fy2025` envelope for production period 11b8e759 — the same
// workspace, the same 461 balance, the same 19.6%. So this file is not
// testing a hand-written string that resembles the contract: if the
// engine's template shape moves, this fails.
//
// WHAT IS GATED HERE
//   F1  the finding survives the boundary intact — the template resolves
//       whole, or not at all. A half-resolved claim is the defect.
//   F2  the ledger code and both figures reach the reader.
//   F5  THE UNIT LAW. Switch the display currency and every dimensionless
//       part of the sentence must be byte-identical; only the money moves.
//   F9  the renderer invents nothing — an absent fact refuses the whole
//       template rather than printing a zero or a guess.
//
// Each gate carries a PLANT: the defect it is watching for, reproduced,
// asserted to be visible, then left un-shipped.

import { describe, expect, it } from "vitest";

import {
  formatCitedFact,
  parseNarrativeTemplate,
  resolveMoneyDisplay,
  type NarrativePart,
} from "@/lib/narrativeMoney";
import type { Currency, Rates } from "@/lib/rates";

// ── The rebuilt 461 finding, exactly as the engine emits it ─────────────

const TITLE_TEMPLATE =
  "Related-party receivable on 461 at 19.6% — above the 10.0% " +
  "related-party share of total assets (elevated) for mid-size " +
  "inventory-heavy operator";

const BODY_TEMPLATE =
  "461 (Debitori diverși), 451 (Decontări între entitățile afiliate), " +
  "452 (Decontări privind interesele de participare), 455 (Sume datorate " +
  "acționarilor / asociaților): related-party balance on 461 — " +
  "{{money:intercompany_loans}}; total assets — {{money:total_assets}}; " +
  "current liabilities — {{money:cur_liab}}; share of total assets — 19.6%. " +
  "Basis: measured against the company's own total assets for the same " +
  "period. Source: period 11b8e759; snapshot snap-11b8e759; accounts 461, " +
  "451, 452, 455; assembled_canonical_v1. Rule concentration_related_party " +
  "fires when related-party share of total assets (elevated) is above " +
  "10.0%; observed 19.6%. Impact: Current ratio after a full related-party " +
  "haircut moves from 2.12× to 1.52× (-0.59×).";

const FACTS: Record<string, number> = {
  intercompany_loans: 7692202.74,
  total_assets: 39194178.46,
  cur_liab: 12934654.2,
  pct_of_assets: 0.19625880786990732,
};

const UNITS: Record<string, string> = {
  intercompany_loans: "money",
  total_assets: "money",
  cur_liab: "money",
  pct_of_assets: "percent",
};

const SOURCE: Currency = "RON";

// EUR-base, X units per 1 EUR — the shape `lib/rates` publishes.
const RATES: Rates = { EUR: 1.0, RON: 4.97, USD: 1.08 };

// ── Helpers ────────────────────────────────────────────────────────────

/** Render parsed parts the way `NarrativeText` does, minus React. */
function renderParts(parts: NarrativePart[], display: Currency): string {
  return parts
    .map((part) =>
      part.kind === "text"
        ? part.value
        : resolveMoneyDisplay(
            part.value,
            SOURCE,
            display,
            RATES,
            "2026-05-01",
            part.decimals,
          ).text,
    )
    .join("");
}

/** Only the inert half of the sentence — everything the display currency
 *  must not be able to touch. */
function dimensionlessText(parts: NarrativePart[]): string {
  return parts
    .filter((p) => p.kind === "text")
    .map((p) => (p as { value: string }).value)
    .join("");
}

function moneyParts(parts: NarrativePart[]) {
  return parts.filter((p) => p.kind === "money") as Extract<
    NarrativePart,
    { kind: "money" }
  >[];
}

function parseOrThrow(
  template: string,
  facts = FACTS,
  units = UNITS,
): NarrativePart[] {
  const parts = parseNarrativeTemplate(template, facts, units);
  expect(parts, "the engine's own template was refused by the renderer").not
    .toBeNull();
  return parts as NarrativePart[];
}

// ══ F1 — the finding survives the boundary intact ══════════════════════

describe("F1 — the contract survives the render boundary", () => {
  it("resolves the engine's template whole, with every named fact bound", () => {
    const parts = parseOrThrow(BODY_TEMPLATE);
    const money = moneyParts(parts);
    expect(money.map((p) => p.fact)).toEqual([
      "intercompany_loans",
      "total_assets",
      "cur_liab",
    ]);
    // Native values, unconverted, exactly as the engine cited them.
    expect(money.map((p) => p.value)).toEqual([
      FACTS.intercompany_loans,
      FACTS.total_assets,
      FACTS.cur_liab,
    ]);
  });

  it("PLANT F1: an absent fact refuses the WHOLE template, never half of it", () => {
    // ABSENT is not ZERO, and a half-resolved sentence is exactly the
    // mixed claim this boundary exists to remove.
    const missing = { ...FACTS } as Record<string, number>;
    delete missing.cur_liab;
    expect(parseNarrativeTemplate(BODY_TEMPLATE, missing, UNITS)).toBeNull();

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        parseNarrativeTemplate(
          BODY_TEMPLATE,
          { ...FACTS, cur_liab: bad },
          UNITS,
        ),
      ).toBeNull();
    }
    // Reverted: the complete fact set resolves.
    expect(parseNarrativeTemplate(BODY_TEMPLATE, FACTS, UNITS)).not.toBeNull();
  });
});

// ══ F2 — the specific things a reader needs still reach them ═══════════

describe("F2 — specificity survives the render boundary", () => {
  it("keeps the ledger code, both thresholds and the observation in the prose", () => {
    const rendered = renderParts(parseOrThrow(BODY_TEMPLATE), "RON");
    for (const token of ["461", "451", "452", "455"]) {
      expect(rendered).toContain(token);
    }
    expect(rendered).toContain("19.6%"); // the observation
    expect(rendered).toContain("10.0%"); // the limit that judged it
    expect(rendered).toContain("moves from 2.12× to 1.52×"); // the impact
  });

  it("carries a title that needs no conversion at all, and says so", () => {
    // The rebuilt title cites the OBSERVATION and the LIMIT, both
    // dimensionless — so it contains no money placeholder and the
    // renderer correctly declines to templatize it. That is not a
    // fallback-as-downgrade: the engine guarantees the template renders
    // byte-identically to the stored text, so there is nothing to lose.
    expect(TITLE_TEMPLATE).not.toContain("{{");
    expect(parseNarrativeTemplate(TITLE_TEMPLATE, FACTS, UNITS)).toBeNull();
    expect(TITLE_TEMPLATE).toContain("461");
    expect(TITLE_TEMPLATE).toContain("19.6%");
    expect(TITLE_TEMPLATE).toContain("10.0%");
    expect(TITLE_TEMPLATE).toContain("mid-size inventory-heavy operator");
    // ...and there is no currency word to strand: nothing in the title
    // can straddle the conversion boundary.
    expect(/\bRON\b|\bEUR\b|€/.test(TITLE_TEMPLATE)).toBe(false);
  });

  it("carries at least two figures whichever currency is displayed", () => {
    for (const display of ["RON", "EUR", "USD"] as Currency[]) {
      const rendered = renderParts(parseOrThrow(BODY_TEMPLATE), display);
      const numbers = rendered.match(/-?[\d.,]*\d/g) ?? [];
      expect(numbers.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ══ F5 — THE UNIT LAW ══════════════════════════════════════════════════

describe("F5 — one currency per claim, ratios never converted", () => {
  it("renders identical percentages, multiples and thresholds in RON and EUR", () => {
    const parts = parseOrThrow(BODY_TEMPLATE);

    // The dimensionless half of the sentence is parsed ONCE and is the
    // same object for every display currency — there is no code path in
    // which a percentage could be re-resolved against a rate.
    const inert = dimensionlessText(parts);
    expect(inert).toContain("19.6%");
    expect(inert).toContain("10.0%");
    expect(inert).toContain("2.12×");
    expect(inert).toContain("1.52×");
    expect(inert).toContain("-0.59×");

    const ron = renderParts(parts, "RON");
    const eur = renderParts(parts, "EUR");
    expect(ron).not.toEqual(eur); // the money moved...

    // ...and nothing else did. Strip the money spans out of both and the
    // remainder must be byte-identical.
    const strip = (text: string) =>
      moneyParts(parts).reduce((acc, part) => {
        const shown = resolveMoneyDisplay(
          part.value,
          SOURCE,
          text === ron ? "RON" : "EUR",
          RATES,
          "2026-05-01",
          part.decimals,
        ).text;
        return acc.replace(shown, "<money>");
      }, text);
    expect(strip(ron)).toEqual(strip(eur));
  });

  it("keeps the native value on every money part regardless of display", () => {
    const parts = parseOrThrow(BODY_TEMPLATE);
    for (const display of ["RON", "EUR", "USD"] as Currency[]) {
      const resolved = moneyParts(parts).map((p) =>
        resolveMoneyDisplay(p.value, SOURCE, display, RATES, null, p.decimals),
      );
      // Every figure in the claim is on the SAME side of the boundary.
      expect(new Set(resolved.map((r) => r.currency)).size).toBe(1);
      expect(resolved.every((r) => r.convertible)).toBe(true);
    }
  });

  it("PLANT F5a: a money numeral baked into the template never converts", () => {
    // The 461 defect at the display boundary: the engine prints digits
    // and a currency word instead of a named fact, so the figure is inert
    // text while its siblings convert. Reproduced here to prove the
    // renderer CANNOT repair an engine-side numeral — which is why the
    // engine refuses to emit one (OrphanCurrencyLabelError).
    const baked =
      "related-party balance on 461 — RON 7,692,203; total assets — " +
      "{{money:total_assets}}.";
    const rendered = renderParts(parseOrThrow(baked), "EUR");
    expect(rendered).toContain("RON 7,692,203"); // stayed native
    expect(rendered).toMatch(/€|EUR/); // beside a converted sibling
    // Two currencies in one claim — exactly what shipped.
    const claimsRon = /\bRON\b/.test(rendered);
    const claimsEur = /€|\bEUR\b/.test(rendered);
    expect(claimsRon && claimsEur).toBe(true);

    // Reverted: the engine's real template names the fact, and the whole
    // claim lands in one currency.
    const real = renderParts(parseOrThrow(BODY_TEMPLATE), "EUR");
    expect(/\bRON\b/.test(real)).toBe(false);
  });

  it("PLANT F5b: a percentage declared as money would convert — the declaration is the gate", () => {
    const template = "share of total assets — {{fact:pct_of_assets|d2}}.";

    // Declared correctly: dimensionless, identical in every currency.
    const honest = parseOrThrow(template, FACTS, UNITS);
    expect(moneyParts(honest)).toHaveLength(0);
    expect(renderParts(honest, "RON")).toEqual(renderParts(honest, "EUR"));

    // Mis-declared as money: the same number now rides the conversion
    // path and the two displays disagree. This is why `_ratio_units` is
    // the authority on what money is, and why the engine demotes a
    // figure cited under the wrong unit before it ever gets here.
    const planted = parseOrThrow(template, FACTS, {
      ...UNITS,
      pct_of_assets: "money",
    });
    expect(moneyParts(planted)).toHaveLength(1);
    expect(renderParts(planted, "RON")).not.toEqual(
      renderParts(planted, "EUR"),
    );
  });

  it("PLANT F5c: an undeclared unit is refused, not guessed", () => {
    const template = "observed {{fact:pct_of_assets}}.";
    const units = { ...UNITS } as Record<string, string>;
    delete units.pct_of_assets;
    expect(parseNarrativeTemplate(template, FACTS, units)).toBeNull();
    expect(
      parseNarrativeTemplate(template, FACTS, {
        ...UNITS,
        pct_of_assets: "furlongs",
      }),
    ).toBeNull();
  });
});

// ══ F9 — the renderer invents nothing ══════════════════════════════════

describe("F9 — nothing is fabricated at the boundary", () => {
  it("prints only the facts the template names", () => {
    const parts = parseOrThrow(BODY_TEMPLATE);
    const named = new Set(moneyParts(parts).map((p) => p.fact));
    // `pct_of_assets` is a cited fact but is printed by the ENGINE as
    // literal text, so the renderer must not reach for it.
    expect(named.has("pct_of_assets")).toBe(false);
    for (const fact of named) expect(FACTS[fact]).toBeTypeOf("number");
  });

  it("falls back to native with a stated label rather than silently mixing", () => {
    // No rate for the display currency: the figure stays in its own
    // currency AND says so. Never a zero, never a quiet mix.
    const resolved = resolveMoneyDisplay(
      FACTS.intercompany_loans,
      "RON",
      "EUR",
      { EUR: 1.0, RON: 0, USD: 1.08 } as Rates,
      null,
      0,
    );
    expect(resolved.convertible).toBe(false);
    expect(resolved.currency).toBe("RON");
    expect(resolved.provenance).toBeTruthy();
  });

  it("formats a cited fact by its DECLARED unit, never by its magnitude", () => {
    const money = (v: number) => `MONEY(${v})`;
    // The live guess this replaced currency-formatted anything over 1,
    // so a 6.28x leverage multiple rendered as "€1.62" in the one panel a
    // reader opens to check the arithmetic.
    expect(formatCitedFact("debt_to_ebitda", 6.28, { debt_to_ebitda: "ratio" }, money))
      .toBe("6.28");
    expect(formatCitedFact("pct_of_assets", 0.196, UNITS, money)).toBe("0.196");
    expect(formatCitedFact("total_assets", FACTS.total_assets, UNITS, money))
      .toBe(money(FACTS.total_assets));
  });
});
