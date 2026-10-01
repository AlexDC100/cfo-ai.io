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
//       three retired sentences is back in its source;
//   F6  WHO READ THE DOCUMENT is the served extraction method: a period
//       read by an AI model says so, and says "document", never "trial
//       balance"; a map-guided read says the layout was interpreted by a
//       model; a deterministic trial-balance read says no model read or
//       produced the figures; the browser-side valuation is named as such;
//   F7  THE EXPORT IS UNDER THE SAME LAW. The standalone report
//       (lib/financialReport.ts) closes with the same authorship sentence,
//       its confidentiality line is an input, and none of the retired
//       sentences — nor "This document is AI-assisted", "as filed", "filed
//       close", "implying an opening balance" — is typed in its source or
//       printed in the published sample.
//
// 2026-10-02 — WHAT F1–F5 LET THROUGH. The first repair replaced three false
// sentences with one universal one: "Every figure is computed by the
// deterministic engine from the uploaded trial balance." A verifier called
// the builder with `extraction.method = "llm"` — the marker the statement's
// AI-read badge tests — and got that sentence back: on a period a model
// read, over a valuation section computed in the browser. And F5 scanned
// one file: the export's own footer ("This document is AI-assisted",
// "Confidential — for internal use only") was outside the law, so a planted
// "within 0.5%" in financialReport.ts reached the published sample with
// every gate green once the sample was rebuilt.
//
// REDS ON, AFTER THE REPAIR: "within 0.5%" (or any typed tolerance) in the
// footer; a model name; "Section 5"; a balanced verdict printed over an
// imbalanced book; a difference that is not the served one; "deterministic
// engine" or "trial balance" on an AI-read period; an authorship sentence
// typed into the report page or the export instead of built here; any of
// the retired sentences in financialReport.ts, its chart / shell modules or
// the published sample report.
// CANNOT SEE: whether the served difference itself is right (bs-drift);
// whether the served extraction method is right (the engine stamps it);
// footer text a future page adds outside this builder and outside the files
// F5 / F7 scan.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { basisAuthorshipSentence, reportAuthorship, reportFooterLines } from "@/lib/reportFooter";
import { foreignNumber } from "@/test/numberLanguage";

const REPO = resolve(__dirname, "../../..");

/** A served canonical balance sheet, as GET /api/period carries it. Every
 *  figure in this file is invented — no book's numbers are used. */
function canonical(
  status: string, difference: number, assets: number,
  extraction: Record<string, unknown> | null = { method: "deterministic", source_format: "saga_10_col" },
) {
  return {
    schema_version: "bs_v2",
    status,
    difference,
    ...(extraction ? { extraction } : {}),
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
    expect(without.generated).not.toMatch(/narrative|briefing/i);
    expect(without.generated).toMatch(/no AI model read or produced these figures/);
    expect(withBriefing.generated).toMatch(/briefing .* written by an AI model/);
    for (const f of [without, withBriefing]) {
      expect(f.generated).not.toMatch(/Claude|Opus|Sonnet|GPT|\d+\.\d+/);
      expect(f.generated).toMatch(/deterministic engine/);
    }
  });

  it("F6 who read the document is the served extraction method, never a universal sentence", () => {
    const of = (extraction: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
      reportFooterLines({
        statements: { canonical_bs: { ...canonical("MINOR_DRIFT", 0.05, 1_000_000, extraction), ...extra } },
        currency: "RON", briefingShown: false, language: "en",
      }).generated;

    // a deterministic read of a trial-balance layout
    const code = of({ method: "deterministic", source_format: "saga_10_col" });
    expect(code).toMatch(/read and computed by code — the deterministic engine — from the uploaded trial balance/);

    // AN AI-READ PERIOD — the same marker the statement's AI-read badge tests
    for (const ai of [
      of({ method: "llm", source_format: "llm_freeform" }),
      of({ method: "deterministic", source_format: "saga_10_col" }, { classification: { method: "llm" } }),
    ]) {
      expect(ai).toMatch(/read from the uploaded document by an AI model/);
      expect(ai).toMatch(/Check them against the source/);
      expect(ai, "an AI-read period is called deterministic").not.toMatch(/deterministic|no AI model/);
      expect(ai, "an AI-read upload is called a trial balance").not.toMatch(/trial balance/);
    }

    // a map-guided read: the layout by a model, the numbers by code
    const mapped = of({ method: "mechanical_mapped", source_format: "map_guided" });
    expect(mapped).toMatch(/layout of the uploaded document was interpreted by an AI model/);
    expect(mapped).not.toMatch(/no AI model|trial balance/);

    // a deterministic read of something that is not a trial-balance layout
    const statutory = of({ method: "deterministic", source_format: "statutory_f30_f10" });
    expect(statutory).toMatch(/from the uploaded document;/);
    expect(statutory).not.toMatch(/trial balance/);

    // nothing served about the reading: nothing claimed about it
    const silent = of(null);
    expect(silent).toMatch(/does not record how the uploaded document was read/);
    expect(silent).not.toMatch(/deterministic|AI model read/);

    expect(reportAuthorship({ canonical_bs: { extraction: { method: "llm" } } }).readBy).toBe("ai_model");
    expect(reportAuthorship({}).readBy).toBe("not_stated");

    // the valuation section of the signed-in page is browser arithmetic
    const page = reportFooterLines({
      statements: { canonical_bs: canonical("BALANCED", 0, 1_000_000) },
      currency: "RON", briefingShown: false, browserValuation: true, language: "en",
    }).generated;
    expect(page).toMatch(/valuation section is arithmetic done in your browser/);
    expect(code).not.toMatch(/valuation/);

    // the export's basis note: the same reading, and the wording of findings
    const basis = basisAuthorshipSentence({ canonical_bs: canonical("BALANCED", 0, 1) }, { aiNarrative: false });
    expect(basis).toMatch(/no AI model read or produced these figures/);
    expect(basis).not.toMatch(/AI-assisted|AI-written/);
    expect(basisAuthorshipSentence({ canonical_bs: canonical("BALANCED", 0, 1) }, { aiNarrative: true }))
      .toMatch(/explanations marked as AI-written .* were worded by an AI model/);
    expect(basisAuthorshipSentence(
      { canonical_bs: canonical("MINOR_DRIFT", 1, 1, { method: "llm" }) }, { aiNarrative: false }))
      .toMatch(/read from the uploaded document by an AI model/);
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
    // the page hands the builder what it knows; it types no authorship itself
    expect(code).toContain("browserValuation: true");
    expect(code).not.toMatch(/Every figure is computed by the deterministic engine/);
  });

  it("F7 the export closes under the same law, and the published sample prints none of the retired sentences", () => {
    /** Code only: comments quote the retired sentences on purpose. */
    const codeOf = (rel: string) =>
      readFileSync(join(REPO, rel), "utf8")
        .replace(/\$\{""\/\*[\s\S]*?\*\/\}/g, " ")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");
    const RETIRED =
      /within 0\.5%|see Section 5|Opus 4\.7|This document is AI-assisted|AI-assisted;|statutory financial statements as ingested|\bas filed\b|filed close|company filed|implying an opening balance|at any level of effort/;
    for (const rel of [
      "frontend/lib/financialReport.ts",
      "frontend/lib/charts/reportCharts.ts",
      "frontend/lib/charts/documentShell.ts",
      "frontend/lib/reportPrintCss.ts",
      "frontend/lib/reportFooter.ts",
      "frontend/lib/printedPl.ts",
      "frontend/lib/financialExports.ts",
    ]) {
      const hit = RETIRED.exec(codeOf(rel));
      expect(hit?.[0] ?? null, `${rel} types a retired sentence`).toBeNull();
    }
    const report = codeOf("frontend/lib/financialReport.ts");
    // the export's authorship is built by lib/reportFooter, and its
    // confidentiality line is an input the public sample turns off
    expect(report).toContain("basisAuthorshipSentence(s,");
    expect(report).toContain("data-report-authorship=");
    expect(report).toMatch(/confidential \? " &nbsp;·&nbsp; Confidential &mdash; for internal use only" : ""/);
    expect(codeOf("frontend/lib/charts/documentShell.ts")).toMatch(/c\.confidential \? "[^"]*Confidential/);
    const confidential = (report.match(/Confidential/g) ?? []).length;
    expect(confidential, "a confidentiality line outside the `confidential` input").toBe(1);

    // THE PUBLISHED SAMPLE — a fictional company, built with no model
    const html = readFileSync(join(REPO, "public/sample/sample_report_fy2025.html"), "utf8");
    const body = html.slice(html.indexOf("</style>")).replace(/<script[\s\S]*?<\/script>/g, " ");
    const text = body.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ").replace(/\s+/g, " ");
    expect(text.length).toBeGreaterThan(20_000);
    expect(RETIRED.exec(text)?.[0] ?? null, "the published sample prints a retired sentence").toBeNull();
    expect(text).not.toMatch(/Confidential|AI-assisted/);
    expect(/data-report-authorship="code"/.test(body), "the sample does not state it was read by code").toBe(true);
    expect(text).toMatch(/no AI model read or produced these figures/);
    expect((body.match(/data-report-notice=/g) ?? []).length, "the fictional-company notice").toBe(3);
    expect(text).toMatch(/Fictional company — this is a generated sample, not a real entity/);
    console.log("GATE-WORK report-footer laws=8");
  });
});
