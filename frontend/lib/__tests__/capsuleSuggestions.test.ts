/**
 * THE CAPSULE — suggestion engine gate (Part D).
 *
 * Four things this suite exists to make impossible:
 *
 *   S1  a figure in a suggestion. Money reaches the DOM through
 *       Amount / NarrativeText with provenance or it does not reach it;
 *       a palette row renders neither, so it carries no figure. The
 *       `Finding.title` probe below is the one that matters — the
 *       resolved narrative is exactly where a source-currency numeral
 *       would sneak in.
 *   S2  an invented basis. Every suggestion names where it came from,
 *       and the covenant row admits its test is a default.
 *   S3  filler. A state that yields one question renders one.
 *   S4  drift. Same snapshot, same three rows, same order — asserted by
 *       re-running the builder, not by snapshotting it.
 */
import { describe, expect, it } from "vitest";

import {
  CAPSULE_COVENANT_TESTS,
  EMPTY_SNAPSHOT,
  MAX_SUGGESTIONS,
  buildCapsuleContext,
  buildCapsuleSuggestions,
  looksLikeFigure,
  pickLabel,
  seedFindings,
  tightestCovenant,
  trustVariant,
  type CapsuleFindingSeed,
  type CapsuleWorkspaceSnapshot,
} from "@/lib/capsuleSuggestions";
import type { FindingsReport } from "@/lib/findings";

// ── builders ───────────────────────────────────────────────────────────

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

function finding(over: Partial<CapsuleFindingSeed> = {}): CapsuleFindingSeed {
  return { key: "f1", severity: "high", subject: "Receivables provision", ...over };
}

/** A `FindingsReport`-shaped object with one surfaced row. Only the
 *  fields `seedFindings` reads are populated — the adapter must not
 *  depend on anything else. */
function reportWith(
  elements: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): FindingsReport {
  return {
    surfaced: [
      {
        key: "rule.x:scope",
        effectiveSeverity: "high",
        elements,
        ...extra,
      },
    ],
    info: [],
    demoted: [],
    checks: [],
  } as unknown as FindingsReport;
}

// ── S1: the figure guard ───────────────────────────────────────────────

describe("S1 — looksLikeFigure", () => {
  it("refuses amounts in every shape a presenter produces", () => {
    const amounts = [
      "1,553,210 RON",
      "1.553.210",
      "1 553 210",
      "RON 461",
      "461 lei",
      "12%",
      "3.2×",
      "€ 12",
      "$4",
      "0,87",
      "1.24",
      "EBITDA 12.5",
    ];
    for (const a of amounts) {
      expect(looksLikeFigure(a), `should refuse: ${a}`).toBe(true);
    }
  });

  it("allows account codes and ordinary labels — a code is an identity", () => {
    const labels = [
      "Receivables provision",
      "Cont 461 — Debitori diverși",
      "5121 Conturi la bănci în lei",
      "Provizioane pentru creanțe",
      "Current ratio",
      "DSCR",
      "Dec 2025",
      "FY2025",
    ];
    for (const l of labels) {
      expect(looksLikeFigure(l), `should allow: ${l}`).toBe(false);
    }
  });

  it("pickLabel walks the chain and returns null when every candidate fails", () => {
    expect(pickLabel([null, "", "  ", "Inventory provisions"])).toBe("Inventory provisions");
    expect(pickLabel(["1.553.210 RON", "12%"])).toBeNull();
    expect(pickLabel([])).toBeNull();
    // Too long to sit in a row.
    expect(pickLabel(["x".repeat(200)])).toBeNull();
  });
});

describe("S1 — seedFindings never reads the resolved narrative", () => {
  it("prefers the threshold's parameter label", () => {
    const seeds = seedFindings(
      reportWith(
        {
          threshold: { parameter_label: "Receivables provision" },
          impact: { metric_label: "Current ratio" },
          subject: { accounts: [{ name: "Clienți" }], scope: "receivables" },
        },
        { title: "Provisions are 1.553.210 RON — 22% of gross" },
      ),
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0].subject).toBe("Receivables provision");
  });

  it("falls down the chain when a label is figure-shaped", () => {
    const seeds = seedFindings(
      reportWith({
        threshold: { parameter_label: "22% of gross" },
        impact: { metric_label: "Current ratio" },
      }),
    );
    expect(seeds[0].subject).toBe("Current ratio");
  });

  it("drops the finding entirely when every label is figure-shaped", () => {
    const seeds = seedFindings(
      reportWith(
        {
          threshold: { parameter_label: "22%" },
          impact: { metric_label: "1.553.210 RON" },
          subject: { accounts: [{ name: "3,2×" }], scope: "0,87" },
        },
        { title: "Perfectly readable headline" },
      ),
    );
    expect(seeds).toEqual([]);
  });

  it("a null report yields nothing rather than throwing", () => {
    expect(seedFindings(null)).toEqual([]);
  });
});

describe("S1 — no suggestion carries a figure", () => {
  it("holds across every kind, both modes", () => {
    const s = snapshot({
      findings: [finding()],
      trustBand: "material_imbalance",
      metrics: [{ name: "dscr", value: 1.1, unit: "ratio" }],
      unattached: [{ periodId: "p1", label: "Nov 2025" }],
    });
    for (const mode of ["simple", "pro"] as const) {
      for (const row of buildCapsuleSuggestions(s, mode)) {
        for (const [k, v] of Object.entries(row.labelParams)) {
          expect(looksLikeFigure(v), `${row.id}.${k} = ${v}`).toBe(false);
        }
      }
    }
  });

  it("a figure-shaped period label kills the row rather than printing it", () => {
    const rows = buildCapsuleSuggestions(
      snapshot({ periodLabel: "1.553.210", trustBand: "material_imbalance" }),
      "pro",
    );
    expect(rows.find((r) => r.kind === "trust")).toBeUndefined();
  });
});

// ── S2: every row names its basis ──────────────────────────────────────

describe("S2 — provenance", () => {
  it("every suggestion carries a basis key", () => {
    const rows = buildCapsuleSuggestions(
      snapshot({
        findings: [finding()],
        trustBand: "minor_drift",
        metrics: [{ name: "current_ratio", value: 1.2, unit: "ratio" }],
        unattached: [{ periodId: "p1", label: "Nov 2025" }],
        silence: false,
      }),
      "pro",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.basisKey).toBe(`capsuleEmpty.basis.${row.kind}`);
    }
  });

  it("the covenant tests are declared data, not thresholds hidden in a branch", () => {
    expect(CAPSULE_COVENANT_TESTS.length).toBeGreaterThan(0);
    for (const test of CAPSULE_COVENANT_TESTS) {
      expect(test.threshold).toBeGreaterThan(0);
      expect(test.band).toBeGreaterThan(0);
      expect(["min", "max"]).toContain(test.direction);
    }
  });
});

// ── S3: absent is not zero, fewer is not filler ────────────────────────

describe("S3 — fewer, not filler", () => {
  it("an empty snapshot yields nothing at all", () => {
    expect(buildCapsuleSuggestions(EMPTY_SNAPSHOT, "simple")).toEqual([]);
    expect(buildCapsuleSuggestions(EMPTY_SNAPSHOT, "pro")).toEqual([]);
  });

  it("a clean, balanced, finding-free period yields nothing", () => {
    expect(buildCapsuleSuggestions(snapshot(), "pro")).toEqual([]);
  });

  it("one available signal yields exactly one row", () => {
    const rows = buildCapsuleSuggestions(snapshot({ findings: [finding()] }), "simple");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("finding");
  });

  it("never returns more than three", () => {
    const rows = buildCapsuleSuggestions(
      snapshot({
        findings: [finding({ severity: "critical" })],
        trustBand: "material_imbalance",
        metrics: [
          { name: "dscr", value: 1.0, unit: "ratio" },
          { name: "current_ratio", value: 1.0, unit: "ratio" },
        ],
        unattached: [{ periodId: "p1", label: "Nov 2025" }],
      }),
      "pro",
    );
    expect(rows.length).toBe(MAX_SUGGESTIONS);
  });

  it("a null metric produces no covenant candidate (absent is not zero)", () => {
    expect(tightestCovenant([{ name: "dscr", value: null, unit: "ratio" }])).toBeNull();
    expect(tightestCovenant([{ name: "dscr", value: Number.NaN, unit: "ratio" }])).toBeNull();
    expect(tightestCovenant([])).toBeNull();
  });

  it("a comfortable metric produces no covenant candidate", () => {
    // DSCR far above the 1.25 default test — nothing to ask about.
    expect(tightestCovenant([{ name: "dscr", value: 4.0, unit: "ratio" }])).toBeNull();
  });

  it("a balanced or unverified period earns no trust question", () => {
    expect(trustVariant("balanced")).toBeNull();
    expect(trustVariant("unverified")).toBeNull();
    expect(trustVariant(null)).toBeNull();
  });

  it("silence is a result, and never competes with a surfaced finding", () => {
    const withBoth = buildCapsuleSuggestions(
      snapshot({ silence: true, findings: [finding()] }),
      "pro",
    );
    expect(withBoth.map((r) => r.kind)).toEqual(["finding"]);

    const silent = buildCapsuleSuggestions(snapshot({ silence: true }), "pro");
    expect(silent.map((r) => r.kind)).toEqual(["silence"]);
  });
});

// ── S4: deterministic ordering ─────────────────────────────────────────

describe("S4 — determinism and ranking", () => {
  const busy = snapshot({
    findings: [finding({ severity: "critical" })],
    trustBand: "reconciled",
    metrics: [{ name: "dscr", value: 1.2, unit: "ratio" }],
    unattached: [{ periodId: "p1", label: "Nov 2025" }],
  });

  it("is a function of its arguments", () => {
    const a = buildCapsuleSuggestions(busy, "pro");
    const b = buildCapsuleSuggestions(busy, "pro");
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });

  it("ranks a critical finding above an unattached period above a covenant", () => {
    expect(buildCapsuleSuggestions(busy, "pro").map((r) => r.kind)).toEqual([
      "finding",
      "unattached",
      "covenant",
    ]);
  });

  it("a material imbalance outranks everything but a critical finding", () => {
    const rows = buildCapsuleSuggestions(
      snapshot({
        findings: [finding({ severity: "medium" })],
        trustBand: "material_imbalance",
        unattached: [{ periodId: "p1", label: "Nov 2025" }],
      }),
      "pro",
    );
    expect(rows[0].kind).toBe("trust");
  });

  it("rows sort by priority descending", () => {
    const rows = buildCapsuleSuggestions(busy, "pro");
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].priority).toBeGreaterThanOrEqual(rows[i].priority);
    }
  });

  it("picks the TIGHTEST covenant when several are close", () => {
    const tight = tightestCovenant([
      { name: "dscr", value: 1.25, unit: "ratio" }, // headroom 0.00
      { name: "current_ratio", value: 1.44, unit: "ratio" }, // headroom 0.20
    ]);
    expect(tight?.test.id).toBe("dscr");
  });

  it("a metric already past its test still ranks (negative headroom)", () => {
    const tight = tightestCovenant([{ name: "net_debt_to_ebitda", value: 5.0, unit: "ratio" }]);
    expect(tight?.test.id).toBe("leverage");
    expect(tight!.headroom).toBeLessThan(0);
  });
});

// ── Mode-aware phrasing ────────────────────────────────────────────────

describe("mode awareness", () => {
  const s = snapshot({ findings: [finding()], metrics: [{ name: "dscr", value: 1.2, unit: "ratio" }] });

  it("keys diverge by mode and carry the mode they were built for", () => {
    const simple = buildCapsuleSuggestions(s, "simple");
    const pro = buildCapsuleSuggestions(s, "pro");
    expect(simple.map((r) => r.labelKey)).not.toEqual(pro.map((r) => r.labelKey));
    for (const r of simple) {
      expect(r.mode).toBe("simple");
      expect(r.labelKey.endsWith(".simple")).toBe(true);
    }
    for (const r of pro) {
      expect(r.mode).toBe("pro");
      expect(r.labelKey.endsWith(".pro")).toBe(true);
    }
  });

  it("the same rows are OFFERED in both modes — phrasing changes, membership does not", () => {
    expect(buildCapsuleSuggestions(s, "simple").map((r) => r.kind)).toEqual(
      buildCapsuleSuggestions(s, "pro").map((r) => r.kind),
    );
  });
});

// ── The context zone ───────────────────────────────────────────────────

describe("buildCapsuleContext", () => {
  it("reports no period rather than inventing one", () => {
    const ctx = buildCapsuleContext(EMPTY_SNAPSHOT);
    expect(ctx.periodLabel).toBeNull();
    expect(ctx.unverified).toBe(false);
  });

  it("marks a loaded period with no verdict as unverified", () => {
    expect(buildCapsuleContext(snapshot({ trustBand: null })).unverified).toBe(true);
    expect(buildCapsuleContext(snapshot({ trustBand: "unverified" })).unverified).toBe(true);
    expect(buildCapsuleContext(snapshot({ trustBand: "balanced" })).unverified).toBe(false);
  });

  it("a loaded period whose label was refused is still LOADED", () => {
    // The two flags must not be conflated: telling the reader "no period
    // loaded" while one is open would be a false statement about their
    // own workspace.
    const ctx = buildCapsuleContext(snapshot({ periodLabel: "1.553.210" }));
    expect(ctx.hasPeriod).toBe(true);
    expect(ctx.periodLabel).toBeNull();
    expect(buildCapsuleContext(EMPTY_SNAPSHOT).hasPeriod).toBe(false);
  });

  it("counts rows, and refuses a figure-shaped period label", () => {
    const ctx = buildCapsuleContext(
      snapshot({
        periodLabel: "1.553.210",
        findings: [finding(), finding({ key: "f2" })],
        unattached: [{ periodId: "p1", label: "Nov 2025" }],
      }),
    );
    expect(ctx.periodLabel).toBeNull();
    expect(ctx.findingCount).toBe(2);
    expect(ctx.unattachedCount).toBe(1);
  });
});
