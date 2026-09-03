// THE RECEIPT'S FIGURES NAME THEIR ORIGIN — measured on REAL engine output.
//
// TC-1: the served envelope is `corpus/saga_10_col_carniprod/expected/
// served_envelope.json` — a real SAGA export the engine served BALANCED,
// with no reconciliation receipt. So this test measures exactly what
// that payload supports: the difference row wears the served field, the
// extraction method and the mapping pack, and the two reconciliation
// rows do not render at all (there is no receipt to stand behind them).
// The receipt half is measured on the same envelope with a receipt
// planted in, using the receipt's own field names from the contract.
//
// TC-2 was run: with `provenance={differenceOrigin}` removed from the
// difference row, "the difference wears …" went red on
// `no affordance rendered in the receipt`.

import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

import { renderWithProviders } from "@/test/renderWithProviders";
import type { CanonicalBs, Statements } from "@/lib/financialReport";

const repoRoot = resolve(__dirname, "../../../../..");
const envelope = JSON.parse(
  readFileSync(
    resolve(repoRoot, "corpus/saga_10_col_carniprod/expected/served_envelope.json"),
    "utf-8",
  ),
) as CanonicalBs;

const periodRef: { statements: Statements | null } = { statements: null };
vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => ({ statements: periodRef.statements, id: "p1", label: "FY 2025" }),
}));

import { TrustChip } from "../TrustChip";

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

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

function affordances(): HTMLElement[] {
  return Array.from(
    screen.getByTestId("trust-receipt").querySelectorAll<HTMLElement>('[data-provenance="true"]'),
  );
}

async function openReceipt(): Promise<void> {
  fireEvent.click(screen.getByTestId("trust-chip"));
  await waitFor(() => expect(screen.getByTestId("trust-receipt")).toBeInTheDocument());
}

function openCardText(): string {
  return Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]"))
    .map((n) => n.textContent ?? "")
    .join(" ");
}

beforeEach(() => {
  cleanup();
});

describe("the fixture supports what the receipt would show", () => {
  it("is served with a method and a mapping pack, and without a receipt", () => {
    expect(envelope.extraction?.method).toBeTruthy();
    expect(envelope.mapping_version).toBeTruthy();
    expect((envelope as { reconciliation?: unknown }).reconciliation ?? null).toBeNull();
  });
});

describe("the difference row", () => {
  it("wears the served field, the extraction method and the pack — and nothing about a receipt", async () => {
    periodRef.statements = statementsWith(envelope);
    renderWithProviders(<TrustChip />);
    await openReceipt();
    const found = affordances();
    expect(found.length, "no affordance rendered in the receipt").toBe(1);
    expect(found[0].getAttribute("tabindex")).toBe("0");
    fireEvent.focus(found[0]);
    await waitFor(() => expect(openCardText()).toContain("servedFacts.difference()"));
    const text = openCardText();
    expect(text).toContain(envelope.extraction!.method);
    expect(text).toContain(envelope.mapping_version);
    expect(text).not.toContain("snapshot");
  });
});

describe("the reconciliation rows, on a receipt", () => {
  const RECEIPT = {
    content_hash: "8f2c1a9e",
    original_difference: 1234.56,
    applied_delta: -1234.56,
    origin: "deterministic" as const,
    applied_at: "2026-09-01T10:00:00Z",
    placement: "balance_sheet",
  };

  it("carry the receipt's content hash as the snapshot, and the applied delta its origin and time", async () => {
    periodRef.statements = statementsWith({
      ...envelope,
      status: "RECONCILED",
      reconciliation: RECEIPT,
    } as CanonicalBs);
    renderWithProviders(<TrustChip />);
    await openReceipt();
    const found = affordances();
    expect(found.length).toBe(3);
    fireEvent.focus(found[2]);
    await waitFor(() => expect(openCardText()).toContain("canonical_bs.reconciliation.applied_delta"));
    const text = openCardText();
    expect(text).toContain(RECEIPT.content_hash);
    expect(text).toContain(RECEIPT.origin);
    expect(text).toContain(RECEIPT.applied_at);
    expect(text).toContain(envelope.mapping_version);
  });
});
