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
// 2026-10-02, THE THIRD REVIEW — THE LAW WAS A LIST OF RETIRED PHRASES.
// F1–F7 forbade "within 0.5%", "see Section 5", "reconcile to the source" and
// the other sentences that had once been wrong. A verifier wrote the same
// false claim in new words — "All numbers tie to the source trial balance
// within 1%." in the export's footer, "Every number ties out to the source
// file, to the cent." in the builder, a <p> above the page's footer — rebuilt
// the published sample with it, and every gate printed PASS. And F5 could be
// UN-REGISTERED with the gate green: the "laws=8" canary was a string
// literal, not a count.
//
// THE LAW IS NOW POSITIVE:
//   F1–F4, F6  the builder's three lines are EXACTLY the expected strings
//       for each reading and each verdict (written out here, a second
//       copy): a word added to a line is a red, whatever the word;
//   F5  the page's closing region — everything after its last section — is
//       the footer element and its three served expressions, nothing typed;
//   F8  THE PUBLISHED SAMPLE'S CLOSING BLOCKS ARE EXACTLY THE BUILDER'S
//       OUTPUT FOR THE SERVED DOCUMENT: from the "Basis of Preparation"
//       heading to the end of the footer, the text is the basis note with
//       `basisAuthorshipSentence(served)`, the provenance note built from
//       the served extraction block, the two chart notes, the footer with
//       the sample's date and the fictional-company notice — and nothing
//       else;
//   F9  no closing block states a percentage or a tolerance, in any words:
//       every line the builder returns, across every reading and verdict,
//       and the sample's closing blocks.
// The law count is printed from a counter of laws that RAN; the battery's
// canary is that exact count, and each of F1, F3, F4, F5 is a canary by
// name.
//
// REDS ON, AFTER THE REPAIR: any sentence added to the report's closing
// blocks — the page footer, the export's basis note or footer, a builder
// line — in ANY wording; a percentage or a tolerance there; a model name;
// a balanced verdict printed over an imbalanced book; a difference that is
// not the served one; "deterministic engine" or "trial balance" on an
// AI-read period; a law of this file skipped or removed.
// CANNOT SEE: whether the served difference itself is right (bs-drift);
// whether the served extraction method is right (the engine stamps it); a
// false sentence typed into a SECTION of the report rather than its closing
// blocks (the sample's sections are held by the byte-identical rebuild,
// public-sample-page P5, which reds on a change but does not judge it); the
// closing blocks of a customer's own export, which this file checks through
// the builder and the published sample only; the page's footer as RENDERED
// (F5 reads the page's source).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { basisAuthorshipSentence, reportAuthorship, reportFooterLines } from "@/lib/reportFooter";
import { SAMPLE_REPORT_NOTICE } from "@/lib/publicSampleReport";
import { foreignNumber } from "@/test/numberLanguage";

const REPO = resolve(__dirname, "../../..");

// ── the law counter ───────────────────────────────────────────────────
// A law is registered through `law()`, and counted when it RAN to its end.
// The line printed after the file is the battery's canary: a law removed,
// renamed away, skipped or failing changes the count.
let lawsRegistered = 0;
let lawsRun = 0;
function law(name: string, body: () => void | Promise<void>): void {
  lawsRegistered += 1;
  it(name, async () => {
    await body();
    lawsRun += 1;
  });
}
afterAll(() => {
  console.log(`GATE-WORK report-footer laws=${lawsRun} registered=${lawsRegistered}`);
});

// ── the expected lines, written out ───────────────────────────────────
const READ = {
  code_tb:
    "The statements, ratios and credit score in this report were read and computed by code — the " +
    "deterministic engine — from the uploaded trial balance; no AI model read or produced these figures.",
  code_document:
    "The statements, ratios and credit score in this report were read and computed by code — the " +
    "deterministic engine — from the uploaded document; no AI model read or produced these figures.",
  ai_model:
    "The figures in this report were read from the uploaded document by an AI model, then computed by " +
    "the engine. Check them against the source before external use.",
  ai_layout:
    "The layout of the uploaded document was interpreted by an AI model; the numbers were then read and " +
    "computed by code.",
  not_stated: "The served statement does not record how the uploaded document was read.",
} as const;
const GENERATED = "Generated by CFO AI. ";
const BROWSER_VALUATION =
  " The valuation section is arithmetic done in your browser on those figures and the assumptions shown there.";
const BRIEFING = " The briefing in section 1 was written by an AI model from these figures.";
const JUDGEMENT = " Final analytical judgement and any onward decisions remain with management.";
const AI_WORDING =
  " The explanations marked as AI-written under \u201cWhat the numbers say\u201d were worded by an AI model from these figures.";
const BALANCE = {
  BALANCED: "Balance check: Balance check passed — Assets = Equity + Liabilities (engine-verified).",
  MINOR_DRIFT: "Balance check: Minor balance drift.",
  MATERIAL_IMBALANCE: "Balance check: Material imbalance — this balance sheet does not reconcile.",
  UNVERIFIED: "Balance check: not engine-verified (legacy period — totals from the persisted envelope).",
} as const;

/** A percentage or a tolerance, in any words: nothing in a report's closing
 *  blocks states how close the figures are to anything. ("does not
 *  reconcile" is a verdict, not a tolerance.) */
const TOLERANCE =
  /%|\bper ?cent\b|\bwithin\b|\bto the (?:cent|penny|ban)\b|\bties?(?: out)? (?:to|with)\b|\btied (?:out )?to\b|\breconciles? (?:to|with)\b|\breconciled to\b|\bmatch(?:es)? the source\b|\baccurate to\b|\btolerance of\b|[±≤≥<>]\s*\d|\bexact(?:ly)? (?:equal|match)/i;

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
  const lines = (statements: unknown, extra: Partial<Parameters<typeof reportFooterLines>[0]> = {}) =>
    reportFooterLines({ statements, currency: "RON", briefingShown: false, language: "en", ...extra });

  law("F1 a balanced book: the engine's verdict and a zero difference, no tolerance", () => {
    const f = lines({ canonical_bs: canonical("BALANCED", 0, 1_000_000) });
    // the builder returns these four fields and no other: a fifth line would
    // be a sentence no law reads
    expect(Object.keys(f).sort()).toEqual(["balance", "differenceLine", "generated", "machineStatus"]);
    expect(f.machineStatus).toBe("BALANCED");
    expect(f.generated).toBe(GENERATED + READ.code_tb);
    expect(f.balance).toBe(BALANCE.BALANCED);
    expect(plain(f.differenceLine)).toBe("Assets − (Equity + Liabilities) = 0.00 RON on this report.");
  });

  law("F2 an imbalanced book: that status and the served difference to the cent", () => {
    const en = lines({ canonical_bs: canonical("MATERIAL_IMBALANCE", -1234.56, 500_000) });
    expect(en.machineStatus).toBe("MATERIAL_IMBALANCE");
    expect(en.generated).toBe(GENERATED + READ.code_tb);
    expect(en.balance).toBe(BALANCE.MATERIAL_IMBALANCE);
    expect(plain(en.differenceLine)).toBe("Assets − (Equity + Liabilities) = -1,234.56 RON on this report.");
    expect(foreignNumber(plain(en.differenceLine), "en")).toBeNull();

    // the figure follows the reader's language; the code stays after it
    const ro = lines({ canonical_bs: canonical("MATERIAL_IMBALANCE", -1234.56, 500_000) }, { language: "ro" });
    expect(plain(ro.differenceLine)).toBe("Assets − (Equity + Liabilities) = -1.234,56 RON on this report.");
    expect(foreignNumber(plain(ro.differenceLine), "ro")).toBeNull();
    expect(plain(ro.differenceLine)).not.toMatch(/\blei\b|RON\s*-?\d/);

    const drift = lines({ canonical_bs: canonical("MINOR_DRIFT", 0.05, 1_000_000) });
    expect(drift.machineStatus).toBe("MINOR_DRIFT");
    expect(drift.balance).toBe(BALANCE.MINOR_DRIFT);
    expect(plain(drift.differenceLine)).toBe("Assets − (Equity + Liabilities) = 0.05 RON on this report.");
  });

  law("F3 a period with no engine verdict says so, and prints no difference", () => {
    const f = lines({});
    expect(f.machineStatus).toBe("UNVERIFIED");
    expect(f.generated).toBe(GENERATED + READ.not_stated);
    expect(f.balance).toBe(BALANCE.UNVERIFIED);
    expect(f.differenceLine).toBe("No engine balance verdict exists for this period.");
  });

  law("F3 a served verdict without its totals block still prints the served status and difference", () => {
    const f = lines({ canonical_bs: { status: "MATERIAL_IMBALANCE", difference: -1234.56 } });
    expect(f.machineStatus).toBe("MATERIAL_IMBALANCE");
    expect(f.balance).toBe(BALANCE.MATERIAL_IMBALANCE);
    expect(plain(f.differenceLine)).toBe("Assets − (Equity + Liabilities) = -1,234.56 RON on this report.");
    const none = lines({ canonical_bs: { status: "MINOR_DRIFT" } });
    expect(none.differenceLine).toBe(
      "Difference: not stated — the served statement carried neither a balance difference nor the totals to work one out.");
  });

  law("F4 credits the narrative only when a briefing is shown, and names no model version", () => {
    const statements = { canonical_bs: canonical("BALANCED", 0, 1_000_000) };
    const without = lines(statements);
    const withBriefing = lines(statements, { briefingShown: true });
    expect(without.generated).toBe(GENERATED + READ.code_tb);
    expect(withBriefing.generated).toBe(GENERATED + READ.code_tb + BRIEFING);
    for (const text of [...Object.values(READ), BRIEFING, BROWSER_VALUATION, JUDGEMENT, AI_WORDING]) {
      expect(text).not.toMatch(/Claude|Opus|Sonnet|Haiku|GPT|Gemini|\d+\.\d+/);
    }
  });

  law("F6 who read the document is the served extraction method, never a universal sentence", () => {
    const of = (extraction: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
      lines({ canonical_bs: { ...canonical("MINOR_DRIFT", 0.05, 1_000_000, extraction), ...extra } }).generated;

    // a deterministic read of a trial-balance layout
    expect(of({ method: "deterministic", source_format: "saga_10_col" })).toBe(GENERATED + READ.code_tb);
    expect(of({ method: "deterministic", source_format: "pdf_positional" })).toBe(GENERATED + READ.code_tb);

    // AN AI-READ PERIOD — the same marker the statement's AI-read badge tests
    expect(of({ method: "llm", source_format: "llm_freeform" })).toBe(GENERATED + READ.ai_model);
    expect(of({ method: "deterministic", source_format: "saga_10_col" }, { classification: { method: "llm" } }))
      .toBe(GENERATED + READ.ai_model);
    expect(READ.ai_model, "an AI-read period is called deterministic, or a trial balance")
      .not.toMatch(/deterministic|no AI model|trial balance/);

    // a map-guided read: the layout by a model, the numbers by code
    expect(of({ method: "mechanical_mapped", source_format: "map_guided" })).toBe(GENERATED + READ.ai_layout);
    expect(READ.ai_layout).not.toMatch(/no AI model|trial balance/);

    // a deterministic read of something that is not a trial-balance layout
    expect(of({ method: "deterministic", source_format: "statutory_f30_f10" })).toBe(GENERATED + READ.code_document);

    // nothing served about the reading: nothing claimed about it
    expect(of(null)).toBe(GENERATED + READ.not_stated);

    expect(reportAuthorship({ canonical_bs: { extraction: { method: "llm" } } }).readBy).toBe("ai_model");
    expect(reportAuthorship({}).readBy).toBe("not_stated");

    // the valuation section of the signed-in page is browser arithmetic
    const balanced = { canonical_bs: canonical("BALANCED", 0, 1_000_000) };
    expect(lines(balanced, { browserValuation: true }).generated).toBe(GENERATED + READ.code_tb + BROWSER_VALUATION);
    expect(lines(balanced, { browserValuation: true, briefingShown: true }).generated)
      .toBe(GENERATED + READ.code_tb + BROWSER_VALUATION + BRIEFING);

    // the export's basis note: the same reading, and the wording of findings
    expect(basisAuthorshipSentence({ canonical_bs: canonical("BALANCED", 0, 1) }, { aiNarrative: false }))
      .toBe(READ.code_tb + JUDGEMENT);
    expect(basisAuthorshipSentence({ canonical_bs: canonical("BALANCED", 0, 1) }, { aiNarrative: true }))
      .toBe(READ.code_tb + AI_WORDING + JUDGEMENT);
    expect(basisAuthorshipSentence(
      { canonical_bs: canonical("MINOR_DRIFT", 1, 1, { method: "llm" }) }, { aiNarrative: false }))
      .toBe(READ.ai_model + JUDGEMENT);
  });

  /** Code only: comments quote the retired sentences on purpose. */
  const codeOf = (rel: string) =>
    readFileSync(join(REPO, rel), "utf8")
      .replace(/\$\{""\/\*[\s\S]*?\*\/\}/g, " ")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");

  law("F5 the report page's closing region is the footer and its three served lines, nothing typed", () => {
    const code = codeOf("frontend/pages/cfo/ComprehensiveReport.tsx");
    expect(code).toContain("reportFooterLines(");
    // THE CLOSING REGION: everything after the page's last section. A <p>
    // typed above the footer passed while the law read the <footer> only.
    const articleEnd = code.lastIndexOf("</article>");
    const lastSection = code.lastIndexOf("</section>", articleEnd);
    const footerEnd = code.indexOf("</footer>", articleEnd);
    expect(articleEnd > 0 && lastSection > 0 && footerEnd > articleEnd, "the page's closing region was not found").toBe(true);
    // the last section is the last NUMBERED one (no section was added after the law was written)
    const sections = [...code.matchAll(/data-testid="report-section-(\d+)-/g)].map((m) => Number(m[1]));
    expect(code.lastIndexOf(`data-testid="report-section-${Math.max(...sections)}-`)).toBeLessThan(lastSection);
    const rest = code.slice(footerEnd + "</footer>".length);
    expect(rest.replace(/\s+/g, ""), "markup after the footer").toMatch(/^<\/div><\/>\);\}/);
    const region = code.slice(lastSection + "</section>".length, footerEnd + "</footer>".length);
    expect((region.match(/<footer\b/g) ?? []).length).toBe(1);
    const expressions = [...region.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1].trim()).filter((e) => e !== '" "');
    expect(expressions).toEqual([
      "footer.machineStatus", "footer.generated", "footer.balance", "footer.differenceLine",
    ]);
    const typed = region.replace(/<[^>]+>/g, " ").replace(/\{[^{}]*\}/g, " ").replace(/\s+/g, " ").trim();
    expect(typed, `text typed into the report's closing region: "${typed}"`).toBe("");
    // the page hands the builder what it knows; it types no authorship itself
    expect(code).toContain("browserValuation: true");
    expect(code).not.toMatch(/Every figure is computed by the deterministic engine/);
    // and nowhere in the page's own JSX is a tolerance typed
    const jsxText = [...code.matchAll(/(?<=[>}])[^<>{}]+(?=[<{])|"(?:[^"\\\n]|\\.)*"|`[^`]*`/g)].map((m) => m[0]);
    expect(jsxText.length).toBeGreaterThan(100);
    const claims = jsxText.filter((text) => /\breconcil\w* (?:to|within)\b|\bties?(?: out)? to\b|\bwithin \d|\bto the cent\b/i.test(text));
    expect(claims, "a tolerance typed into the report page").toEqual([]);
  });

  const RETIRED =
    /within 0\.5%|see Section 5|Opus 4\.7|This document is AI-assisted|AI-assisted;|statutory financial statements as ingested|\bas filed\b|filed close|company filed|implying an opening balance|at any level of effort/;

  law("F7 the export's closing templates are the expected ones, and no retired sentence is typed in its source", () => {
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
    // THE SOURCE OF THE TWO CLOSING BLOCKS, character for character. A
    // sentence added to either template is a red before any sample is
    // rebuilt.
    const squeeze = (text: string) => text.replace(/\s+/g, " ").trim();
    const footer = /<footer class="footer">([\s\S]*?)<\/footer>/.exec(report)?.[1] ?? "";
    expect(squeeze(footer)).toBe(squeeze(`
    <span class="lhs"><strong>CFO AI</strong> &nbsp;·&nbsp; Financial Statement Intelligence</span>
    <span class="rhs">Generated \${escapeHtml(today)}\${
      confidential ? " &nbsp;·&nbsp; Confidential &mdash; for internal use only" : ""
    }\${notice ? \` &nbsp;·&nbsp; <span data-report-notice="footer">\${escapeHtml(notice.long)}</span>\` : ""}</span>
  `));
    const basis = /<aside class="basis-note">([\s\S]*?)<\/aside>/.exec(report)?.[1] ?? "";
    expect(squeeze(basis)).toBe(squeeze(`
    <strong>Basis of preparation</strong>
    Figures are computed from the \${authorship.documentWord} uploaded for the period. Ratios follow standard lender conventions (Altman Z-Score, DSCR, debt-to-EBITDA, etc.); benchmarks are indicative and industry-dependent. Where the underlying trial-balance reconciliation gap exceeds tolerance, the affected figure is annotated in the relevant statement above. <span data-report-authorship="\${authorship.readBy}">\${escapeHtml(authorshipSentence)}</span>\${provenanceNote}
  `));
    // the export's authorship is built by lib/reportFooter, and its
    // confidentiality line is an input the public sample turns off
    expect(report).toContain("basisAuthorshipSentence(s,");
    expect(codeOf("frontend/lib/charts/documentShell.ts")).toMatch(/c\.confidential \? "[^"]*Confidential/);
    const confidential = (report.match(/Confidential/g) ?? []).length;
    expect(confidential, "a confidentiality line outside the `confidential` input").toBe(1);
  });

  // ── the published sample ────────────────────────────────────────────
  const PUBLIC_SAMPLE = join(REPO, "public/sample");
  const sampleHtml = () => readFileSync(join(PUBLIC_SAMPLE, "sample_report_fy2025.html"), "utf8");
  const served = () => JSON.parse(readFileSync(join(PUBLIC_SAMPLE, "served_period_fy2025.json"), "utf8")) as {
    statements: { canonical_bs: { extraction: { sheet: string; method: string }; mapping_version: string } };
  };
  const squeezeText = (text: string) => text.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
  /** The text of the sample's closing blocks: from the "Basis of
   *  Preparation" section to the end of the footer. */
  function sampleClosingText(): string {
    const html = sampleHtml();
    const start = html.lastIndexOf("<section", html.indexOf('id="sec-basis"'));
    const end = html.indexOf("</footer>", start);
    expect(start > 0 && end > start, "the sample's closing blocks were not found").toBe(true);
    // every tag is a word break (two adjacent <span>s are two sentences);
    // the entities are then decoded by the parser
    const tagless = html.slice(start, end).replace(/<[^>]+>/g, " ");
    return squeezeText(new DOMParser().parseFromString(tagless, "text/html").body.textContent ?? "");
  }
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December"];

  law("F8 the published sample's closing blocks are exactly the builder's output for the served document", () => {
    const cbs = served().statements.canonical_bs;
    const asOf = (JSON.parse(readFileSync(join(REPO, "scripts/public_sample_config.json"), "utf8")) as { as_of: string }).as_of;
    const [year, month, day] = asOf.split("-").map(Number);
    const authorship = basisAuthorshipSentence(served().statements, { aiNarrative: false });
    // the sample is a trial balance read by code: its authorship is that sentence
    expect(authorship).toBe(READ.code_tb + JUDGEMENT);
    expect(cbs.extraction.sheet && cbs.extraction.method && cbs.mapping_version, "the served extraction block").toBeTruthy();
    const expected = [
      "Basis of Preparation",
      "Basis of preparation",
      "Figures are computed from the trial balance uploaded for the period. Ratios follow standard lender " +
        "conventions (Altman Z-Score, DSCR, debt-to-EBITDA, etc.); benchmarks are indicative and " +
        "industry-dependent. Where the underlying trial-balance reconciliation gap exceeds tolerance, the " +
        "affected figure is annotated in the relevant statement above.",
      authorship,
      `Balance-sheet provenance: sheet ${cbs.extraction.sheet} · read ${cbs.extraction.method} · mapping pack ` +
        `${cbs.mapping_version}; each balance-sheet row above names its account codes.`,
      "Charts. Every chart is generated with this document, from the same served figures the statements " +
        "above print, and carries its own table — no chart is the only place a number appears. A chart whose " +
        "inputs the trial balance did not carry is replaced by a card naming the missing input, never by an " +
        "empty axis.",
      "About the charts. Each chart comes with the table of numbers behind it, so nothing is only in a " +
        "picture. If we did not have the data for a chart, we say what is missing instead of drawing an " +
        "empty one.",
      // the figure-provenance popover's own labels
      "Formula Accounts Method Snapshot Copy figure with provenance",
      "CFO AI · Financial Statement Intelligence",
      `Generated ${day} ${MONTHS[month - 1]} ${year} · ${SAMPLE_REPORT_NOTICE.long}`,
    ].join(" ");
    expect(sampleClosingText()).toBe(squeezeText(expected));

    // and the document's standing statements about itself
    const html = sampleHtml();
    const body = html.slice(html.indexOf("</style>")).replace(/<script[\s\S]*?<\/script>/g, " ");
    const text = body.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ").replace(/\s+/g, " ");
    expect(text.length).toBeGreaterThan(20_000);
    expect(RETIRED.exec(text)?.[0] ?? null, "the published sample prints a retired sentence").toBeNull();
    expect(text).not.toMatch(/Confidential|AI-assisted/);
    expect(/data-report-authorship="code"/.test(body), "the sample does not state it was read by code").toBe(true);
    expect((body.match(/data-report-notice=/g) ?? []).length, "the fictional-company notice").toBe(3);
  });

  law("F9 no closing block states a percentage or a tolerance, in any words", () => {
    const readings: Array<Record<string, unknown> | null> = [
      { method: "deterministic", source_format: "saga_10_col" },
      { method: "deterministic", source_format: "statutory_f30_f10" },
      { method: "llm", source_format: "llm_freeform" },
      { method: "mechanical_mapped", source_format: "map_guided" },
      null,
    ];
    let examined = 0;
    for (const extraction of readings) {
      for (const [status, difference] of [["BALANCED", 0], ["MINOR_DRIFT", 0.05], ["MATERIAL_IMBALANCE", -1234.56], ["RECONCILED", 0]] as const) {
        for (const briefingShown of [false, true]) for (const browserValuation of [false, true]) for (const language of ["en", "ro"]) {
          const f = lines({ canonical_bs: canonical(status, difference, 1_000_000, extraction) },
            { briefingShown, browserValuation, language });
          for (const line of [f.generated, f.balance, f.differenceLine]) {
            expect(TOLERANCE.exec(plain(line))?.[0] ?? null, `"${line}"`).toBeNull();
            examined += 1;
          }
        }
      }
      for (const aiNarrative of [false, true]) {
        const basis = basisAuthorshipSentence({ canonical_bs: canonical("BALANCED", 0, 1, extraction) }, { aiNarrative });
        expect(TOLERANCE.exec(basis)?.[0] ?? null, `"${basis}"`).toBeNull();
        examined += 1;
      }
    }
    expect(examined).toBeGreaterThan(450);
    const empty = lines({});
    for (const line of [empty.generated, empty.balance, empty.differenceLine]) expect(TOLERANCE.exec(line)).toBeNull();
    // the published sample's closing blocks
    expect(TOLERANCE.exec(sampleClosingText())?.[0] ?? null, "the sample's closing blocks state a tolerance").toBeNull();
    // the detector reads the sentences a verifier planted, and not a verdict
    for (const text of [
      "All numbers tie to the source trial balance within 1%.",
      "Every number ties out to the source file, to the cent.",
      "All figures reconcile to the source trial balance within 1%.",
      "Numbers reconcile to the source trial balance within 0.5%.",
      "Accurate to ±0.1 RON.",
    ]) expect(TOLERANCE.test(text), `not detected: ${text}`).toBe(true);
    for (const text of [BALANCE.MATERIAL_IMBALANCE, BALANCE.BALANCED, READ.code_tb, READ.ai_model]) {
      expect(TOLERANCE.test(text), `a verdict read as a tolerance: ${text}`).toBe(false);
    }
  });
});
