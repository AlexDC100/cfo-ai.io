// THE STATEMENT ROW WEARS ITS PROVENANCE — measured on REAL engine output.
//
// TC-1: the fixture is `corpus/saga_10_col_carniprod/expected/
// served_envelope.json`, a real SAGA export with "codes and all numerics
// preserved to the cent" per its own meta.yaml. Nothing here is
// hand-written, so an assertion cannot quietly encode what the author
// expected the engine to produce.
//
// This is the surface half of the chain `scripts/capsule_demo_partial.py`
// proves numerically. That script walks served fact -> BS row -> account
// codes -> cells I15+I16+I17 = 66,280,871.31, difference 0 cents, and
// closes with "the numeric chain is PROVEN, the surface is NOT". What
// follows is a piece of the surface, in jsdom rather than a browser —
// the browser half still needs a signed-in workspace this host cannot
// give (the local Supabase pin is deliberately away from production).
//
// SUBJECT FLOORS (TC-3): a census that finds nothing is broken. Each law
// below asserts it had rows to be about BEFORE asserting anything is
// true of them.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";
import { BSStatementView } from "@/components/cfo/BSStatementView";
import { buildBSStatement } from "@/lib/buildBsStatement";
import type { CanonicalBs } from "@/lib/financialReport";

const repoRoot = resolve(__dirname, "../../../..");
const envelope = JSON.parse(
  readFileSync(
    resolve(repoRoot, "corpus/saga_10_col_carniprod/expected/served_envelope.json"),
    "utf-8",
  ),
) as CanonicalBs;

/** The envelope's own words, read back rather than restated. If the
 *  fixture changes these, the assertions move with it. */
const SHEET = envelope.extraction?.sheet ?? "";
const METHOD = envelope.extraction?.method ?? "";
const PACK = envelope.mapping_version;

beforeEach(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // PRO MODE, deliberately. THE DIAL defaults to Simple, which collapses
  // every ITEM row behind "Show all lines" — and the first run of this
  // test found 0 affordances for exactly that reason, on a statement
  // where 44 rows carry account codes. That is TC-3 working: the floor
  // caught a census with no subject before it could be read as a clean
  // sweep. Simple mode's own visible rows (the subtotals) are covered by
  // the aggregate law further down.
  localStorage.setItem("cfo-view-mode-v1", "pro");
});

function mount() {
  const statement = buildBSStatement({
    lineItems: [],
    entity: "Carniprod",
    asOf: "31.12.2025",
    comparativeDate: "01.01.2025",
    currency: "RON",
    canonicalBs: envelope,
  });
  // The application's own provider stack — currency, tooltip, learning
  // popovers, router. Anything less and the statement cannot render at
  // all, which would make every law below a statement about a crash.
  return renderWithProviders(<BSStatementView statement={statement} />);
}

function affordances(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.bs-statement [data-provenance="true"]'),
  );
}

describe("the fixture actually carries what the affordance would show", () => {
  it("the envelope names a sheet, a method and a mapping pack", () => {
    expect(SHEET).toBeTruthy();
    expect(METHOD).toBeTruthy();
    expect(PACK).toBeTruthy();
  });

  it("its rows name account codes — the checkable half", () => {
    const withCodes = envelope.rows.filter((r) => (r.account_codes ?? []).length > 0);
    expect(
      withCodes.length,
      "no row in the fixture names an account code, so every law below " +
        "would be a statement about an empty set (TC-3).",
    ).toBeGreaterThan(10);
  });
});

describe("HAS provenance → the affordance is there", () => {
  it("account-coded rows carry it, on enough rows to be a real subject", () => {
    mount();
    const found = affordances();
    // FLOOR asserted AFTER the discovery loop, on the fixture's own
    // count. Two cells per row (opening + closing), and the rows that
    // render a <LearnableNumber> are deliberately excluded (see
    // BSStatementView's KNOWN GAP note), so this is a lower bound, not
    // an equality.
    expect(
      found.length,
      `Only ${found.length} provenance affordance(s) rendered across a ` +
        `${envelope.rows.length}-row real balance sheet. The census is broken, ` +
        "not clean.",
    ).toBeGreaterThan(10);
  });

  it("every one of them is reachable by keyboard", () => {
    mount();
    const found = affordances();
    expect(found.length).toBeGreaterThan(0);
    const unreachable = found.filter((el) => el.getAttribute("tabindex") !== "0");
    expect(
      unreachable.length,
      "a provenance affordance a keyboard user cannot reach is decorative " +
        "for that reader — the exact failure this lane exists to remove.",
    ).toBe(0);
  });

  it("it keeps the amount cell's own class, so the grid still lays out", () => {
    mount();
    const found = affordances();
    expect(found.length).toBeGreaterThan(0);
    // The mobile layout places columns with
    // `.bs-row > .bs-amount:nth-of-type(n)`. The affordance REPLACES the
    // amount span rather than wrapping it; if it ever starts wrapping,
    // the column placement silently breaks and nothing else would say so.
    const misclassed = found.filter((el) => !el.classList.contains("bs-amount"));
    expect(misclassed.length).toBe(0);
    for (const el of found) {
      expect(el.tagName).toBe("SPAN");
      expect(el.parentElement?.classList.contains("bs-row")).toBe(true);
    }
  });
});

describe("the card carries the SAME anchor the numeric demo lands on", () => {
  it("Machinery & equipment opens on accounts 2131, 2132, 2133 and its sheet", async () => {
    mount();
    // The row `capsule_demo_partial.py` walks all the way to cells
    // I15+I16+I17. Found by its account codes, not by its label — a
    // label is presentation and could be translated; the codes are the
    // thing a reader checks against their own trial balance.
    const target = envelope.rows.find(
      (r) => (r.account_codes ?? []).join(",") === "2131,2132,2133",
    );
    expect(
      target,
      "the fixture no longer holds the row this assertion is about",
    ).toBeTruthy();

    const cell = affordances().find(
      (el) => el.parentElement?.textContent?.includes(target!.label) ?? false,
    );
    expect(cell, `no affordance on the "${target!.label}" row`).toBeTruthy();

    fireEvent.focus(cell!);
    await waitFor(() =>
      expect(screen.getAllByText("2131, 2132, 2133").length).toBeGreaterThan(0),
    );
    // The sheet and the pack come from the envelope, read back rather
    // than typed in here.
    expect(screen.getAllByText(SHEET).length).toBeGreaterThan(0);
    expect(screen.getAllByText(PACK).length).toBeGreaterThan(0);
    expect(screen.getAllByText(METHOD).length).toBeGreaterThan(0);
  });

  it("an AGGREGATE names no sheet cell and no accounts — it is not in one", async () => {
    mount();
    const subtotal = document.querySelector<HTMLElement>(
      '.bs-subtotal [data-provenance="true"]',
    );
    expect(
      subtotal,
      "no subtotal carries the affordance, so this law has no subject",
    ).toBeTruthy();
    fireEvent.focus(subtotal!);
    await waitFor(() =>
      expect(screen.getAllByText("engine subtotal").length).toBeGreaterThan(0),
    );
    // A section subtotal is not in any cell. Pointing it at one would be
    // a provenance jump that lands somewhere WRONG, which is worse than
    // one that lands nowhere.
    expect(screen.queryByText(SHEET)).toBeNull();
    expect(screen.queryByText(/^Accounts/)).toBeNull();
  });
});

describe("LACKS provenance → nothing is claimed", () => {
  it("a legacy period with no canonical envelope renders no affordance", () => {
    // The build's other path: no `canonicalBs`, so no sheet, no method,
    // no pack. Rows still render; the affordance does not. This is the
    // rule that outranks coverage.
    const statement = buildBSStatement({
      lineItems: [],
      entity: "Legacy",
      asOf: "31.12.2025",
      comparativeDate: "01.01.2025",
      currency: "RON",
    });
    renderWithProviders(<BSStatementView statement={statement} />);
    expect(document.querySelectorAll('[data-provenance="true"]').length).toBe(0);
    // …and it is not simply an empty render: the statement is on screen.
    expect(screen.getByTestId("bs-statement")).toBeInTheDocument();
  });
});
