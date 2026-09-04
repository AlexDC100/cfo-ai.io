// GATE F4-STATED-ABSENCE — the reader sees a stated absence, never a
// number the product invented in its place.
//
// Three siblings of the same defect, each measured through the real
// component or the real builder, each with the control (TC-9) proving a
// present figure still renders exactly as before.
//
// §1 CreditScoreCard — seven `credit_subscore_* ?? 0` rendered as
//    `<ScoreBar value={0} weight={30}/>`. ZERO IS THE FLOOR of that
//    scale, so a sub-score the engine never emitted was painted as the
//    WORST reading a company can get on it, in the same red the genuinely
//    distressed band uses, on the card whose entire job is to be the
//    dashboard's trust signal. Same for the four Altman X components,
//    which printed "0.00" — a readable, plausible component value.
//
// §2 publicCompanyAdapters — `da = leaf(…) ?? Math.max(0, (h.ebitda ?? 0)
//    − (h.ebit ?? 0))`. EBITDA − EBIT IS D&A, so the identity is sound;
//    the `?? 0` on each term is not. With `ebit` absent the expression
//    collapses to EBITDA and the cash-flow statement prints the company's
//    entire operating earnings on the "Depreciation & amortization" line.
//    On the repo's real AAPL fixture that is 134.661 B standing in for
//    the 11.445 B the identity correctly yields when both terms are there.
//
// §3 the refusal SENTENCE — `describeAbsence()` returns hard-coded
//    English while the verdict chip beside it renders
//    `t("dashV2.ratioVerdictUnknown")` ("Neraportat"). A Romanian reader
//    got a Romanian chip on top of an English sentence: the half that
//    says WHICH input is missing — the only actionable half — was
//    unreadable.

import { describe, expect, it, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { CreditScoreCard, readCreditFromMetrics } from "@/components/cfo/CreditScoreCard";
import { buildPublicStatements } from "@/lib/publicCompanyAdapters";
import type { PublicCompanyEnvelope } from "@/lib/publicCompanyApi";
import envelopeJson from "./fixtures/publicCompany/aapl_envelope.json";
import { absenceSentence } from "@/components/cfo/ratioAbsenceI18n";
import i18n from "@/i18n";

beforeEach(() => cleanup());

// ── §1 AN UNMEASURED SUB-SCORE IS NOT A ZERO SCORE ─────────────────────

describe("§1 CreditScoreCard — a sub-score the engine never emitted", () => {
  /** Exactly what `calculated_metrics` looks like on a period whose
   *  `stage_compute` persisted the headline rows but none of the seven
   *  component rows (every cached pre-F1.h period, and any period the
   *  engine could not decompose). */
  const PARTIAL: Record<string, number | null> = {
    credit_composite: 82,
    altman_z_score: 3.09,
  };

  const FULL: Record<string, number | null> = {
    ...PARTIAL,
    altman_x1: 0.11, altman_x2: 0.24, altman_x3: 0.18, altman_x4: 1.05,
    credit_subscore_altman: 88,
    credit_subscore_profitability: 74,
    credit_subscore_leverage: 91,
    credit_subscore_coverage: 80,
    credit_subscore_dscr: 66,
    credit_subscore_liquidity: 55,
    credit_subscore_equity: 79,
  };

  it("reads as ABSENT, not as 0", () => {
    const d = readCreditFromMetrics(PARTIAL);
    expect(d).not.toBeNull();
    for (const [k, v] of Object.entries(d!.subscores)) {
      expect(v, `subscores.${k} came back as ${v} — 0 is the worst score`).toBeNull();
    }
    expect(d!.altmanX1).toBeNull();
    expect(d!.altmanX4).toBeNull();
  });

  it("renders 'not scored' with no bar and no 0 — and none of the alert red", () => {
    const d = readCreditFromMetrics(PARTIAL)!;
    const { container } = render(<CreditScoreCard data={d} variant="full" />);
    const text = container.textContent ?? "";

    // The seven rows exist (the reader still learns which components the
    // score is built from) but carry no figure.
    expect(container.querySelectorAll('[data-testid^="score-bar-absent-"]').length).toBe(7);
    expect(text).toContain("not scored");

    // No filled bar anywhere: `bg-alert` on a 0-width track is what
    // painted seven distress-red rows.
    expect(
      container.querySelectorAll(".bg-alert, .bg-caution, .bg-success").length,
      "a coloured score bar rendered for a component nothing measured",
    ).toBe(0);

    // And no "0" standing where a score would be.
    expect(
      /(^|\s)0(\s|$)/.test(text.replace(/0\.\d+/g, "")),
      `a bare 0 in the card body — the rendered text was: ${text.slice(0, 400)}`,
    ).toBe(false);

    // The Z″ components state the absence rather than printing 0.00.
    expect(text).not.toContain("0.00");
  });

  it("CONTROL — a fully-measured period renders bars and numbers as before", () => {
    const d = readCreditFromMetrics(FULL)!;
    const { container } = render(<CreditScoreCard data={d} variant="full" />);
    const text = container.textContent ?? "";
    expect(container.querySelectorAll('[data-testid^="score-bar-absent-"]').length).toBe(0);
    expect(container.querySelectorAll(".bg-success, .bg-caution, .bg-alert").length).toBe(7);
    expect(text).toContain("88");
    expect(text).toContain("1.05");
    expect(text).not.toContain("not scored");
  });
});

// ── §2 AN IDENTITY IS ONLY AN IDENTITY WITH BOTH TERMS ─────────────────

describe("§2 publicCompanyAdapters — D&A from EBITDA − EBIT", () => {
  const RAW = envelopeJson as unknown as PublicCompanyEnvelope;

  /** Deep clone + delete one headline key. TC-1: the real AAPL envelope
   *  is the subject; the deletion is the only mutation. */
  function withoutHeadline(key: string): PublicCompanyEnvelope {
    const clone = JSON.parse(JSON.stringify(RAW)) as PublicCompanyEnvelope & {
      periods: { headline: Record<string, unknown> }[];
    };
    for (const p of clone.periods) delete p.headline[key];
    return clone as unknown as PublicCompanyEnvelope;
  }

  it("CONTROL — with both terms the identity holds: 11.445 B", () => {
    const built = buildPublicStatements(RAW)!;
    const h = built.current.headline as unknown as Record<string, number>;
    expect(built.cf.operating.depreciation).toBeCloseTo(h.ebitda - h.ebit, 0);
    expect(built.cf.operating.depreciation).toBeCloseTo(11_445_000_000, 0);
  });

  it("with EBIT absent, D&A is ABSENT — not the whole of EBITDA", () => {
    const built = buildPublicStatements(withoutHeadline("ebit"))!;
    const ebitda = (RAW as unknown as { periods: { headline: { ebitda: number } }[] })
      .periods[0].headline.ebitda;
    expect(
      built.cf.operating.depreciation,
      `D&A came back as ${built.cf.operating.depreciation}; with EBIT gone the ` +
        `identity collapses to EBITDA (${ebitda}) and the statement prints the ` +
        "company's entire operating earnings on the depreciation line.",
    ).toBeNull();
    expect(built.cf.operating.cfBeforeWcChanges).toBeNull();
  });

  it("with EBITDA absent, D&A is ABSENT — not max(0, −EBIT) = 0", () => {
    const built = buildPublicStatements(withoutHeadline("ebitda"))!;
    expect(built.cf.operating.depreciation).toBeNull();
  });

  it("an absent D&A does not become a working-capital movement", () => {
    // `wcPlug = ocf − ni − da`. With `da` read as 0 the whole D&A gap was
    // booked as "Working-capital changes (net)" — a made-up line item.
    const built = buildPublicStatements(withoutHeadline("ebit"))!;
    expect(built.cf.operating.wcChanges).toEqual([]);
  });

  it("the balance check refuses when a side of it is absent", () => {
    // `(totalAssets.closing ?? 0) − (totalEquityLiab.closing ?? 0)` returns
    // one whole side of the balance sheet as the "drift".
    const built = buildPublicStatements(withoutHeadline("total_assets"))!;
    expect(built.bs.totalAssets.closing).toBeNull();
    expect(built.bs.balanceCheck).toBeNull();
    // CONTROL: the intact fixture still foots.
    const ok = buildPublicStatements(RAW)!;
    expect(Math.abs(ok.bs.balanceCheck ?? Number.NaN)).toBeLessThan(1);
  });
});

// ── §3 THE REFUSAL IS READ IN THE READER'S LANGUAGE ────────────────────

describe("§3 the refusal sentence follows the UI language", () => {
  const t = (key: string, opts?: Record<string, unknown>): string =>
    i18n.t(key, opts as never) as unknown as string;

  const MISSING = { kind: "missing" as const, inputs: ["interestExpense"] };
  const UNDEFINED_RATIO = { kind: "undefined_ratio" as const, denominator: "interest expense" };

  it("English: names the missing input in English", () => {
    const s = absenceSentence(t, MISSING, "en");
    expect(s).toContain("interest expense");
    expect(s.toLowerCase()).toContain("not reported");
  });

  it("Romanian: the sentence AND the input word are Romanian", () => {
    const s = absenceSentence(t, MISSING, "ro");
    expect(
      s,
      `the sentence beside the "Neraportat" chip was: ${s}`,
    ).toContain("Neraportat");
    expect(s).toContain("cheltuieli cu dobânzile");
    // The English half must be gone entirely — a mixed sentence is the
    // half-built refusal this gate exists to stop.
    expect(s).not.toContain("interest expense");
    expect(s).not.toContain("Not reported");
    expect(s).not.toContain("this filing does not carry");
  });

  it("Romanian: the undefined-ratio arm too", () => {
    const s = absenceSentence(t, UNDEFINED_RATIO, "ro");
    expect(s).toContain("Nedefinit");
    expect(s).toContain("cheltuieli cu dobânzile");
    expect(s).not.toContain("Undefined");
  });

  it("a multi-input refusal joins with the Romanian conjunction", () => {
    const s = absenceSentence(
      t,
      { kind: "missing", inputs: ["costOfGoodsSold", "interestExpense"] },
      "ro",
    );
    expect(s).toContain("costul vânzărilor");
    expect(s).toContain("și");
    expect(s).not.toContain(" and ");
  });
});
