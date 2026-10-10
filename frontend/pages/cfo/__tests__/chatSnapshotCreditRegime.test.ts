// THE GROUNDED CHAT IS HANDED THE GRADE THE DASHBOARD PRINTS — or its
// refusal — AND THE STOCK-BUILD REGIME IT WAS COMPOSED UNDER (owner ruling
// R1, 2026-09-28; review of release r-rulings2, 2026-10-01).
//
// THE DEFECT. `buildWorkspaceSnapshot` had no reference to credit or the
// regime. For the corpus developer the stored rows carry credit_composite
// NULL, which the snapshot skipped silently (`m.value === null → continue`),
// while it handed the assistant the sub-scores that did score and an
// ebitda_margin the engine refuses (margin_not_meaningful). The regime rode
// only the briefing facts, and after the no-model reprocess every briefing
// is hidden as written under the previous definition — so the assistant had
// neither the owner's sentence nor why there was no letter.
//
// LAW, over the served envelopes of `served_credit_regime.json` (captured
// from the real route by tests/engine/test_credit_regime_fe_fixture.py):
//   · the developer (regime, cash approximated): the regime's served label
//     EN + RO; the owner's finding EN + RO verbatim; the cash refusal EN +
//     RO; the composite and letter stated REFUSED with the sentence the
//     Risks tab prints (`engineCreditResult`), the credit_composite row too
//     — never skipped, never a figure; every margin row the engine refuses
//     stated REFUSED with the engine's words, no percent;
//   · the withheld case: the regime once, the owner's sentence in NEITHER
//     language;
//   · measured cash: the composite and letter as served, the cash figure;
//   · the manufacturer (standard model): no regime line, its letter.
// REDS ON: a regime grade handed over without its regime; the finding
// paraphrased, missing where served, or present where withheld; a refused
// composite skipped or printed as a number; a refused margin printed as a
// figure.
// CANNOT SEE: what the model answers (the edge function); the briefing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildWorkspaceSnapshot } from "@/pages/cfo/Chat";
import { engineCreditResult, type CreditEnvelope } from "@/lib/financialValuation";
import { readCreditRegime } from "@/lib/creditRegime";
import { marginRefusalOf } from "@/lib/marginMeaning";
import type { Statements } from "@/lib/financialReport";

const OWNER_RO = "EBITDA pozitivă din stocuri capitalizate — numerarul a fost consumat de construcție.";
const OWNER_EN = "Positive EBITDA from capitalised stock — the cash was consumed by construction.";

type Row = { name: string; value: number | null; unit?: string };
interface Case {
  credit: CreditEnvelope;
  metrics: Row[];
  statements?: Statements & Record<string, unknown>;
}
const FIX = JSON.parse(
  readFileSync(resolve(__dirname, "../../../lib/__tests__/fixtures/served_credit_regime.json"), "utf-8"),
) as { developer: Case; developer_measured_cash: Case; manufacturer: Case; developer_withheld: Case };

/** The rows a stored developer period carries beside its envelope: the
 *  composite the model refused (null), sub-scores that scored, and the
 *  margins the engine's verdict refuses (their stored values are figures). */
const STORED_ROWS: Row[] = [
  { name: "credit_composite", value: null, unit: "score" },
  { name: "credit_subscore_altman", value: 66.5, unit: "score" },
  { name: "ebitda_margin", value: 3.3934, unit: "%" },
  { name: "core_ebitda_margin", value: 3.1, unit: "%" },
  { name: "net_margin", value: 2.2, unit: "%" },
  { name: "net_debt_to_ebitda", value: 31.5183, unit: "x" },
];

function snapshot(c: Case, statements: Case["statements"] | null, metrics: Row[]): string {
  return (
    buildWorkspaceSnapshot({
      id: "p-credit", label: "FY2025", periodEnd: "2025-12-31", organizationId: null, industry: null,
      statements: statements ?? null, lineItems: [], invoices: null, metrics, recommendations: [], alerts: [],
      briefing: null, source: "upload", assembled_metrics: { credit: c.credit },
    } as unknown as Parameters<typeof buildWorkspaceSnapshot>[0]) ?? ""
  );
}

describe("the chat snapshot carries the engine's grade, its refusal and the stock-build regime", () => {
  it("the developer: the regime EN + RO, the owner's finding verbatim, the cash refusal, the composite REFUSED", () => {
    const dev = FIX.developer;
    const regime = readCreditRegime((dev.credit as unknown as { regime: unknown }).regime)!;
    expect(regime, "non-vacuity: the developer carries the regime").not.toBeNull();
    expect(regime.finding?.text.ro, "non-vacuity: the engine serves the owner's sentence").toBe(OWNER_RO);
    const text = snapshot(dev, dev.statements!, STORED_ROWS);
    const lines = text.split("\n");

    expect(lines.filter((l) => l.includes(regime.label.en)), "the regime, once").toHaveLength(1);
    expect(text).toContain(`  · ${regime.label.en} (RO: ${regime.label.ro})`);
    expect(text, "the served label is not prefixed a second time").not.toContain("Credit regime: Credit regime");
    expect(text).toContain(OWNER_EN);
    expect(text).toContain(OWNER_RO);
    expect(text).toContain(regime.cash!.refusal!.text.en);
    expect(text).toContain(regime.cash!.refusal!.text.ro);
    for (const basis of Object.values(regime.componentBases)) expect(text).toContain(basis.en);

    const read = engineCreditResult(dev.credit, undefined, {})!;
    expect(read.score, "non-vacuity: the engine refuses the composite").toBeNull();
    expect(read.compositeRefusal?.stated).toBe(true);
    expect(text).toContain(`Composite and letter: REFUSED — ${read.compositeRefusal!.sentence}`);
    expect(text).toContain(`credit_composite: REFUSED — ${read.compositeRefusal!.sentence}`);
    expect(lines.some((l) => /credit_composite: [\d−-]/.test(l)), "the composite is never a figure").toBe(false);
  });

  it("the developer: every margin the engine refuses is stated refused, in its words, never a percent", () => {
    const dev = FIX.developer;
    const refusal = marginRefusalOf(dev.statements);
    expect(refusal, "non-vacuity: the developer's margins are refused").not.toBeNull();
    const lines = snapshot(dev, dev.statements!, STORED_ROWS).split("\n");
    for (const name of ["ebitda_margin", "core_ebitda_margin", "net_margin"]) {
      const line = lines.find((l) => l.startsWith(`  · ${name}:`));
      expect(line, name).toBe(`  · ${name}: REFUSED — ${refusal!.en}`);
    }
    // A ratio the verdict does not cover is still the served figure.
    expect(lines).toContain("  · net_debt_to_ebitda: 31.52 x");
  });

  it("the withheld finding: the regime once, the owner's sentence in neither language", () => {
    const c = FIX.developer_withheld;
    const regime = readCreditRegime((c.credit as unknown as { regime: unknown }).regime)!;
    expect(regime.finding, "non-vacuity: the engine withheld the finding").toBeNull();
    const text = snapshot(c, null, c.metrics);
    expect(text.split("\n").filter((l) => l.includes(regime.label.en))).toHaveLength(1);
    expect(text).not.toContain(OWNER_EN);
    expect(text).not.toContain(OWNER_RO);
    expect(text).not.toContain("Finding");
  });

  it("measured cash: the composite and letter as served, the cash figure, no refusal", () => {
    const c = FIX.developer_measured_cash;
    const read = engineCreditResult(c.credit, undefined, {})!;
    expect(read.score, "non-vacuity: a composite under the regime").not.toBeNull();
    const text = snapshot(c, null, c.metrics);
    expect(text).toContain(`Composite: ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(read.score!)} / 100 — letter ${read.rating}`);
    expect(text).not.toContain("REFUSED");
    expect(text).toMatch(/\n  · Cash from operations: [−-]?[\d,.]+[\s\u00a0\u202f]RON/);
  });

  it("the manufacturer (standard model): no regime line, its letter", () => {
    const c = FIX.manufacturer;
    const read = engineCreditResult(c.credit, undefined, {})!;
    expect(read.regime ?? null).toBeNull();
    const text = snapshot(c, c.statements!, c.metrics);
    expect(text).not.toContain("Credit regime");
    expect(text).not.toContain("Regim de credit");
    if (read.score !== null && read.rating) expect(text).toContain(`letter ${read.rating}`);
    expect(text).not.toContain(OWNER_EN);
  });
});
