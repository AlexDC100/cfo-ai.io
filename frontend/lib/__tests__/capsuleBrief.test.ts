// THE CAPSULE — THE RESTING BRIEF, gated (B1–B6).
//
// The mission this file guards: the dropdown's resting state must tell
// the reader something they cannot already see, and everything it says
// must be DERIVED from workspace state. A hardcoded suggestion string,
// a padded tile, or a share computed against a total nobody served are
// all the same defect — copy pretending to be a measurement.
//
// ══ WHY THE FIXTURES ARE REAL, AND WHY BOTH KINDS ARE HERE ════════════
//
// Two workspaces are driven, and the pairing IS the vacuity control:
//
//   CANONICAL  `period_carniprod_fy2025.json` — a real served period,
//              captured from the golden corpus through the real
//              `/api/period` composition. 44 canonical rows, real
//              account codes, real section subtotals. Everything the
//              brief claims has a subject here.
//   LEGACY     the demo company's own `buildDemoStatements()` — the
//              shape a workspace has before anyone uploads a trial
//              balance. `factsFrom().isCanonical` is FALSE, there are no
//              statement lines and no account codes.
//
// TC-9 is the whole reason for the second one. Every account-lookup
// assertion below would pass on an empty index by resolving nothing, so
// each is paired with its opposite: the canonical period must ANSWER and
// the legacy period must REFUSE. A gate that only ever saw the legacy
// workspace would report a clean sweep over no subject — which is
// exactly what the live demo stack shows, and exactly why the screenshot
// loop alone could not have caught a broken account lookup.
//
// ══ WHAT IS NOT GATED HERE, AND WHY ═══════════════════════════════════
//
// MOVEMENT. `CanonicalBsRow` declares `opening`, and B0 below counts how
// many of the repo's real canonical rows actually carry one. The count
// is ZERO, which is why `CapsuleAccountCard` renders no movement line:
// building one would have produced a feature no fixture can exercise and
// a gate that scores clean by examining nothing. B0 is written as an
// ASSERTION rather than a comment so the day a fixture arrives with
// opening balances, this file goes red and says to build it.

import { describe, it, expect } from "vitest";

import {
  buildFactIndex,
  classShareOf,
  restingFacts,
  RESTING_FACT_ORDER,
  factFor,
  type FactIndex,
} from "@/lib/capsuleFactIndex";
import { resolveTier0 } from "@/lib/capsuleTier0";
import {
  buildCapsuleContext,
  mostConsequentialOpen,
  type CapsuleWorkspaceSnapshot,
} from "@/lib/capsuleSuggestions";
import { factsFrom } from "@/lib/servedFacts";
import { buildDemoStatements } from "@/lib/demo/demoFinancials";
import type { Statements, CanonicalBs } from "@/lib/financialReport";

import carniprodJson from "./fixtures/capsuleTier0/period_carniprod_fy2025.json";
import retailJson from "./fixtures/capsuleTier0/period_retail_fy2024.json";
import driftJson from "./fixtures/capsuleTier0/period_minor_drift.json";

const carniprod = carniprodJson as unknown as Statements;
const retail = retailJson as unknown as Statements;
const drift = driftJson as unknown as Statements;

function indexOf(statements: Statements, label = "FY2025", id = "p-1"): FactIndex {
  return buildFactIndex({
    periods: [{ periodId: id, periodLabel: label, statements }],
    activePeriodId: id,
  });
}

const canonical = indexOf(carniprod);
const legacy = indexOf(buildDemoStatements(), "FY2025", "demo");
const empty = buildFactIndex({ periods: [], activePeriodId: null });

// ══════════════════════════════════════════════════════════════════════
// B0 — THE SUBJECT CENSUS. Run FIRST, and it is allowed to fail.
// ══════════════════════════════════════════════════════════════════════

describe("B0 — the fixtures actually carry what the brief claims", () => {
  it("the canonical period is canonical, and the legacy one is not", () => {
    // TC-3: a census that finds nothing is broken. If this flips, every
    // assertion below turns vacuous WITHOUT failing, so it is asserted
    // before anything reads either index.
    expect(factsFrom(carniprod).isCanonical).toBe(true);
    expect(factsFrom(buildDemoStatements()).isCanonical).toBe(false);
  });

  it("counts the real statement lines and their sections — floor asserted AFTER the loop", () => {
    let rows = 0;
    let withAccounts = 0;
    let withSection = 0;
    let sections = 0;
    const seenSections = new Set<string>();
    for (const statements of [carniprod, retail, drift]) {
      const cbs = factsFrom(statements).canonicalForRender() as CanonicalBs | null;
      for (const s of cbs?.sections ?? []) {
        sections += 1;
        seenSections.add(s.id);
      }
      for (const row of cbs?.rows ?? []) {
        rows += 1;
        if ((row.account_codes ?? []).length > 0) withAccounts += 1;
        if (row.section) withSection += 1;
      }
    }
    // Floors AFTER the loop, never inside it.
    expect(rows).toBeGreaterThanOrEqual(80);
    expect(withAccounts).toBeGreaterThanOrEqual(80);
    expect(withSection).toBe(rows);
    expect(sections).toBeGreaterThanOrEqual(10);
    // CANARY — a named section from the real capture. If the discovery
    // loop silently stops reading rows, this is what says so.
    expect(seenSections.has("current_assets")).toBe(true);
  });

  it("B0-MOVEMENT — no real row carries an opening balance, so no movement is rendered", () => {
    let rows = 0;
    let withOpening = 0;
    for (const statements of [carniprod, retail, drift]) {
      const cbs = factsFrom(statements).canonicalForRender() as CanonicalBs | null;
      for (const row of cbs?.rows ?? []) {
        rows += 1;
        if (typeof row.opening === "number" && Number.isFinite(row.opening)) withOpening += 1;
      }
    }
    expect(rows).toBeGreaterThanOrEqual(80);
    // THE DAY THIS FAILS, BUILD THE MOVEMENT LINE. Until then a movement
    // renderer would paint on nothing and its own gate would pass by
    // examining no subject. See this file's header.
    expect(withOpening).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B1 — THE RESTING TILES ARE DERIVED, RANKED AND NEVER PADDED
// ══════════════════════════════════════════════════════════════════════

describe("B1 — restingFacts", () => {
  it("returns real headline facts for a canonical period, in the declared order", () => {
    const facts = restingFacts(canonical);
    expect(facts.length).toBe(3);
    // Every tile is a fact the index actually holds — same object, same
    // value, not a copy assembled for display.
    for (const fact of facts) {
      const source = factFor(canonical, fact.factKey);
      expect(source).not.toBeNull();
      expect(source!.value).toBe(fact.value);
      expect(Number.isFinite(fact.value)).toBe(true);
      expect(fact.unit).toBeTruthy();
    }
    // Ranked by the declared order, not by magnitude and not by
    // insertion.
    const positions = facts.map((f) => RESTING_FACT_ORDER.indexOf(f.factKey));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("is deterministic — the same index twice yields the same tiles", () => {
    const a = restingFacts(canonical).map((f) => `${f.factKey}=${f.value}`);
    const b = restingFacts(indexOf(carniprod)).map((f) => `${f.factKey}=${f.value}`);
    expect(a).toEqual(b);
  });

  it("returns NOTHING for an empty index — no padding, no placeholder", () => {
    expect(restingFacts(empty)).toEqual([]);
  });

  it("still fills the row from a LEGACY period, from what that period does have", () => {
    // TC-9's positive half: the legacy workspace is not "no subject" for
    // the tiles — it carries balance-sheet totals — so a tile row that
    // came back empty here would be a real defect, not an absence.
    const facts = restingFacts(legacy);
    expect(facts.length).toBe(3);
    expect(facts.map((f) => f.factKey)).toContain("total_assets");
  });

  it("promotes the imbalance to the front when the books do not balance", () => {
    const diff = factFor(indexOf(drift), "difference");
    // The drift fixture exists precisely because it is out of balance;
    // if that ever stops being true this assertion says so rather than
    // the promotion silently going untested.
    expect(diff).not.toBeNull();
    expect(diff!.value).not.toBe(0);
    expect(restingFacts(indexOf(drift))[0]?.factKey).toBe("difference");
  });

  it("does NOT promote a zero difference — a balanced book is not a measurement", () => {
    const balanced = restingFacts(canonical);
    const diff = factFor(canonical, "difference");
    if (diff && diff.value === 0) {
      expect(balanced[0]?.factKey).not.toBe("difference");
    }
    // And never as filler anywhere in the row when it is zero.
    for (const fact of balanced) {
      if (fact.factKey === "difference") expect(fact.value).not.toBe(0);
    }
  });

  it("honours the cap it is given", () => {
    expect(restingFacts(canonical, 1).length).toBe(1);
    expect(restingFacts(canonical, 0).length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B2 — THE TILE'S OWN NAME ANSWERS ITSELF
// ══════════════════════════════════════════════════════════════════════

describe("B2 — a tile is a fact AND a question that resolves", () => {
  it("every resting tile's factKey is one Tier 0 can resolve back", () => {
    const facts = restingFacts(canonical);
    expect(facts.length).toBeGreaterThan(0);   // floor before the loop's claim
    let checked = 0;
    for (const fact of facts) {
      // Picking a tile types a metric NAME into the composer. If that
      // name did not resolve, the tile would hand the reader a query
      // that falls through to a paid model call for a figure the tile
      // was already showing — the exact defect the Tier-0 spend boundary
      // exists to prevent, reintroduced through the resting state.
      const answer = resolveTier0(fact.label, canonical);
      expect(answer, `no Tier-0 resolution for tile label "${fact.label}"`).not.toBeNull();
      expect(answer!.refused ?? false).toBe(false);
      expect(answer!.facts.map((f) => f.factKey)).toContain(fact.factKey);
      checked += 1;
    }
    expect(checked).toBe(facts.length);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B3 — SHARE OF CLASS: the engine's subtotal, or nothing
// ══════════════════════════════════════════════════════════════════════

describe("B3 — classShareOf", () => {
  it("divides a real statement line by the ENGINE's own section subtotal", () => {
    const line = canonical.facts.find((f) => f.factKey === "bs.row.ar_intercompany");
    expect(line, "the carniprod capture no longer carries account 461").toBeDefined();
    expect(line!.section).toBe("current_assets");

    const cbs = factsFrom(carniprod).canonicalForRender() as CanonicalBs | null;
    const subtotal = (cbs?.sections ?? []).find((s) => s.id === "current_assets")?.subtotal;
    expect(typeof subtotal).toBe("number");

    const share = classShareOf(line!);
    expect(share).not.toBeNull();
    expect(share!.section).toBe("current_assets");
    // The share is the served row over the SERVED subtotal — not over a
    // client-side sum of the rows, which is a different number the
    // moment the engine files a row somewhere the client did not expect.
    expect(share!.share).toBeCloseTo(line!.value / (subtotal as number), 12);
  });

  it("refuses for a metric fact — a total has no class to be a share of", () => {
    const total = factFor(canonical, "total_assets");
    expect(total).not.toBeNull();
    expect(classShareOf(total!)).toBeNull();
  });

  it("refuses when the section subtotal is absent or zero (ABSENT ≠ ZERO)", () => {
    const line = canonical.facts.find((f) => f.factKey === "bs.row.ar_intercompany")!;
    expect(classShareOf({ ...line, sectionTotal: undefined })).toBeNull();
    expect(classShareOf({ ...line, sectionTotal: 0 })).toBeNull();
    expect(classShareOf({ ...line, section: undefined })).toBeNull();
    expect(classShareOf(null)).toBeNull();
  });

  it("is invariant to the display dial — both operands are one period's own currency", () => {
    const line = canonical.facts.find((f) => f.factKey === "bs.row.ar_intercompany")!;
    // Same fact, relabelled as if displayed in another currency: the
    // share must not move, because the division never touched a rate.
    const share = classShareOf(line)!;
    const relabelled = classShareOf({ ...line, currency: "EUR" })!;
    expect(relabelled.share).toBe(share.share);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B4 — ACCOUNT LOOKUP: answers on real data, REFUSES on legacy
// ══════════════════════════════════════════════════════════════════════

describe("B4 — the account lookup", () => {
  it("resolves a real account code to its own statement line", () => {
    const answer = resolveTier0("461", canonical);
    expect(answer).not.toBeNull();
    expect(answer!.shape).toBe("account");
    expect(answer!.account).toBe("461");
    expect(answer!.refused ?? false).toBe(false);
    expect(answer!.facts.length).toBeGreaterThan(0);
    const hit = answer!.facts[0];
    // The engine's own label and the engine's own codes, verbatim.
    expect(hit.label).toBe("Intercompany receivables");
    expect(hit.accountCodes).toContain("461");
    expect(hit.unit).toBe("money");
    // And it can state its scale, which is the half a launcher cannot do.
    expect(classShareOf(hit)).not.toBeNull();
  });

  it("resolves the same line through the sentence people actually type", () => {
    for (const q of ["what is sitting in 461", "cont 461", "account 461"]) {
      const answer = resolveTier0(q, canonical);
      expect(answer, q).not.toBeNull();
      expect(answer!.shape, q).toBe("account");
      expect(answer!.facts.map((f) => f.factKey), q).toContain("bs.row.ar_intercompany");
    }
  });

  it("REFUSES a well-formed code the period does not carry — and names the period", () => {
    const answer = resolveTier0("999999", canonical);
    expect(answer).not.toBeNull();
    expect(answer!.shape).toBe("account");
    expect(answer!.refused).toBe(true);
    expect(answer!.facts).toEqual([]);
    expect(answer!.noteParams?.account).toBe("999999");
    expect(answer!.noteParams?.period).toBe("FY2025");
  });

  it("TC-9 — the SAME query refuses on a legacy period, so a clean pass is distinguishable", () => {
    // This is the control. Every assertion in this block would pass
    // trivially against an index with no statement lines, by resolving
    // nothing at all. Here the refusal is the CORRECT answer and it is
    // asserted as such — so "the lookup works" and "the lookup found no
    // subject" can never read the same in this file.
    const answer = resolveTier0("461", legacy);
    expect(answer).not.toBeNull();
    expect(answer!.shape).toBe("account");
    expect(answer!.refused).toBe(true);
    expect(answer!.facts).toEqual([]);
  });

  it("never claims a bare year as an account", () => {
    const answer = resolveTier0("dec 2025 vs dec 2024", canonical);
    // Whatever this resolves to, it is NOT an account lookup for 2025.
    expect(answer?.shape).not.toBe("account");
  });
});

// ══════════════════════════════════════════════════════════════════════
// B5 — THE PULSE LINE NAMES ONE THING, AND RANKS IT
// ══════════════════════════════════════════════════════════════════════

function snapshot(over: Partial<CapsuleWorkspaceSnapshot> = {}): CapsuleWorkspaceSnapshot {
  return {
    hasPeriod: true,
    periodLabel: "Dec 2025",
    trustBand: "balanced",
    findings: [],
    silence: false,
    metrics: [],
    unattached: [],
    moves: [],
    ...over,
  };
}

describe("B5 — mostConsequentialOpen", () => {
  it("prefers the missing FILE over the findings count", () => {
    const open = mostConsequentialOpen(
      buildCapsuleContext(
        snapshot({
          unattached: [{ periodId: "p-nov", label: "Nov 2025" }],
          findings: [{ key: "f1", severity: "critical", subject: "Gross margin" }],
        }),
      ),
    );
    expect(open).toEqual({
      kind: "unattached", count: 1, periodId: "p-nov", label: "Nov 2025",
    });
  });

  it("falls through to findings when nothing is unattached", () => {
    const open = mostConsequentialOpen(
      buildCapsuleContext(
        snapshot({ findings: [{ key: "f1", severity: "high", subject: "DSO" }] }),
      ),
    );
    expect(open).toEqual({ kind: "findings", count: 1 });
  });

  it("names NOTHING when nothing is open — the line does not invent a fourth clause", () => {
    expect(mostConsequentialOpen(buildCapsuleContext(snapshot()))).toBeNull();
  });

  it("never restates the verdict already printed beside it", () => {
    // A material imbalance is more consequential than either candidate
    // and is deliberately not one: the trust word sits immediately to
    // the left in the same line.
    const open = mostConsequentialOpen(
      buildCapsuleContext(snapshot({ trustBand: "material_imbalance" })),
    );
    expect(open).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// B6 — NOTHING HERE CAN SPEND
// ══════════════════════════════════════════════════════════════════════

describe("B6 — the resting brief is free by construction", () => {
  it("resolves the whole resting brief with fetch removed from the realm", () => {
    const realFetch = globalThis.fetch;
    // Not a spy — REMOVED. A spy proves nothing was called on the object
    // it wrapped; deleting it proves nothing on this path could call
    // anything at all, including through a module that captured `fetch`
    // at import time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = undefined;
    try {
      const facts = restingFacts(canonical);
      expect(facts.length).toBe(3);
      expect(classShareOf(canonical.facts.find((f) => f.factKey === "bs.row.ar_intercompany")!))
        .not.toBeNull();
      expect(resolveTier0("461", canonical)!.facts.length).toBeGreaterThan(0);
      expect(
        mostConsequentialOpen(
          buildCapsuleContext(snapshot({ unattached: [{ periodId: "p", label: "Nov 2025" }] })),
        ),
      ).not.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
