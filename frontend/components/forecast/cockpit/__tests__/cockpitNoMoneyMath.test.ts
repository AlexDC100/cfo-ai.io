/**
 * GATE forecast-cockpit-no-math — THE COCKPIT PAGE DOES NO ARITHMETIC ON MONEY.
 *
 * The owner's rule for the Forecast cockpit (2026-09-21): every number comes
 * from the engine that also produces the bank report; a client-side cascade is
 * the exact defect that broke Scenarios (Recession cash −107.6M). The type
 * barrier (`ProjectedMinor`, lib/forecastFacts.ts) makes `a + b` over two
 * projected amounts a compile error; this is the SOURCE half, for the escapes a
 * type cannot see: a figure unwrapped into a plain number and combined, a wire
 * amount read around the gateway, a `.reduce` summing a list, a cast.
 *
 * Each cockpit source is read as CODE ONLY — comments removed, string, template
 * and regex literal text blanked (a template's `${…}` expressions are KEPT, so
 * arithmetic inside one is still seen), hyphenated JSX attribute names blanked
 * (`data-funding-gap=` is not a subtraction). Then:
 *
 *   R1  no `.reduce(` — a list folded into a total;
 *   R2  no `amount_minor` / `amountMinor` (the wire amount read around the
 *       gateway), no `as unknown as …` AT ALL (any laundering cast — not only
 *       to `number`: the 2026-09-26 verifier plant forged a CockpitMinor from
 *       a derived number with `as unknown as CockpitMinor`), and no cast to
 *       the opaque types (`as CockpitMinor`, `as ProjectedMinor`);
 *   R3  no arithmetic operator beside a MONEY-named operand (amount, minor,
 *       ebitda, cash, revenue, fcf, funding, profit, interest, capex, debt,
 *       bridge, revolver, income), and no `Math.*` applied to one;
 *   R4  the PAINTERS reach no value at all: they NAME none of the doors
 *       (`cockpitDisplay`, `cockpitPlot`, the chart's `plotValue`, and the
 *       fp1 lane's `unwrapProjected`, `projectedDisplay`) — they paint the
 *       engine's own formatted text, or hand an amount to <CockpitAmountView>;
 *   R5  each DOOR has exactly one user of each kind: <CockpitAmountView>
 *       displays (one `cockpitDisplay`), the CHART plots (one `cockpitPlot`,
 *       in `plotValue`, and formats no number itself), the BANK EXPORT paints
 *       once (`cockpitDisplay`, in `paint`) and plots once (`cockpitPlot`, in
 *       `plotValue`); `plotValue` itself is a door — ONE call per geometry
 *       site (the bar, the cash point, the gap), each fed a SERVED amount,
 *       and the gap site reads the engine's `cashBeforeFunding`, never a
 *       subtraction; the GATEWAY (lib/forecastCockpit.ts) opens the opaque
 *       amount in exactly two places, seals it in exactly two, and divides
 *       minor units by 100 in exactly one;
 *   R6  THE ROSTER IS WHOLE: every non-test file under
 *       components/forecast/cockpit/ is scanned — a new cockpit module cannot
 *       slip in unexamined;
 *   R7  no AMOUNT LITERAL outside the gateway: an object literal carrying a
 *       `minor:` key, or `kind: "projected"` / `kind: "actual"` — a
 *       CockpitAmount is made only by lib/forecastCockpit.ts from served
 *       bytes, never assembled in a painter and handed to <CockpitAmountView>
 *       (string literal text is KEPT for this rule, comments still dropped);
 *   R8  no PLOTTED VALUE COMBINED: `plotValue(…)` / `cockpitPlot(…)` never
 *       stands beside an arithmetic operator, cast or not.
 *
 * PLANT-PROVEN: the planted snippets below each red their rule; the real-file
 * plants are logged in docs/engine_book/gates.md "forecast-cockpit-page"
 * (2026-09-26: the verifier's PC — the chart deriving the gap behind
 * `plotValue` and painting a forged CockpitAmount — passed R1–R6 and is what
 * R2's widening, R7 and R8 exist for).
 * CANNOT SEE: arithmetic on a money value held under a neutral name (`v`,
 * `value`) outside the chart and export geometry — that is what the opaque
 * type is for; a dynamic import built from a string.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../../..");

const PAINTERS = [
  "frontend/pages/cfo/Forecast.tsx",
  "frontend/components/forecast/cockpit/CaseBridge.tsx",
  "frontend/components/forecast/cockpit/CaseSwitch.tsx",
  "frontend/components/forecast/cockpit/CockpitAppendix.tsx",
  "frontend/components/forecast/cockpit/HeadlineNumbers.tsx",
  "frontend/components/forecast/cockpit/LeverSliders.tsx",
  "frontend/components/forecast/cockpit/PresentMode.tsx",
  "frontend/components/forecast/cockpit/ProjectedText.tsx",
  "frontend/components/forecast/cockpit/format.ts",
  "frontend/components/forecast/cockpit/useCockpit.ts",
  "frontend/lib/forecastCases.ts",
];
const AMOUNT = "frontend/components/forecast/cockpit/CockpitAmountView.tsx";
const CHART = "frontend/components/forecast/cockpit/CockpitChart.tsx";
const EXPORT = "frontend/lib/forecastBankExport.ts";
const GATEWAY = "frontend/lib/forecastCockpit.ts";
const DOORS = /\b(cockpitDisplay|cockpitPlot|plotValue|unwrapProjected|projectedDisplay)\b/g;
/** An amount literal: the opaque field, or the served kind as a literal. */
const AMOUNT_LITERAL = /\bminor\s*:|\bkind\s*:\s*["'`](?:projected|actual)["'`]/g;
/** A plotted value beside an operator, cast or not. */
const PLOT = String.raw`(?:plotValue|cockpitPlot)\s*\([^()]*\)`;
const PLOTTED_COMBINED = new RegExp(
  String.raw`${PLOT}\s*(?:as\s+number\s*)?\)?\s*[-+*/%](?![=>])|(?<![=>+\-*/%<!])[-+*/%]\s*\(*\s*${PLOT}`,
  "g",
);
/** One `plotValue` call per geometry site, each fed a SERVED amount. */
const PLOT_SITES = /\bplotValue\s*\(\s*(?:p\.cash|p\.cashBeforeFunding|b\.amount)\s*\)/g;
const GAP_SITE = /gap:\s*p\.gap\s*\?\s*plotValue\(p\.cashBeforeFunding\)\s*:\s*null/;
const COCKPIT_DIR = "frontend/components/forecast/cockpit";

const MONEY = /(amount|minor|ebitda|cash|revenue|fcf|funding|profit|interest|capex|debt|bridge|revolver|income)/i;

/** Source as code only: comments gone, literal TEXT blanked, `${}` kept.
 *  With `keepLiterals` the text of string and template literals stays (R7
 *  reads a `kind: "projected"` literal); comments are still dropped. */
export function codeOnly(src: string, keepLiterals = false): string {
  let out = "";
  let i = 0;
  const n = src.length;
  // What the previous significant character was: decides whether a `/`
  // opens a regex literal or divides.
  let prevSig = "";
  const blankTo = (end: number, keepNewlines = true) => {
    for (; i < end && i < n; i += 1) out += keepNewlines && src[i] === "\n" ? "\n" : " ";
  };
  const templateStack: number[] = [];
  let braceDepth = 0;
  const readTemplateText = () => {
    // at a position inside template text; blank until ` or ${
    while (i < n) {
      if (src[i] === "\\") {
        blankTo(i + 2);
        continue;
      }
      if (src[i] === "`") {
        out += "`";
        i += 1;
        prevSig = "`";
        return;
      }
      if (src[i] === "$" && src[i + 1] === "{") {
        out += "${";
        i += 2;
        templateStack.push(braceDepth);
        braceDepth += 1;
        prevSig = "{";
        return;
      }
      out += src[i] === "\n" ? "\n" : keepLiterals ? src[i] : " ";
      i += 1;
    }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const end = src.indexOf("\n", i);
      blankTo(end === -1 ? n : end);
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      blankTo(end === -1 ? n : end + 2);
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i += 1;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          blankTo(i + 2);
          continue;
        }
        out += keepLiterals ? src[i] : " ";
        i += 1;
      }
      if (i < n) {
        out += src[i];
        i += 1;
      }
      prevSig = c;
      continue;
    }
    if (c === "`") {
      out += "`";
      i += 1;
      readTemplateText();
      continue;
    }
    if (c === "{") {
      braceDepth += 1;
    } else if (c === "}") {
      braceDepth -= 1;
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        out += "}";
        i += 1;
        readTemplateText();
        continue;
      }
    }
    if (c === "/" && /[(,=:[!&|?{};]|^$/.test(prevSig)) {
      // a regex literal: blank its body (and its flags stay code-inert)
      out += "/";
      i += 1;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") {
          blankTo(i + 2);
          continue;
        }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        out += " ";
        i += 1;
      }
      if (i < n && src[i] === "/") {
        out += "/";
        i += 1;
      }
      prevSig = "/r";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    i += 1;
  }
  // hyphenated JSX attribute names (data-funding-gap=, aria-label=) are names,
  // not subtractions
  return out.replace(/\b[a-zA-Z]+(?:-[a-zA-Z0-9]+)+(?=\s*=)/g, (m) => " ".repeat(m.length));
}

export interface Violation {
  rule: string;
  line: number;
  text: string;
}

const lineOf = (code: string, index: number) => code.slice(0, index).split("\n").length;

/** The rules every cockpit source obeys (R1–R3). */
export function moneyMathViolations(src: string): Violation[] {
  const code = codeOnly(src);
  const found: Violation[] = [];
  const hit = (rule: string, index: number, text: string) =>
    found.push({ rule, line: lineOf(code, index), text: text.trim() });
  for (const m of code.matchAll(/\.reduce\s*\(/g)) hit("R1 .reduce", m.index ?? 0, m[0]);
  for (const m of code.matchAll(/\bamount_minor\b|\bamountMinor\b|\bas\s+unknown\s+as\b|\bas\s+(?:CockpitMinor|ProjectedMinor)\b/g)) {
    hit("R2 wire/opaque amount", m.index ?? 0, m[0]);
  }
  for (const m of code.matchAll(PLOTTED_COMBINED)) hit("R8 a plotted value combined", m.index ?? 0, m[0]);
  const ident = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*`;
  const opAfter = new RegExp(String.raw`(${ident})\s*(\+\+|--|[-+*/%](?![=>/*]))`, "g");
  for (const m of code.matchAll(opAfter)) {
    const tail = m[1].split(".").pop() ?? "";
    if (MONEY.test(tail)) hit("R3 arithmetic on a money operand", m.index ?? 0, m[0]);
  }
  const opBefore = new RegExp(String.raw`(?<![=>+\-*/%<!])([-+*/%])\s*(${ident})`, "g");
  for (const m of code.matchAll(opBefore)) {
    const operand = m[2];
    const tail = operand.split(".").pop() ?? "";
    if (MONEY.test(tail)) hit("R3 arithmetic on a money operand", m.index ?? 0, m[0]);
  }
  const compound = new RegExp(String.raw`(${ident})\s*[-+*/%]=\s*(${ident})`, "g");
  for (const m of code.matchAll(compound)) {
    const left = m[1].split(".").pop() ?? "";
    const right = m[2].split(".").pop() ?? "";
    if (MONEY.test(left) || MONEY.test(right)) hit("R3 compound assignment on money", m.index ?? 0, m[0]);
  }
  const mathOn = new RegExp(String.raw`Math\.\w+\(\s*(?:\.\.\.)?(${ident})`, "g");
  for (const m of code.matchAll(mathOn)) {
    const tail = m[1].split(".").pop() ?? "";
    if (MONEY.test(tail)) hit("R3 Math on a money operand", m.index ?? 0, m[0]);
  }
  return found;
}

/** R7 — an amount assembled outside the gateway (literal text kept). */
export function amountLiteralViolations(src: string): Violation[] {
  const code = codeOnly(src, true);
  return Array.from(code.matchAll(AMOUNT_LITERAL)).map((m) => ({
    rule: "R7 an amount literal outside the gateway",
    line: lineOf(code, m.index ?? 0),
    text: m[0].trim(),
  }));
}

const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");
const count = (code: string, re: RegExp) => (code.match(re) ?? []).length;

function listCockpitDir(): string[] {
  const root = resolve(REPO, COCKPIT_DIR);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "__tests__") walk(full);
      } else if (/\.(ts|tsx)$/.test(name)) {
        out.push(relative(REPO, full).split("\\").join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

describe("gate forecast-cockpit-no-math — the cockpit sources", () => {
  it("R6: every cockpit module is on the roster (nothing slips in unscanned)", () => {
    const rostered = new Set([...PAINTERS, AMOUNT, CHART, EXPORT, GATEWAY]);
    const onDisk = listCockpitDir();
    expect(onDisk.length, "vacuous: no cockpit module found").toBeGreaterThan(6);
    for (const f of onDisk) expect(rostered.has(f), `${f} is not on the no-math roster`).toBe(true);
  });

  it.each([...PAINTERS, AMOUNT, CHART, EXPORT])("%s: no .reduce, no wire amount, no arithmetic on money (R1–R3)", (path) => {
    const violations = moneyMathViolations(read(path));
    expect(violations, `${path}:\n${violations.map((v) => `  ${v.rule} @${v.line}: ${v.text}`).join("\n")}`).toEqual([]);
  });

  it.each([...PAINTERS, AMOUNT, CHART, EXPORT])("%s: no amount literal — a CockpitAmount is made only by the gateway (R7)", (path) => {
    const violations = amountLiteralViolations(read(path));
    expect(violations, `${path}:\n${violations.map((v) => `  ${v.rule} @${v.line}: ${v.text}`).join("\n")}`).toEqual([]);
  });

  it.each(PAINTERS)("%s reaches no value (R4)", (path) => {
    const code = codeOnly(read(path));
    // NAMED at all, not only called: an alias (`const f = cockpitDisplay`)
    // is the same door under another name (found by plant).
    expect(code.match(DOORS) ?? [], `${path} names a door to the amount`).toEqual([]);
  });

  const refs = (code: string, name: string) => count(code, new RegExp(`\\b${name}\\b`, "g"));
  const calls = (code: string, name: string) => count(code, new RegExp(`\\b${name}\\s*\\(`, "g"));

  it("R5: <CockpitAmountView> displays once and plots never", () => {
    const code = codeOnly(read(AMOUNT));
    expect(calls(code, "cockpitDisplay")).toBe(1);
    expect(refs(code, "cockpitDisplay"), "the import and the one call — no alias").toBe(2);
    expect(refs(code, "cockpitPlot")).toBe(0);
    expect(refs(code, "unwrapProjected") + refs(code, "projectedDisplay")).toBe(0);
  });

  it("R5: the chart plots ONCE, for geometry, and formats no number itself", () => {
    const code = codeOnly(read(CHART));
    expect(calls(code, "cockpitPlot")).toBe(1);
    expect(refs(code, "cockpitPlot"), "the import and the one call — no alias").toBe(2);
    expect(/function\s+plotValue\s*\([^)]*\)[^{]*\{[^}]*cockpitPlot\s*\(/.test(code)).toBe(true);
    // plotValue is a door too: its definition and ONE call per geometry
    // site (the bar, the cash point, the gap), each fed a served amount; the
    // gap is the engine's cash-before-funding, never a subtraction
    expect(calls(code, "plotValue"), "the definition and the three geometry sites").toBe(4);
    expect(count(code, PLOT_SITES), "each call fed a SERVED amount").toBe(3);
    expect(GAP_SITE.test(code), "the gap site reads p.cashBeforeFunding as served").toBe(true);
    expect(refs(code, "cockpitDisplay") + refs(code, "unwrapProjected") + refs(code, "projectedDisplay")).toBe(0);
    for (const banned of ["toFixed(", "toLocaleString(", "Intl."]) {
      expect(code.includes(banned), `${CHART} formats a number with ${banned}`).toBe(false);
    }
    expect(code.includes("<CockpitAmountView")).toBe(true);
  });

  it("R5: the bank export paints once and plots once", () => {
    const code = codeOnly(read(EXPORT));
    expect(calls(code, "cockpitDisplay")).toBe(1);
    expect(refs(code, "cockpitDisplay")).toBe(2);
    expect(calls(code, "cockpitPlot")).toBe(1);
    expect(refs(code, "cockpitPlot")).toBe(2);
    expect(/function\s+paint\s*\([^)]*\)[^{]*\{[\s\S]*?cockpitDisplay\s*\(/.test(code)).toBe(true);
    expect(/function\s+plotValue\s*\([^)]*\)[^{]*\{[^}]*cockpitPlot\s*\(/.test(code)).toBe(true);
    expect(calls(code, "plotValue"), "the definition and the three geometry sites").toBe(4);
    expect(count(code, PLOT_SITES), "each call fed a SERVED amount").toBe(3);
    expect(GAP_SITE.test(code), "the gap site reads p.cashBeforeFunding as served").toBe(true);
  });

  it("R5: the GATEWAY opens the opaque amount in exactly two places and divides once", () => {
    const code = codeOnly(read(GATEWAY));
    expect(count(code, /\.reduce\s*\(/g), "a fold in the gateway").toBe(0);
    expect(count(code, /as\s+unknown\s+as\s+number/g), "the two doors, and nowhere else").toBe(2);
    expect(count(code, /as\s+unknown\s+as\s+CockpitMinor/g), "sealed in exactly two places (amountOf, bookAmount)").toBe(2);
    expect(count(code, /as\s+unknown\s+as\b/g), "no other laundering cast in the gateway").toBe(4);
    expect(count(code, /\/\s*100\b/g), "the one division, minor to major").toBe(1);
    // every money arithmetic the scan finds is that one division
    const money = moneyMathViolations(read(GATEWAY)).filter((v) => v.rule.startsWith("R3"));
    expect(money.map((v) => v.text.replace(/\s+/g, " "))).toEqual(["minor /"]);
  });
});

describe("gate forecast-cockpit-no-math — plants (each must red its rule)", () => {
  const PLANTS: Array<[string, string, RegExp]> = [
    ["a total of two headline amounts", "const total = headline.ebitdaFinal.amount + view.bridge;", /R3/],
    ["a browser cash cascade", "const cash = opening - capexOut + ebitda;", /R3/],
    ["a template that sums", "const s = `${cash + 1} RON`;", /R3/],
    ["a negated funding line", "const gap = -fundingLine;", /R3/],
    ["a list folded into a total", "const fcf = points.reduce((s, p) => s + p, 0);", /R1/],
    ["the wire amount read around the gateway", "const v = raw.amount_minor;", /R2/],
    ["the opaque amount laundered", "const v = fig.amountMinor as unknown as number;", /R2/],
    ["Math over a money operand", "const big = Math.abs(cashBeforeFunding);", /R3/],
    ["compound assignment onto money", "let t = 0; t += interest;", /R3/],
    // 2026-09-26, the verifier's PC: a forged amount and a gap derived behind plotValue
    ["the opaque amount forged from a derived number", "const d = { kind: p.kind, period: p.period, minor: (x - y) as unknown as CockpitMinor, refusal: null };", /R2/],
    ["a cast to the opaque type", "const m = n as CockpitMinor;", /R2/],
    ["the fp1 lane's opaque type cast", "const m = n as ProjectedMinor;", /R2/],
    ["any laundering cast, whatever the target", "const n = amt as unknown as bigint;", /R2/],
    ["two plotted values combined", "const g = (plotValue(p.cash) as number) - (plotValue(p.fundingLine) as number);", /R8/],
    ["a plotted value scaled", "const h = plotValue(b.amount) * 2;", /R8/],
    ["a plotted value on the right of an operator", "const k = 1 - cockpitPlot(a);", /R8/],
  ];
  it.each(PLANTS)("plant: %s", (_name, snippet, rule) => {
    const v = moneyMathViolations(snippet);
    expect(v.length, `the plant was not caught: ${snippet}`).toBeGreaterThan(0);
    expect(v.map((x) => x.rule).join(" "), snippet).toMatch(rule);
  });

  it("does NOT red on the names and prose this page is made of", () => {
    const clean = [
      '<div data-funding-gap={anyGap ? "true" : "false"} aria-label="cash - flow" />',
      "// cash + ebitda would be the defect\nconst a = 1;",
      '/* funding - interest */ const label = t("forecast.cockpit.numbers.fcf", "Free cash flow {{from}}–{{to}}");',
      "const re = /^(\\d{4})-(\\d{2})$/;",
      "const y = (v: number) => PAD_T + ((hi - v) / span) * (H - PAD_T - PAD_B);",
      "const f = `${yearLabel(p.period)}`;",
      "const ok = answer.roundTripMs;",
    ];
    for (const src of clean) expect(moneyMathViolations(src), src).toEqual([]);
  });

  it("an amount literal outside the gateway reds R7; the page's own literals do not", () => {
    const red = [
      'const d = { kind: "projected", period, minor: null, refusal: null };',
      "const d = { kind: p.kind, period, minor: v, refusal: null };",
      "const d = { kind: 'actual', period };",
      "const d = { minor: fig as unknown as CockpitMinor };",
    ];
    for (const src of red) expect(amountLiteralViolations(src).length, src).toBeGreaterThan(0);
    const clean = [
      'const a: ActiveCase = { kind: "engine", id };',
      "// kind: \"projected\" is the gateway's\nconst a = 1;",
      'const s = b.amount.kind === "actual" ? "x" : "y";',
      "<div data-kind={b.amount.kind} />",
    ];
    for (const src of clean) expect(amountLiteralViolations(src), src).toEqual([]);
  });

  it("a PAINTER planted with a door, or an alias of one, reds R4", () => {
    expect(codeOnly("const x = cockpitPlot(a);").match(DOORS)).toEqual(["cockpitPlot"]);
    expect(codeOnly("const x = plotValue(a);").match(DOORS)).toEqual(["plotValue"]);
    expect(codeOnly("const door = cockpitDisplay; door(a, (v) => v);").match(DOORS)).toEqual(["cockpitDisplay"]);
    expect(codeOnly("const y = unwrapProjected(f, b, (m) => m);").match(DOORS)).toEqual(["unwrapProjected"]);
    // …but the NAME in a comment or a string is prose, not a door
    expect(codeOnly('// cockpitDisplay is the door\nconst s = "cockpitPlot";').match(DOORS)).toBeNull();
  });
});
