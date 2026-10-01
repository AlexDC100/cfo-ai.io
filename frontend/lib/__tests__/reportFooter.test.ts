// report-footer — THE LAST LINES OF A REPORT ARE TRUE FOR THAT REPORT.
//
// Until 2026-10-01 every report ended with three hard-coded sentences:
// "…deterministic engine + Claude Opus 4.7 narrative. Numbers reconcile to
// the source trial balance within 0.5%. Benchmarks carry source +
// confidence labels — see Section 5." One calibration book is SERVED with a
// material imbalance, Section 5 is Ratios, and the model was credited on a
// report with no briefing. The public sample report would have carried the
// same words.
//
// THE LAW (part of battery gate `public-claims`)
//   F1  a balanced book prints the engine's balanced verdict and a zero
//       difference — no tolerance, no percentage;
//   F2  a book served with an imbalance prints THAT status and the served
//       difference to the cent, in the reader's number format, code after
//       the figure;
//   F3  a period with no engine verdict says so;
//   F4  the narrative is credited only when a briefing is shown, and no
//       model version is named;
//   F5  the page renders the footer from this builder, and none of the
//       three retired sentences is back in its source.
//
// REDS ON, AFTER THE REPAIR: "within 0.5%" (or any typed tolerance) in the
// footer; a model name; "Section 5"; a balanced verdict printed over an
// imbalanced book; a difference that is not the served one.
// CANNOT SEE: whether the served difference itself is right (bs-drift), or
// footer text a future page adds outside this builder (F5 scans one file).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { reportFooterLines } from "@/lib/reportFooter";
import { foreignNumber } from "@/test/numberLanguage";

const REPO = resolve(__dirname, "../../..");

/** A served canonical balance sheet, as GET /api/period carries it. Every
 *  figure in this file is invented — no book's numbers are used. */
function canonical(status: string, difference: number, assets: number) {
  return {
    schema_version: "bs_v2",
    status,
    difference,
    totals: {
      assets, equity: assets * 0.5 - difference / 2, liabilities: assets * 0.5 - difference / 2,
      equity_plus_liabilities: assets - difference,
      current_assets: assets * 0.4, non_current_assets: assets * 0.6,
      current_liabilities: assets * 0.3, non_current_liabilities: assets * 0.2,
    },
    sections: [], rows: [], invariants: { identity_holds: true },
    provenance: { mapping_version: "test" },
  };
}

const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

describe("report footer — only what is true for this report", () => {
  it("F1 a balanced book: the engine's verdict and a zero difference, no tolerance", () => {
    const f = reportFooterLines({
      statements: { canonical_bs: canonical("BALANCED", 0, 1_000_000) },
      currency: "RON", briefingShown: false, language: "en",
    });
    expect(f.machineStatus).toBe("BALANCED");
    expect(f.balance).toMatch(/^Balance check: /);
    expect(f.balance).toMatch(/Assets = Equity \+ Liabilities/);
    expect(plain(f.differenceLine)).toBe("Assets − (Equity + Liabilities) = 0.00 RON on this report.");
    const all = plain(`${f.generated} ${f.balance} ${f.differenceLine}`);
    expect(all).not.toMatch(/%|within|reconcile to the source/i);
  });

  it("F2 an imbalanced book: that status and the served difference to the cent", () => {
    const en = reportFooterLines({
      statements: { canonical_bs: canonical("MATERIAL_IMBALANCE", -1234.56, 500_000) },
      currency: "RON", briefingShown: false, language: "en",
    });
    expect(en.machineStatus).toBe("MATERIAL_IMBALANCE");
    expect(en.balance).toMatch(/Material imbalance/);
    expect(en.balance).not.toMatch(/passed|Balanced\b/);
    expect(plain(en.differenceLine)).toContain("-1,234.56 RON");
    expect(foreignNumber(plain(en.differenceLine), "en")).toBeNull();

    // the figure follows the reader's language; the code stays after it
    const ro = reportFooterLines({
      statements: { canonical_bs: canonical("MATERIAL_IMBALANCE", -1234.56, 500_000) },
      currency: "RON", briefingShown: false, language: "ro",
    });
    expect(plain(ro.differenceLine)).toContain("-1.234,56 RON");
    expect(foreignNumber(plain(ro.differenceLine), "ro")).toBeNull();
    expect(plain(ro.differenceLine)).not.toMatch(/\blei\b|RON\s*-?\d/);

    const drift = reportFooterLines({
      statements: { canonical_bs: canonical("MINOR_DRIFT", 0.05, 1_000_000) },
      currency: "RON", briefingShown: false, language: "en",
    });
    expect(drift.machineStatus).toBe("MINOR_DRIFT");
    expect(plain(drift.differenceLine)).toContain("0.05 RON");
  });

  it("F3 a period with no engine verdict says so, and prints no difference", () => {
    const f = reportFooterLines({ statements: {}, currency: "RON", briefingShown: false, language: "en" });
    expect(f.machineStatus).toBe("UNVERIFIED");
    expect(f.balance).toMatch(/not engine-verified/);
    expect(f.differenceLine).toBe("No engine balance verdict exists for this period.");
    expect(f.differenceLine).not.toMatch(/\d/);
  });

  it("F3 a served verdict without its totals block still prints the served status and difference", () => {
    const f = reportFooterLines({
      statements: { canonical_bs: { status: "MATERIAL_IMBALANCE", difference: -1234.56 } },
      currency: "RON", briefingShown: false, language: "en",
    });
    expect(f.machineStatus).toBe("MATERIAL_IMBALANCE");
    expect(plain(f.differenceLine)).toContain("-1,234.56 RON");
    const none = reportFooterLines({
      statements: { canonical_bs: { status: "MINOR_DRIFT" } },
      currency: "RON", briefingShown: false, language: "en",
    });
    expect(none.differenceLine).toMatch(/^Difference: not stated/);
  });

  it("F4 credits the narrative only when a briefing is shown, and names no model version", () => {
    const base = { statements: { canonical_bs: canonical("BALANCED", 0, 1_000_000) }, currency: "RON", language: "en" };
    const without = reportFooterLines({ ...base, briefingShown: false });
    const withBriefing = reportFooterLines({ ...base, briefingShown: true });
    expect(without.generated).not.toMatch(/AI model|narrative|briefing/i);
    expect(withBriefing.generated).toMatch(/briefing .* written by an AI model/);
    for (const f of [without, withBriefing]) {
      expect(f.generated).not.toMatch(/Claude|Opus|Sonnet|GPT|\d+\.\d+/);
      expect(f.generated).toMatch(/deterministic engine/);
    }
  });

  it("F5 the report page renders this footer and none of the retired sentences", () => {
    const src = readFileSync(join(REPO, "frontend/pages/cfo/ComprehensiveReport.tsx"), "utf8");
    // comments quote the retired sentences on purpose; the JSX may not
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");
    expect(code).toContain("reportFooterLines(");
    expect(code).toContain('data-testid="report-footer"');
    const footer = /<footer[\s\S]*?<\/footer>/.exec(code)?.[0] ?? "";
    expect(footer.length, "no <footer> in the report page").toBeGreaterThan(50);
    expect(footer).toContain("{footer.generated}");
    expect(footer).toContain("{footer.balance}");
    expect(footer).toContain("{footer.differenceLine}");
    // nothing typed in the footer but the three served lines
    const typed = footer.replace(/<[^>]+>/g, " ").replace(/\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();
    expect(typed, `text typed into the report footer: "${typed}"`).toBe("");
    expect(code).not.toMatch(/within 0\.5%|see Section 5|Opus 4\.7 narrative/);
    console.log("GATE-WORK report-footer laws=6");
  });
});
