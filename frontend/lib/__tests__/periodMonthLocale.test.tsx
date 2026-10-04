// EVERY MONTH LABEL IS IN THE READER'S LANGUAGE.
//
// WHY THIS EXISTS (review of the no-prior hotfix, 2026-10-04): in a Romanian
// interface the dashboard's own header read "Dec 2024" while the breadcrumb
// beside it read "dec. 2024". The two month formatters
// (lib/orgPeriods `formatPeriodMonth` / `formatPeriodMonthLoose`) took the
// locale as an OPTIONAL argument defaulting to "en-GB", and eight call sites
// had never passed it: the dashboard header (two), the period-switch
// overlay's label and the stepper's `selectedMonth`, the Products page's two
// month labels, the workspace cards' month chips, the "could not delete"
// list of the dashboard's danger zone. A third printer,
// lib/detectPeriodEnd `formatDetectedMonth` (the upload dialog's "March
// 2025"), had "en-GB" written into it. Nothing failed: an English month is a
// perfectly good string.
//
// THE REPAIR is the signature: `locale` is REQUIRED on both formatters — a
// default is how the argument gets forgotten — and `formatDetectedMonth`
// reads the active locale itself.
//
// THE LAW (source, over the TypeScript AST of every non-test file):
//   1. neither formatter declares its `locale` optional or with a default;
//   2. every call of either passes a locale that COMES FROM THE UI LANGUAGE:
//      a call to lib/locale (`useActiveLocale()`, `activeLocale()`,
//      `localeFor(…)`), or a name every declaration of which, in that file,
//      is one of those calls or a REQUIRED parameter (the caller's to
//      state) — never a string literal, never an optional pass-through;
//   3. a function that takes the locale as a parameter and hands it to a
//      formatter is itself held to rule 2 at every call of it (in its own
//      file, and wherever it is imported);
//   4. `formatDetectedMonth` formats with `activeLocale()`.
// And rendered, in Romanian and in English: the dashboard's header, the
// stepper's month and the label it hands the period-switch overlay, the
// three printers themselves.
//
// FOUND BY THE RENDERED CHECK, fixed in the same change: the formatters read
// whatever `new Date()` would, and V8 reads the LABEL "FY 2025" as 1 January
// 2025 in the viewer's timezone — the header printed "Dec 2024" for it east
// of Greenwich, and "Nov 2025" for "Decembrie 2025". They now read the dates
// the engine serves (`YYYY-MM-DD…`) and nothing else; a label stays as
// written.
//
// WHAT IT REDS ON, with the call sites repaired (TC-11): a new call without
// a locale, or with a literal one ("en-GB"); a default or a `?` returning to
// either formatter, or to a helper that passes the locale through; a helper
// called with a locale that is not the UI language's; `formatDetectedMonth`
// going back to a written locale; the dashboard header or the stepper
// printing an English month in Romanian (or a Romanian one in English); a
// header that does not follow a language switch while mounted; either
// formatter reading a label ("FY 2024", "Decembrie 2024", a bare year) as a
// date.
//
// WHAT IT CANNOT SEE: a month printed by anything OTHER than these three
// functions — a date formatted in place (`toLocaleDateString("en-GB", …)`:
// the Products page's upload dates, the plan card's reset date, the industry
// audit trail's timestamps; `toLocaleDateString(undefined, …)`, the browser's
// language rather than the interface's: the stock chart's axis, the renewal
// date in Settings), a month name written into a translation, a label the
// ENGINE serves; a locale handed down as a component PROP (a destructured
// parameter is "the caller's to state", and JSX callers are not traced); a
// call through a re-export or a renamed import; the report and the exports,
// which are English by contract; whether "dec. 2024" is what a Romanian
// reader expects (it is ICU's ro-RO form, the one the breadcrumb prints).

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import i18n from "@/i18n";

const PERIODS = [
  { period_id: "p-2025", period_label: "2025-12-31", period_start: "2025-01-01", period_end: "2025-12-31", documents: [] },
  { period_id: "p-2024", period_label: "2024-12-31", period_start: "2024-01-01", period_end: "2024-12-31", documents: [] },
  { period_id: "p-2023", period_label: "2023-06-30", period_start: "2023-01-01", period_end: "2023-06-30", documents: [] },
];
const startPeriodSwitch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));
vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  useAmountFormatter: () => (v: number | null | undefined) => (v == null ? "—" : String(v)),
  useDisplayCurrency: () => "RON",
  useRates: () => ({ rates: {} }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/activePeriod", async (orig) => ({
  ...(await orig<typeof import("@/lib/activePeriod")>()),
  useActivePeriod: () => ({ id: null, periodEnd: null }),
}));
vi.mock("@/lib/org", async (orig) => ({
  ...(await orig<typeof import("@/lib/org")>()),
  useActiveOrg: () => ({ org: { id: "org-test" } }),
}));
vi.mock("@/lib/orgPeriods", async (orig) => ({
  ...(await orig<typeof import("@/lib/orgPeriods")>()),
  useOrgPeriods: () => ({ data: { active_period_id: null, periods: PERIODS } }),
  fetchWorkspacePeriodsDirect: async () => ({ active_period_id: null, periods: [] }),
}));
vi.mock("@/lib/periodSwitch", async (orig) => ({
  ...(await orig<typeof import("@/lib/periodSwitch")>()),
  startPeriodSwitch,
}));
vi.mock("@/lib/scanGuard", () => ({ blockedByScan: () => false }));

import { CompactPeriodHeader } from "@/pages/cfo/FinancialStatements";
import { usePeriodStepper } from "@/lib/usePeriodStepper";
import { formatPeriodMonth, formatPeriodMonthLoose } from "@/lib/orgPeriods";
import { formatDetectedMonth } from "@/lib/detectPeriodEnd";
import type { Statements } from "@/lib/financialReport";

const REPO = resolve(process.cwd());
const FRONTEND = join(REPO, "frontend");

/** An English month abbreviation as en-GB prints it: capitalised, no dot.
 *  Romanian's are lower-case ("dec.", "mai", "iun."). Independent of the
 *  formatters under test. */
const ENGLISH_MONTH = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/;
const ROMANIAN_MONTH = /(^|[^\p{L}])(ian|feb|mar|apr|mai|iun|iul|aug|sept|oct|nov|dec)\.?(?=\s)/u;

afterEach(async () => {
  cleanup();
  startPeriodSwitch.mockClear();
  await act(async () => {
    await i18n.changeLanguage("en");
  });
});

// ── The source ─────────────────────────────────────────────────────────

const FORMATTERS = ["formatPeriodMonth", "formatPeriodMonthLoose"] as const;
const LOCALE_SOURCES = new Set(["useActiveLocale", "activeLocale", "localeFor"]);

function sourceFiles(dir = FRONTEND, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "test") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) acc.push(full);
  }
  return acc;
}

const parse = (file: string, text = readFileSync(file, "utf8")) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const isLocaleCall = (node: ts.Node | undefined): boolean =>
  !!node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && LOCALE_SOURCES.has(node.expression.text);

/** The function a parameter belongs to, with its name where it has one
 *  (a declaration, or an arrow / function expression bound to a const). */
function ownerOf(param: ts.ParameterDeclaration): { name: string | null; index: number; exported: boolean } {
  const fn = param.parent;
  const index = fn.parameters.indexOf(param);
  if (ts.isFunctionDeclaration(fn) && fn.name) {
    const exported = !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    return { name: fn.name.text, index, exported };
  }
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    const stmt = fn.parent.parent.parent;
    const exported = ts.isVariableStatement(stmt) && !!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    return { name: fn.parent.name.text, index, exported };
  }
  return { name: null, index, exported: false };
}

interface Helper {
  name: string;
  index: number;
  file: string;
  exported: boolean;
}

/** Why the expression handed over as a locale is not the UI language's —
 *  or null when it is. A sound parameter is reported through `helpers`:
 *  its function is then held to the same rule at its own calls. */
function unsoundLocale(arg: ts.Expression | undefined, sf: ts.SourceFile, file: string, helpers: Helper[]): string | null {
  if (!arg) return "no locale passed";
  if (isLocaleCall(arg)) return null;
  if (ts.isStringLiteralLike(arg)) return `a written locale (${arg.getText()})`;
  if (!ts.isIdentifier(arg)) return `not a locale from lib/locale: ${arg.getText()}`;
  const reasons: string[] = [];
  let declared = 0;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === arg.text) {
      declared += 1;
      if (!isLocaleCall(node.initializer)) reasons.push(`"${arg.text}" is declared as ${node.initializer?.getText() ?? "nothing"}`);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === arg.text) {
      declared += 1;
      if (node.questionToken || node.initializer) reasons.push(`the parameter "${arg.text}" is optional or has a default`);
      else {
        const owner = ownerOf(node);
        if (owner.name) helpers.push({ name: owner.name, index: owner.index, file, exported: owner.exported });
      }
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === arg.text) {
      declared += 1;
      if (node.initializer) reasons.push(`the destructured "${arg.text}" has a default`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (declared === 0) return `"${arg.text}" is not declared in this file`;
  return reasons.length ? reasons.join("; ") : null;
}

interface Census {
  calls: number;
  files: number;
  helperCalls: number;
  helpers: string[];
  violations: string[];
}

/** Rules 2 and 3 over a set of files (path → text). */
function census(files: Map<string, string>): Census {
  const parsed = new Map([...files].map(([file, text]) => [file, parse(file, text)] as const));
  const at = (sf: ts.SourceFile, node: ts.Node) =>
    `${relative(REPO, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const violations: string[] = [];
  const helpers: Helper[] = [];
  const filesWithCalls = new Set<string>();
  let calls = 0;

  for (const [file, sf] of parsed) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (FORMATTERS as readonly string[]).includes(node.expression.text)) {
        calls += 1;
        filesWithCalls.add(file);
        const why = unsoundLocale(node.arguments[1], sf, file, helpers);
        if (why) violations.push(`${at(sf, node)}  ${node.expression.text}: ${why}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Rule 3, to a fixed point: a helper's caller may itself pass a parameter.
  const seen = new Set<string>();
  let helperCalls = 0;
  for (let i = 0; i < helpers.length; i += 1) {
    const helper = helpers[i];
    const key = `${helper.file}#${helper.name}#${helper.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [file, sf] of parsed) {
      const imports = new RegExp(`import\\s*\\{[^}]*\\b${helper.name}\\b[^}]*\\}`).test(sf.text);
      if (file !== helper.file && !(helper.exported && imports)) continue;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === helper.name) {
          helperCalls += 1;
          const why = unsoundLocale(node.arguments[helper.index], sf, file, helpers);
          if (why) violations.push(`${at(sf, node)}  ${helper.name} (hands its locale to a month formatter): ${why}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return { calls, files: filesWithCalls.size, helperCalls, helpers: [...seen].map((k) => k.split("#")[1]).sort(), violations };
}

describe("period-month-locale — the source", () => {
  it("neither formatter declares its locale optional, or with a default", () => {
    const sf = parse(join(FRONTEND, "lib", "orgPeriods.ts"));
    const found: string[] = [];
    sf.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name && (FORMATTERS as readonly string[]).includes(node.name.text)) {
        const locale = node.parameters[1];
        expect(locale?.name.getText(), node.name.text).toBe("locale");
        expect(!!locale.initializer, `${node.name.text}: a default locale`).toBe(false);
        expect(!!locale.questionToken, `${node.name.text}: an optional locale`).toBe(false);
        found.push(node.name.text);
      }
    });
    expect(found.sort()).toEqual([...FORMATTERS].sort());
  });

  it("the rule sees each way a locale goes missing — on a file made for it", () => {
    const file = join(FRONTEND, "made-up.tsx");
    const text = [
      'import { formatPeriodMonth, formatPeriodMonthLoose } from "@/lib/orgPeriods";',
      'import { activeLocale, useActiveLocale } from "@/lib/locale";',
      "function Good() { const locale = useActiveLocale(); return formatPeriodMonth(end, locale); }",
      "const plain = () => formatPeriodMonthLoose(end, activeLocale());",
      "function helper(end: string, locale: string) { return formatPeriodMonth(end, locale); }",
      "const viaHelper = () => { const locale = useActiveLocale(); return helper(end, locale); };",
      "const forgot = () => formatPeriodMonth(end);",
      'const written = () => formatPeriodMonth(end, "en-GB");',
      'function Fixed() { const lang = "ro-RO"; return formatPeriodMonth(end, lang); }',
      "function optional(end: string, loc?: string) { return formatPeriodMonth(end, loc); }",
      'function defaulted(end: string, where = "en-GB") { return formatPeriodMonth(end, where); }',
      'const helperWritten = () => helper(end, "en-GB");',
      "const helperForgot = () => helper(end);",
      "const elsewhere = () => formatPeriodMonth(end, imported);",
    ].join("\n");
    const result = census(new Map([[file, text]]));
    expect(result.calls).toBe(9);
    expect(result.helpers).toEqual(["helper"]);
    expect(result.helperCalls).toBe(3);
    expect(result.violations.map((v) => v.replace(/^\S+\s+/, ""))).toEqual([
      "formatPeriodMonth: no locale passed",
      'formatPeriodMonth: a written locale ("en-GB")',
      'formatPeriodMonth: "lang" is declared as "ro-RO"',
      'formatPeriodMonth: the parameter "loc" is optional or has a default',
      'formatPeriodMonth: the parameter "where" is optional or has a default',
      'formatPeriodMonth: "imported" is not declared in this file',
      'helper (hands its locale to a month formatter): a written locale ("en-GB")',
      "helper (hands its locale to a month formatter): no locale passed",
    ]);
  });

  it("every call of the month formatters, and of each helper that passes a locale on, takes the UI language's", () => {
    const files = new Map(sourceFiles().map((file) => [file, readFileSync(file, "utf8")] as const));
    const result = census(files);
    // eslint-disable-next-line no-console
    console.log(
      `GATE-WORK period-month-locale calls=${result.calls} files=${result.files} ` +
        `helpers=${result.helpers.join(",") || "none"} helper_calls=${result.helperCalls} violations=${result.violations.length}`,
    );
    expect(result.violations).toEqual([]);
    // The walk found the call sites it exists for.
    expect(result.calls).toBeGreaterThan(0);
    const callers = [...files.keys()].filter((f) => /\bformatPeriodMonth(Loose)?\(/.test(files.get(f)!)).map((f) => relative(FRONTEND, f));
    for (const known of ["components/cfo/PeriodBreadcrumb.tsx", "lib/usePeriodStepper.ts", "pages/cfo/FinancialStatements.tsx"]) {
      expect(callers, known).toContain(known);
    }
  });

  it("the upload dialog's month (formatDetectedMonth) is formatted with the active locale", () => {
    const sf = parse(join(FRONTEND, "lib", "detectPeriodEnd.ts"));
    let localeArgs: string[] = [];
    const visit = (node: ts.Node, inside: boolean) => {
      const here = inside || (ts.isFunctionDeclaration(node) && node.name?.text === "formatDetectedMonth");
      if (here && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "toLocaleDateString") {
        localeArgs = [...localeArgs, node.arguments[0]?.getText() ?? ""];
      }
      ts.forEachChild(node, (child) => visit(child, here));
    };
    visit(sf, false);
    expect(localeArgs).toEqual(["activeLocale()"]);
  });
});

// ── Rendered ───────────────────────────────────────────────────────────

const STATEMENTS = { companyName: "Exemplu SRL", periodLabel: "2024-12-31", currency: "RON" } as unknown as Statements;

function header() {
  return render(
    <CompactPeriodHeader
      statements={STATEMENTS}
      invoices={null}
      activeSampleId={null}
      onPickSample={() => {}}
      onTriggerFile={() => {}}
      onReset={() => {}}
    />,
  );
}
const headerText = () => screen.getByTestId("compact-period-header").textContent ?? "";

function Stepper() {
  const s = usePeriodStepper();
  return (
    <div>
      <output data-testid="selected-month">{s.selectedMonth}</output>
      <button type="button" onClick={() => s.goToPeriod("p-2023")}>go</button>
    </div>
  );
}
function stepper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/dashboard?period=p-2024"]}>
        <Stepper />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("period-month-locale — rendered", () => {
  it("the three printers: Romanian in Romanian, English in English — the same month", () => {
    expect(formatPeriodMonth("2024-12-31", "en-GB")).toBe("Dec 2024");
    expect(formatPeriodMonth("2024-12-31", "ro-RO")).toMatch(/^dec\.? 2024$/);
    expect(formatPeriodMonthLoose("2050-06-30", "ro-RO")).toMatch(/^iun\.? 2050$/);
    expect(formatPeriodMonth("2050-06-30", "ro-RO")).toBeNull(); // the strict one still refuses the year
    expect(formatDetectedMonth("2025-03-15")).toBe("March 2025");
  });

  it("ro: formatDetectedMonth names the month in Romanian", async () => {
    await act(async () => {
      await i18n.changeLanguage("ro");
    });
    expect(formatDetectedMonth("2025-03-15")).toBe("martie 2025");
    expect(formatDetectedMonth("2025-03-15")).not.toMatch(/March/);
  });

  it("ro: the dashboard's header prints the period's month in Romanian — the breadcrumb's own string", async () => {
    await act(async () => {
      await i18n.changeLanguage("ro");
    });
    header();
    expect(headerText()).toContain("Exemplu SRL");
    expect(headerText()).toMatch(/· dec\.? 2024/);
    expect(headerText()).not.toMatch(ENGLISH_MONTH);
    // What the breadcrumb beside it prints (PeriodBreadcrumb: the same
    // formatter with the active locale).
    expect(headerText()).toContain(formatPeriodMonth("2024-12-31", "ro-RO"));
  });

  it("en: the same header prints the English month — and follows a language switch while mounted", async () => {
    header();
    expect(headerText()).toContain("· Dec 2024");
    expect(headerText()).not.toMatch(ROMANIAN_MONTH);
    await act(async () => {
      await i18n.changeLanguage("ro");
    });
    expect(headerText()).toMatch(/· dec\.? 2024/);
    expect(headerText()).not.toMatch(ENGLISH_MONTH);
  });

  // FOUND BY THIS FILE'S FIRST RUN: `new Date("FY 2024")` is a valid date
  // in V8 (1 January 2024, LOCAL time), so the header printed "dec. 2023"
  // for the label "FY 2024" east of Greenwich — and "Decembrie 2024" came
  // out as November. The formatters now read served dates only.
  it("a label that is not a served date is never read as one — the header leaves it as written", async () => {
    const LABELS = ["FY 2024", "Decembrie 2024", "Dec 2024", "2024", "31.12.2024", "Imported period", "12 invoices"];
    for (const label of LABELS) {
      for (const locale of ["en-GB", "ro-RO"]) {
        expect(formatPeriodMonth(label, locale), label).toBeNull();
        expect(formatPeriodMonthLoose(label, locale), label).toBeNull();
      }
    }
    // What the engine serves is still read: a date, and a timestamp.
    expect(formatPeriodMonth("2024-12-31", "en-GB")).toBe("Dec 2024");
    expect(formatPeriodMonth("2024-12-31T00:00:00+00:00", "en-GB")).toBe("Dec 2024");
    expect(formatPeriodMonthLoose("2024-12-31 00:00:00", "en-GB")).toBe("Dec 2024");

    await act(async () => {
      await i18n.changeLanguage("ro");
    });
    for (const label of ["FY 2024", "Decembrie 2024"]) {
      render(
        <CompactPeriodHeader
          statements={{ ...STATEMENTS, periodLabel: label } as Statements}
          invoices={null}
          activeSampleId={null}
          onPickSample={() => {}}
          onTriggerFile={() => {}}
          onReset={() => {}}
        />,
      );
      expect(headerText()).toContain(`· ${label}`);
      cleanup();
    }
  });

  it("ro: the stepper's month, and the label it hands the period-switch overlay, are Romanian", async () => {
    await act(async () => {
      await i18n.changeLanguage("ro");
    });
    stepper();
    expect(screen.getByTestId("selected-month").textContent).toMatch(/^dec\.? 2024$/);
    fireEvent.click(screen.getByText("go"));
    expect(startPeriodSwitch).toHaveBeenCalledTimes(1);
    const label = String(startPeriodSwitch.mock.calls[0][0]);
    expect(label).toMatch(/^iun\.? 2023$/);
    expect(label).not.toMatch(ENGLISH_MONTH);
  });

  it("en: the stepper's month and the overlay's label are English", () => {
    stepper();
    expect(screen.getByTestId("selected-month").textContent).toBe("Dec 2024");
    fireEvent.click(screen.getByText("go"));
    expect(startPeriodSwitch).toHaveBeenCalledWith("Jun 2023");
  });
});
