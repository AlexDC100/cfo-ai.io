// GATE — A CARD NAMES ONLY ACCOUNTS THAT ARE IN THE NUMBER, AND THE
// GUARD READS WHAT THE RENDER PAINTS.
//
// Two smaller members of the same family as F1/F2/F3, both proven by the
// critic and both fixed at their source.
//
// ── (a) accounts that contributed nothing ──────────────────────────────
//
// `capsuleFactIndex` summed three concepts like this:
//
//     const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
//     const accounts = rows.flatMap((r) => r.account_codes);
//
// The sum skipped a row served with a null amount; the account list did
// not. So the fact's provenance card named an account holding a real
// balance that is NOT inside the figure — a provenance jump that lands
// somewhere WRONG, which this codebase already treats as worse than one
// that lands nowhere.
//
// Both outputs now come off ONE filtered array (`sumContributingRows`),
// so the two sets cannot be built differently. `quick_ratio` goes further
// and refuses outright when any inventory row is unquantified: a quick
// ratio over a partial inventory is a share of a stock level nobody
// measured.
//
// ── (b) guard and render reading different objects ─────────────────────
//
// `findings/parts.tsx` painted `facts[fact]` through the money template
// while its caller's `<ProvenanceAffordance>` guarded `impact.baseline`.
// The template is a SINGLE token, so the rest of the map was never read —
// the whole map bought nothing but the seam. It is now bound to the
// guarded number itself.
//
// TC-1 — the fixture is the captured REAL `/api/period` output for
// carniprod FY2025 (see the header of capsuleFactIndex.test.ts); the
// mutations are deletions of an `amount`, which is a shape the engine
// genuinely serves (every `opening` in the same file is null).

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  buildFactIndex,
  factFor,
  sumContributingRows,
  type CapsuleFactSnapshot,
} from "@/lib/capsuleFactIndex";
import type { CanonicalBsRow, Statements } from "@/lib/financialReport";
import { FigureValue } from "@/components/cfo/findings/parts";
import { renderWithProviders } from "@/test/renderWithProviders";

import carniprodJson from "./fixtures/capsuleTier0/period_carniprod_fy2025.json";

const carniprod = carniprodJson as unknown as Statements;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function snapshotOf(st: Statements): CapsuleFactSnapshot {
  return {
    activePeriodId: "p1",
    periods: [
      { periodId: "p1", periodLabel: "FY 2025", statements: st, docId: "doc-1" },
    ],
  };
}

/** Blank the `amount` of one served row, the way the engine already
 *  blanks every `opening` in this same file. */
function withBlankedAmount(id: string): Statements {
  const st = clone(carniprod);
  const rows = (st.canonical_bs as unknown as { rows: CanonicalBsRow[] }).rows;
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`fixture no longer serves a row \`${id}\``);
  (row as { amount: number | null }).amount = null;
  return st;
}

function rowById(st: Statements, id: string): CanonicalBsRow {
  const rows = (st.canonical_bs as unknown as { rows: CanonicalBsRow[] }).rows;
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`fixture no longer serves a row \`${id}\``);
  return r;
}

// ── TC-3: the subject ──────────────────────────────────────────────────

describe("the fixture is the right subject", () => {
  it("serves two cash rows, each naming its own accounts", () => {
    const a = rowById(carniprod, "cash_operating");
    const b = rowById(carniprod, "cash_fx");
    expect(a.account_codes.length).toBeGreaterThan(0);
    expect(b.account_codes.length).toBeGreaterThan(0);
    // The two must name DIFFERENT accounts, or dropping one row could not
    // show whether its codes survived into the card.
    expect(a.account_codes).not.toEqual(b.account_codes);
  });
});

// ── (a) the accounts law ───────────────────────────────────────────────

describe("sumContributingRows — one filtered array, two outputs", () => {
  it("a null-amount row contributes neither to the sum nor to the accounts", () => {
    const rows = [
      { id: "a", amount: 10, account_codes: ["501"] },
      { id: "b", amount: null, account_codes: ["502"] },
    ] as unknown as CanonicalBsRow[];
    const r = sumContributingRows(rows);
    expect(r.total).toBe(10);
    expect(r.accounts).toEqual(["501"]);
    expect(r.skipped).toBe(1);
  });

  it("no contributing row at all is ABSENT, not zero", () => {
    const rows = [{ id: "a", amount: null, account_codes: ["501"] }] as unknown as CanonicalBsRow[];
    expect(sumContributingRows(rows).total).toBeNull();
  });
});

describe("the `cash` fact never names an account that is not in it", () => {
  it("control: with both rows served, the card names both sets", () => {
    const idx = buildFactIndex(snapshotOf(carniprod));
    const cash = factFor(idx, "cash");
    expect(cash, "the index no longer builds a `cash` fact").toBeTruthy();
    const a = rowById(carniprod, "cash_operating");
    const b = rowById(carniprod, "cash_fx");
    expect(cash!.value).toBeCloseTo((a.amount as number) + (b.amount as number), 2);
    for (const code of [...a.account_codes, ...b.account_codes]) {
      expect(cash!.provenance?.account ?? "").toContain(code);
    }
  });

  it("with the FX row unquantified, its accounts leave the card with it", () => {
    const st = withBlankedAmount("cash_fx");
    const idx = buildFactIndex(snapshotOf(st));
    const cash = factFor(idx, "cash");
    expect(cash, "`cash` disappeared entirely — the operating row still counts").toBeTruthy();
    const operating = rowById(carniprod, "cash_operating");
    const fx = rowById(carniprod, "cash_fx");
    expect(cash!.value).toBeCloseTo(operating.amount as number, 2);
    const named = cash!.provenance?.account ?? "";
    for (const code of fx.account_codes) {
      expect(
        named,
        `the card still names account ${code}, whose row contributed nothing ` +
          "to the figure — a provenance jump onto a real balance the number " +
          "does not include.",
      ).not.toContain(code);
    }
    // …and TC-9: it is not simply empty.
    for (const code of operating.account_codes) {
      expect(named).toContain(code);
    }
  });
});

describe("quick_ratio refuses a partial inventory rather than netting one off", () => {
  it("control: it is derived when every inventory row is quantified", () => {
    const idx = buildFactIndex(snapshotOf(carniprod));
    expect(
      factFor(idx, "quick_ratio"),
      "the fixture no longer derives quick_ratio, so the refusal below is vacuous",
    ).toBeTruthy();
  });

  it("one unquantified inventory row and the ratio is gone, not approximated", () => {
    const st = withBlankedAmount("inventory_wip");
    const idx = buildFactIndex(snapshotOf(st));
    expect(
      factFor(idx, "quick_ratio"),
      "a quick ratio was still derived with an inventory row unquantified — " +
        "it is a share of a stock level nobody measured.",
    ).toBeFalsy();
  });
});

// ── (b) guard and render read one source ───────────────────────────────

describe("FigureValue paints the number its caller guards", () => {
  const FACT = "total_debt";

  it("a conflicting facts map cannot change what is painted", () => {
    // The seam: `fact` names an entry the caller's map holds a DIFFERENT
    // number for. Before the fix the template resolved the map's 999 while
    // any affordance around it guarded the 1,234 passed as `value`.
    const { container } = renderWithProviders(
      <FigureValue
        value={1234}
        unit="money"
        fact={FACT}
        facts={{ [FACT]: 999 }}
        factUnits={{ [FACT]: "money" }}
        currency="RON"
      />,
    );
    // Digits only: the money path formats by the CURRENCY's locale, so
    // 1234 prints as "1.234,00" under RON. The assertion is about which
    // NUMBER was painted, not about its separators.
    const figure = (
      container.querySelector<HTMLElement>("[data-narrative-money]")?.textContent ?? ""
    ).replace(/[^0-9]/g, "");
    expect(
      figure,
      "the rendered figure came from the facts MAP while the guard would " +
        "have seen `value` — two reads of two objects, one card.",
    ).toBe("123400");
  });

  it("control: it still renders the number when the map agrees", () => {
    const { container } = renderWithProviders(
      <FigureValue
        value={1234}
        unit="money"
        fact={FACT}
        facts={{ [FACT]: 1234 }}
        factUnits={{ [FACT]: "money" }}
        currency="RON"
      />,
    );
    expect((container.textContent ?? "").replace(/[\s ,.]/g, "")).toContain("1234");
  });

  it("an ABSENT figure still renders the gap glyph, map or no map", () => {
    render(
      <FigureValue
        value={null}
        unit="money"
        fact={FACT}
        facts={{ [FACT]: 999 }}
        factUnits={{ [FACT]: "money" }}
        currency="RON"
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
