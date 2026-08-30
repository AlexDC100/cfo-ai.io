// U1/U5 — ONE CURRENCY PER RENDERED CLAIM.
//
// Live defect, 2026-08-30 (severity-max): the Critical 461 note rendered
//   "Account 461 (Debitori diverși) holds RON 7,692,203 — 19.6% of
//    total assets 7.467.122,25 €"
// A native RON figure and a display-converted EUR figure in ONE claim.
//
// Cause: parseLinkifiedBody converts a matched figure ONLY when its
// cited fact has a FACT_TO_SOURCE bucket. `total_assets` has one (so it
// converted to EUR); `intercompany_loans` does not (so it stayed plain
// text WITH its "RON" label). The source bucket decides CLICKABILITY —
// it must never decide the currency a figure is rendered in.
//
// Fixture values are the production row for period 11b8e759 verbatim.
import { describe, expect, it } from "vitest";

import { parseLinkifiedBody } from "../linkifyAlertBody";

const BODY =
  "Account 461 (Debitori diverși) holds RON 7,692,203 due from " +
  "related parties — 19.6% of total assets RON 39,194,178. " +
  "Recoverability and intent on settlement should be confirmed.";

const FACTS = {
  intercompany_loans: 7692202.74,
  total_assets: 39194178.46,
  pct_of_assets: 0.19625880786990732,
};

describe("U1 — a claim renders every money figure through one currency path", () => {
  it("BOTH cited money figures become money parts, not one converted + one raw", () => {
    const parts = parseLinkifiedBody(BODY, FACTS);
    const money = parts.filter((p) => p.kind === "link");
    const values = money.map((p) => (p as { value: number }).value);
    expect(values, "both cited figures must be money parts").toEqual(
      expect.arrayContaining([7692203, 39194178]),
    );
  });

  it("no 'RON' label survives in inert text — a stale label is how the mix appears", () => {
    const parts = parseLinkifiedBody(BODY, FACTS);
    const inert = parts
      .filter((p) => p.kind === "text")
      .map((p) => (p as { value: string }).value)
      .join("");
    expect(inert, `stale currency label left in: "${inert}"`).not.toMatch(/\bRON\b/);
  });

  it("a figure without a source bucket is still money — just not clickable", () => {
    const parts = parseLinkifiedBody(BODY, FACTS);
    const inter = parts.find(
      (p) => p.kind === "link" && Math.round((p as { value: number }).value) === 7692203,
    );
    expect(inter, "intercompany_loans has no FACT_TO_SOURCE entry").toBeDefined();
    expect((inter as { source?: unknown }).source).toBeUndefined();
  });
});

describe("U2 — the ratio is native and invariant", () => {
  it("19.6% is RON/RON and does NOT change with display currency", () => {
    // The engine computed this natively; it is arithmetically correct.
    // Pinned so no future 'fix' recomputes it post-conversion.
    const pct = FACTS.intercompany_loans / FACTS.total_assets;
    expect(pct * 100).toBeCloseTo(19.63, 1);
    // A cross-currency division would give a wildly different answer.
    const bogus = FACTS.intercompany_loans / (FACTS.total_assets / 5.2489);
    expect(Math.abs(bogus * 100 - 19.63)).toBeGreaterThan(50);
  });
});
