// AUTO-RECONCILE — FE affordance tests (docs/CANONICAL_BS_V2_CONTRACT.md
// §"RECONCILIATION FLOW" + revised operator spec 2026-08-19). Reconciliation
// is a fully automatic server-side stage; the client is never sent an
// intermediate unreconciled sub-threshold state and there is NO manual
// Reconcile button anywhere. The FE renders the engine's verdict verbatim:
//   · RECONCILED → calm green Balanced-family chip + subtle
//     "· auto-adjusted {X}" micro-caption; tapping the chip toggles a
//     one-line receipt ({amount} moved to {placement} · verified against
//     source · {origin}) + Undo
//   · Undo → the honest raw state showing the TRUE source imbalance
//   · needs_review (served flag) → calm amber "Needs manual mapping"
//     panel with the diagnosis line — no button, no modal
//   · the synthetic "Diferențe de reconciliere" row renders with a visible
//     marker + tooltip; when placement is P&L the BS row may be absent and
//     no empty marker anchor renders

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Currency store is context-backed (throws outside its provider in dev);
// mock the hooks the BS renderer consumes so the strip renders standalone.
vi.mock("@/stores/currency", () => ({
  useAmountFormatter:
    () =>
    (v: number | null | undefined): string =>
      v === null || v === undefined ? "0" : String(Math.round(v * 100) / 100),
  useDisplayCurrency: () => "RON",
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  useRates: () => ({ rates: {} }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));

import { BsCanonicalStatusStrip, BSStatementView } from "@/components/cfo/BSStatementView";
import { buildBSStatement, type BSCanonicalMeta, type CanonicalBsExt } from "@/lib/buildBsStatement";
import { cfoApi } from "@/lib/cfoApi";
import { queryClient } from "@/lib/queryClient";

// ─── fixtures ────────────────────────────────────────────────────────────

const APPLIED_AT = "2026-08-19T10:00:00Z";
const RATIONALE = "Unmapped account 4511 balance equals the difference to the cent";

function baseMeta(overrides: Partial<BSCanonicalMeta> = {}): BSCanonicalMeta {
  return {
    status: "MINOR_DRIFT",
    difference: -46.61,
    totalAssets: 100_000,
    equityPlusLiabilities: 100_046.61,
    diagnosis: [],
    mappingVersion: "ro_omfp1802_v2",
    needsReview: false,
    ...overrides,
  };
}

function reconciledMeta(
  placement: "balance_sheet" | "pnl" = "balance_sheet",
): BSCanonicalMeta {
  return baseMeta({
    status: "RECONCILED",
    difference: 0,
    reconciliation: {
      content_hash: "abc123",
      original_difference: -46.61,
      applied_delta: 46.61,
      target_row_id: "reconciliation_differences",
      origin: "deterministic",
      diagnosis_code: "D2_FINGERPRINT",
      rationale: RATIONALE,
      applied_at: APPLIED_AT,
      reversible: true,
      placement,
    },
  });
}

function canonicalBsFixture(overrides: Partial<CanonicalBsExt> = {}): CanonicalBsExt {
  return {
    schema: "bs_v2",
    mapping_version: "ro_omfp1802_v2",
    rows: [
      {
        id: "cash",
        section: "current_assets",
        label: "Cash at bank",
        account_codes: ["5121"],
        amount: 50,
        opening: null,
      },
    ],
    sections: [
      { id: "current_assets", subtotal: 50 },
      { id: "equity", subtotal: 50 },
    ],
    totals: {
      assets: 50,
      equity: 50,
      liabilities: 0,
      equity_plus_liabilities: 50,
      current_assets: 50,
      current_liabilities: 0,
    },
    difference: 0,
    status: "BALANCED",
    diagnosis: [],
    ...overrides,
  };
}

/** Auto-reconciled envelope with a balance-sheet placement — carries the
 *  visible synthetic row. */
function reconciledCanonicalBs(): CanonicalBsExt {
  return canonicalBsFixture({
    status: "RECONCILED",
    difference: 0,
    reconciliation: {
      content_hash: "abc123",
      original_difference: -46.61,
      applied_delta: 46.61,
      target_row_id: "reconciliation_differences",
      origin: "deterministic",
      diagnosis_code: "D2_FINGERPRINT",
      rationale: RATIONALE,
      applied_at: APPLIED_AT,
      reversible: true,
      placement: "balance_sheet",
    },
    rows: [
      {
        id: "cash",
        section: "current_assets",
        label: "Cash at bank",
        account_codes: ["5121"],
        amount: 50,
        opening: null,
      },
      {
        id: "reconciliation_differences",
        section: "current_liabilities",
        label: "Diferențe de reconciliere",
        account_codes: [],
        amount: 46.61,
        opening: null,
        leaf_ids: [],
        synthetic: true,
      },
    ],
    sections: [
      { id: "current_assets", subtotal: 50 },
      { id: "equity", subtotal: 3.39 },
      { id: "current_liabilities", subtotal: 46.61 },
    ],
  });
}

/** P&L placement — the adjusting line lives in the P&L (reaching the BS
 *  through the result line), so NO synthetic BS row exists. */
function reconciledPnlPlacementCanonicalBs(): CanonicalBsExt {
  const cbs = reconciledCanonicalBs();
  return {
    ...cbs,
    reconciliation: { ...cbs.reconciliation!, placement: "pnl" },
    rows: cbs.rows.filter((r) => r.synthetic !== true),
    sections: [
      { id: "current_assets", subtotal: 50 },
      { id: "equity", subtotal: 50 },
    ],
  };
}

/** The honest raw state the undo endpoint serves back — the TRUE source
 *  imbalance, no synthetic row, no reconciliation receipt. */
function rawDriftCanonicalBs(): CanonicalBsExt {
  return canonicalBsFixture({
    status: "MINOR_DRIFT",
    difference: -46.61,
    reconciliation: null,
  });
}

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? matches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}

/** The manual flow is gone: no state may render a Reconcile button or the
 *  old amber offer chip. */
function expectNoReconcileButton() {
  expect(screen.queryByTestId("bs-reconcile-btn")).toBeNull();
  expect(screen.queryByTestId("bs-status-reconcile-offer")).toBeNull();
  expect(screen.queryByText(/^(Reconcile|Reconciliază)$/)).toBeNull();
}

beforeEach(() => {
  setReducedMotion(false);
  vi.spyOn(queryClient, "resetQueries").mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── builder pass-through (lib level) ────────────────────────────────────

describe("buildBSStatement — auto-reconcile pass-through (canonical path only)", () => {
  it("carries the reconciliation receipt on the canonical meta and marks the synthetic row", () => {
    const st = buildBSStatement({
      lineItems: [],
      entity: "Test SRL",
      asOf: "31.12.2025",
      comparativeDate: "01.01.2025",
      currency: "RON",
      canonicalBs: reconciledCanonicalBs(),
    });

    expect(st.canonical?.status).toBe("RECONCILED");
    expect(st.canonical?.needsReview).toBe(false);
    expect(st.canonical?.reconciliation?.applied_delta).toBe(46.61);
    expect(st.canonical?.reconciliation?.origin).toBe("deterministic");
    expect(st.canonical?.reconciliation?.placement).toBe("balance_sheet");

    const allLines = [...st.assetSections, ...st.equityLiabSections].flatMap((s) => s.lines);
    const synthetic = allLines.find((l) => l.synthetic);
    expect(synthetic?.label).toBe("Diferențe de reconciliere");
    // Tooltip: rationale · origin · timestamp, straight from the receipt.
    expect(synthetic?.syntheticNote).toBe(`${RATIONALE} · deterministic · ${APPLIED_AT}`);
    // Ordinary rows are never marked.
    expect(allLines.find((l) => l.label === "Cash at bank")?.synthetic).toBeUndefined();
  });

  it("exposes the engine needs_review flag verbatim (never derived FE-side)", () => {
    const st = buildBSStatement({
      lineItems: [],
      entity: "Test SRL",
      asOf: "31.12.2025",
      comparativeDate: "01.01.2025",
      currency: "RON",
      canonicalBs: canonicalBsFixture({
        status: "MINOR_DRIFT",
        difference: -46.61,
        needs_review: true,
      }),
    });
    expect(st.canonical?.needsReview).toBe(true);
    expect(st.canonical?.status).toBe("MINOR_DRIFT");
  });
});

// ─── status strip states ─────────────────────────────────────────────────

describe("BsCanonicalStatusStrip — RECONCILED (auto-adjusted)", () => {
  it("renders the calm green chip labeled 'Reconciled' (sv1: NEVER a balanced-family word) with the auto-adjusted micro-caption; no receipt until tapped", () => {
    render(<BsCanonicalStatusStrip meta={reconciledMeta()} currency="RON" periodId="p1" />);

    const strip = screen.getByTestId("bs-status-reconciled");
    expect(strip).toBeInTheDocument();
    // sv1 locked invariant (engine.serving.present_status, mirrored by
    // servedFacts.presentStatus): the RECONCILED display string is
    // "Reconciled" — never a 'balanced'-family label in any language.
    expect(strip.textContent).toContain("Reconciled");
    expect(strip.textContent!.toLowerCase()).not.toMatch(/balanc/);
    // …plus the subtle micro-caption with the adjusted amount.
    const caption = screen.getByTestId("bs-auto-adjusted-caption");
    expect(caption.textContent).toContain("auto-adjusted");
    expect(caption.textContent).toContain("46.61");
    // Receipt is hidden until the chip is tapped.
    expect(screen.queryByTestId("bs-reconcile-receipt")).toBeNull();
    expectNoReconcileButton();
  });

  it("tapping the chip toggles the one-line receipt (amount · placement · verified · origin · Undo)", () => {
    render(<BsCanonicalStatusStrip meta={reconciledMeta()} currency="RON" periodId="p1" />);

    const chip = screen.getByTestId("bs-reconciled-chip");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    const receipt = screen.getByTestId("bs-reconcile-receipt");
    expect(receipt.textContent).toContain("46.61");
    expect(receipt.textContent).toContain("moved to Diferențe de reconciliere (balance sheet)");
    expect(receipt.textContent).toContain("verified against source");
    expect(receipt.textContent).toContain("deterministic");
    expect(screen.getByTestId("bs-reconcile-undo")).toBeEnabled();

    // Second tap hides it again.
    fireEvent.click(chip);
    expect(screen.queryByTestId("bs-reconcile-receipt")).toBeNull();
  });

  it("P&L placement labels the receipt with the P&L line", () => {
    render(
      <BsCanonicalStatusStrip meta={reconciledMeta("pnl")} currency="RON" periodId="p1" />,
    );
    fireEvent.click(screen.getByTestId("bs-reconciled-chip"));
    expect(screen.getByTestId("bs-reconcile-receipt").textContent).toContain(
      "moved to Diferențe de reconciliere (P&L)",
    );
  });

  it("prefers-reduced-motion: the receipt toggle is instant", () => {
    setReducedMotion(true);
    render(<BsCanonicalStatusStrip meta={reconciledMeta()} currency="RON" periodId="p1" />);
    // Synchronous assertions right after the click — no waiting, no morph.
    fireEvent.click(screen.getByTestId("bs-reconciled-chip"));
    expect(screen.getByTestId("bs-reconcile-receipt")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("bs-reconciled-chip"));
    expect(screen.queryByTestId("bs-reconcile-receipt")).toBeNull();
  });
});

describe("BsCanonicalStatusStrip — Undo", () => {
  it("Undo swaps to the honest raw state showing the TRUE source imbalance", async () => {
    vi.spyOn(cfoApi, "undoReconcilePeriod").mockResolvedValue(rawDriftCanonicalBs());

    render(<BsCanonicalStatusStrip meta={reconciledMeta()} currency="RON" periodId="p1" />);
    fireEvent.click(screen.getByTestId("bs-reconciled-chip"));
    fireEvent.click(screen.getByTestId("bs-reconcile-undo"));

    // The honest raw state: plain MINOR_DRIFT strip with the true delta.
    await waitFor(() =>
      expect(screen.getByTestId("bs-status-minor-drift")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("bs-status-minor-drift").textContent).toContain("-46.61");
    expect(screen.queryByTestId("bs-status-reconciled")).toBeNull();
    // The undo must never re-trigger a manual flow.
    expectNoReconcileButton();

    expect(cfoApi.undoReconcilePeriod).toHaveBeenCalledWith("p1");
    // The ['period', id] cache entry is reset so the statement refetches
    // (the server suppresses re-auto-reconcile after an explicit undo).
    expect(queryClient.resetQueries).toHaveBeenCalledWith({ queryKey: ["period", "p1"] });
  });

  it("a failed undo keeps the RECONCILED state and shows a calm inline note", async () => {
    vi.spyOn(cfoApi, "undoReconcilePeriod").mockRejectedValue(new Error("network down"));

    render(<BsCanonicalStatusStrip meta={reconciledMeta()} currency="RON" periodId="p1" />);
    fireEvent.click(screen.getByTestId("bs-reconciled-chip"));
    fireEvent.click(screen.getByTestId("bs-reconcile-undo"));

    const note = await screen.findByTestId("bs-reconcile-error");
    expect(note.textContent).toContain("undo");
    expect(screen.getByTestId("bs-status-reconciled")).toBeInTheDocument();
  });
});

describe("BsCanonicalStatusStrip — needs_review", () => {
  it("renders the calm amber 'Needs manual mapping' panel with the diagnosis line — no button, no modal", () => {
    render(
      <BsCanonicalStatusStrip
        meta={baseMeta({
          needsReview: true,
          diagnosis: [
            { code: "D2_FINGERPRINT", detail: "account 4511 amount 46.61 ≈ difference" },
          ],
        })}
        currency="RON"
        periodId="p1"
      />,
    );

    const panel = screen.getByTestId("bs-status-needs-review");
    expect(panel.textContent).toContain("Needs manual mapping");
    expect(panel.textContent).toContain("D2_FINGERPRINT — account 4511 amount 46.61 ≈ difference");
    expect(panel.textContent).toContain("-46.61");
    // No interactive affordance of any kind.
    expect(screen.queryByRole("button")).toBeNull();
    expectNoReconcileButton();
  });
});

describe("BsCanonicalStatusStrip — no Reconcile button in ANY state", () => {
  it.each([
    ["BALANCED", baseMeta({ status: "BALANCED", difference: 0 })],
    ["MINOR_DRIFT (plain)", baseMeta()],
    [
      "MATERIAL_IMBALANCE",
      baseMeta({
        status: "MATERIAL_IMBALANCE",
        difference: -5_000,
        diagnosis: [{ code: "D1_UNMAPPED", detail: "unmapped accounts" }],
      }),
    ],
    ["RECONCILED", reconciledMeta()],
    ["needs_review", baseMeta({ needsReview: true })],
  ])("%s renders without a Reconcile button or offer chip", (_label, meta) => {
    render(<BsCanonicalStatusStrip meta={meta} currency="RON" periodId="p1" />);
    expectNoReconcileButton();
  });

  it("MINOR_DRIFT without needs_review keeps the unchanged plain strip", () => {
    render(<BsCanonicalStatusStrip meta={baseMeta()} currency="RON" periodId="p1" />);
    expect(screen.getByTestId("bs-status-minor-drift")).toBeInTheDocument();
    expect(screen.queryByTestId("bs-status-needs-review")).toBeNull();
  });

  it("MATERIAL_IMBALANCE stays the blocking red alert (unchanged)", () => {
    render(
      <BsCanonicalStatusStrip
        meta={baseMeta({
          status: "MATERIAL_IMBALANCE",
          difference: -5_000,
          diagnosis: [{ code: "D1_UNMAPPED", detail: "unmapped accounts" }],
        })}
        currency="RON"
        periodId="p1"
      />,
    );
    const alert = screen.getByTestId("bs-status-material-imbalance");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("D1_UNMAPPED");
  });
});

// ─── synthetic row marker in the full statement view ─────────────────────

describe("BSStatementView — synthetic row marker", () => {
  it("renders the visible marker with the rationale · origin · timestamp tooltip", () => {
    const statement = buildBSStatement({
      lineItems: [],
      entity: "Test SRL",
      asOf: "31.12.2025",
      comparativeDate: "01.01.2025",
      currency: "RON",
      canonicalBs: reconciledCanonicalBs(),
    });

    render(
      <MemoryRouter>
        <BSStatementView statement={statement} hideGuide periodId="p1" />
      </MemoryRouter>,
    );

    const marker = screen.getByTestId("bs-synthetic-marker");
    expect(marker).toBeInTheDocument();
    expect(marker.getAttribute("title")).toBe(`${RATIONALE} · deterministic · ${APPLIED_AT}`);
  });

  it("P&L placement: no BS row → no empty marker anchor renders", () => {
    const statement = buildBSStatement({
      lineItems: [],
      entity: "Test SRL",
      asOf: "31.12.2025",
      comparativeDate: "01.01.2025",
      currency: "RON",
      canonicalBs: reconciledPnlPlacementCanonicalBs(),
    });

    render(
      <MemoryRouter>
        <BSStatementView statement={statement} hideGuide periodId="p1" />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId("bs-synthetic-marker")).toBeNull();
    // The strip still shows the calm reconciled chip.
    expect(screen.getByTestId("bs-status-reconciled")).toBeInTheDocument();
  });
});
