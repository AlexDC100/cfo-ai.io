// GATE F3-TRUST-DERIVATION — the balance receipt never derives a
// difference from a total it did not get.
//
// THE DEFECT. `canonicalStatusCore` read every served total through
// `?? 0` and then subtracted:
//
//     const assets = centsOrNull(cbs.totals?.assets) ?? 0;
//     const el = (centsOrNull(cbs.totals?.equity) ?? 0)
//              + (centsOrNull(cbs.totals?.liabilities) ?? 0);
//     differenceCents: servedDifference ?? assets - el,
//
// Two shapes, both taken from the real carniprod envelope:
//
//   · `difference` and `totals.liabilities` removed → the receipt showed
//     "Status BALANCED · Difference 18,990,225 RON", and 18,990,224.60 is
//     EXACTLY the liabilities total that went missing. The affordance
//     under it read "client-derived · assets − (equity + liabilities)
//     over served totals", naming a term the subtraction never had.
//   · `totals: {}` → difference 0, `differenceServed: false`. A
//     fabricated perfect balance, on the one surface whose entire job is
//     trust.
//
// TC-1 — both shapes are the REAL corpus envelope with named keys
// removed, not a hand-authored object. The removal is the mutation and
// nothing else changes, so the "before" case in the same file is the
// control.
//
// TC-7 — measured through the real `TrustChip` (the receipt a reader
// opens) as well as through the gateway, because the gateway returning
// null is only half a fix: the component still has to say so.

import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

import { renderWithProviders } from "@/test/renderWithProviders";
import { factsFrom, presentStatus } from "@/lib/servedFacts";
import type { CanonicalBs, Statements } from "@/lib/financialReport";

const repoRoot = resolve(__dirname, "../../..");
const envelope = JSON.parse(
  readFileSync(
    resolve(repoRoot, "corpus/saga_10_col_carniprod/expected/served_envelope.json"),
    "utf-8",
  ),
) as CanonicalBs;

/** The liabilities total this fixture serves — the number the broken
 *  derivation handed back as a "drift". Read out of the fixture so the
 *  assertion moves with it. */
const LIABILITIES = (envelope.totals as unknown as Record<string, number>).liabilities;

const periodRef: { statements: Statements | null } = { statements: null };
vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => ({ statements: periodRef.statements, id: "p1", label: "FY 2025" }),
}));

import { TrustChip } from "@/components/instrument/shell/TrustChip";

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

beforeEach(() => cleanup());

function statementsWith(cbs: CanonicalBs): Statements {
  return {
    companyName: "Carniprod",
    currency: "RON",
    periodLabel: "FY 2025",
    balanceSheet: {} as Statements["balanceSheet"],
    incomeStatement: {} as Statements["incomeStatement"],
    supplementary: {} as Statements["supplementary"],
    canonical_bs: cbs,
  };
}

/** The critic's shape 1: no served difference, and one term of the
 *  subtraction missing. */
function withoutLiabilities(): CanonicalBs {
  const { difference: _d, ...rest } = envelope as CanonicalBs & { difference?: number };
  void _d;
  const totals = { ...(rest.totals as unknown as Record<string, number>) };
  delete totals.liabilities;
  delete totals.equity_plus_liabilities;
  return { ...rest, totals } as unknown as CanonicalBs;
}

/** The critic's shape 2: an envelope with no totals at all. */
function withEmptyTotals(): CanonicalBs {
  const { difference: _d, ...rest } = envelope as CanonicalBs & { difference?: number };
  void _d;
  return { ...rest, totals: {} } as unknown as CanonicalBs;
}

// ── TC-3 / TC-9: the control ───────────────────────────────────────────

describe("the unmutated fixture — the control this gate is measured against", () => {
  it("serves a difference, so the gateway reads it rather than deriving", () => {
    expect(typeof (envelope as { difference?: unknown }).difference).toBe("number");
    const f = factsFrom(statementsWith(envelope));
    expect(f.difference()).toBe(0);
    expect(f.differenceOrigin()).toBe("served");
    expect(f.differenceTerms()).toEqual([]);
  });

  it("serves a liabilities total big enough to be recognised if it leaked", () => {
    expect(LIABILITIES).toBeGreaterThan(1_000_000);
  });
});

// ── shape 1: one term of the subtraction is missing ────────────────────

describe("F3 — a missing term means NO difference, not a difference equal to it", () => {
  it("the gateway refuses instead of handing back the absent total", () => {
    const f = factsFrom(statementsWith(withoutLiabilities()));
    expect(
      f.difference(),
      "the gateway still produced a drift with a term of the subtraction " +
        "absent — the returned figure is the missing total itself.",
    ).toBeNull();
    expect(f.differenceOrigin()).toBe("unavailable");
    expect(f.differenceTerms()).toEqual([]);
  });

  it("specifically: the 'drift' is never one of the served totals itself", () => {
    // The tell of the `?? 0` bug: with a term of the subtraction read as
    // zero, what comes back is the OTHER term. The critic saw exactly the
    // liabilities total; with `equity_plus_liabilities` gone too it is
    // the assets total. Either way the figure is a balance, not a drift,
    // so this asserts against every served total at once.
    const f = factsFrom(statementsWith(withoutLiabilities()));
    const d = f.difference();
    for (const [name, value] of Object.entries(
      envelope.totals as unknown as Record<string, number>,
    )) {
      if (typeof value !== "number" || Math.abs(value) < 1) continue;
      expect(
        d === null ? Number.NaN : Math.abs(d - value),
        `the reported "drift" is the served total \`${name}\` (${value}) — the ` +
          "absent term leaking out of the subtraction as a difference.",
      ).not.toBeLessThan(0.01);
    }
  });

  it("the receipt states the absence and offers no provenance card for it", async () => {
    periodRef.statements = statementsWith(withoutLiabilities());
    const { container } = renderWithProviders(<TrustChip />);
    // THE CHIP ITSELF REFUSES: a verdict with nothing behind it is not a
    // trust badge. TC-9 — the control below proves the chip does render
    // when the envelope supports it, so this is a refusal, not a crash.
    expect(
      container.querySelector('[data-testid="trust-chip"]'),
      "the chip still badges a period whose balance cannot be checked",
    ).toBeNull();
  });
});

// ── shape 2: no totals at all ──────────────────────────────────────────

describe("F3 — an envelope with no totals has no balance to report", () => {
  it("the gateway returns null, not the fabricated perfect balance", () => {
    const f = factsFrom(statementsWith(withEmptyTotals()));
    expect(
      f.difference(),
      "difference 0 over `totals: {}` is a fabricated perfect balance",
    ).toBeNull();
    expect(f.differenceOrigin()).toBe("unavailable");
  });

  it("no BALANCED badge is offered", () => {
    periodRef.statements = statementsWith(withEmptyTotals());
    const { container } = renderWithProviders(<TrustChip />);
    expect(container.querySelector('[data-testid="trust-chip"]')).toBeNull();
    expect(container.textContent ?? "").not.toMatch(/machine-computed/i);
  });

  it("the export sentence states the absence instead of printing RON 0.00", () => {
    const p = presentStatus({
      status: "MINOR_DRIFT",
      difference: null,
      currency: "RON",
    });
    expect(p.exportDetail ?? "").not.toMatch(/RON\s0\.00/);
    expect(p.exportDetail ?? "").toMatch(/not stated/i);
  });
});

// ── the derivation, when it IS possible, names only what it used ───────

describe("F3 — differenceOrigin names no term the computation lacked", () => {
  it("with equity_plus_liabilities served, the sentence names that one field", async () => {
    const { difference: _d, ...rest } = envelope as CanonicalBs & { difference?: number };
    void _d;
    const f = factsFrom(statementsWith(rest as CanonicalBs));
    expect(f.differenceOrigin()).toBe("client-derived");
    expect(f.differenceTerms()).toEqual(["assets", "equity_plus_liabilities"]);

    periodRef.statements = statementsWith(rest as CanonicalBs);
    renderWithProviders(<TrustChip />);
    fireEvent.click(screen.getByTestId("trust-chip"));
    await waitFor(() => expect(screen.getByTestId("trust-receipt")).toBeInTheDocument());
    const card = screen
      .getByTestId("trust-receipt")
      .querySelector<HTMLElement>('[data-provenance="true"]');
    expect(card, "no affordance on the derived difference").toBeTruthy();
    fireEvent.focus(card!);
    await waitFor(() => {
      const text = Array.from(
        document.querySelectorAll("[data-radix-popper-content-wrapper]"),
      )
        .map((n) => n.textContent ?? "")
        .join(" ");
      expect(text).toContain("totals.assets − totals.equity_plus_liabilities");
      // The pair spelling would name two terms where one was read.
      expect(text).not.toContain("totals.equity +");
    });
  });

  it("with only the equity/liabilities PAIR served, it names the pair", () => {
    const { difference: _d, ...rest } = envelope as CanonicalBs & { difference?: number };
    void _d;
    const totals = { ...(rest.totals as unknown as Record<string, number>) };
    delete totals.equity_plus_liabilities;
    const f = factsFrom(statementsWith({ ...rest, totals } as unknown as CanonicalBs));
    expect(f.differenceOrigin()).toBe("client-derived");
    expect(f.differenceTerms()).toEqual(["assets", "equity", "liabilities"]);
    // …and the arithmetic is still right: this fixture balances.
    expect(f.difference()).toBeCloseTo(0, 2);
  });
});
