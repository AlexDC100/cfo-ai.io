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
 *   R2  no `amount_minor` / `amountMinor` / `as unknown as number` — the wire
 *       amount or the opaque amount reached around the gateway;
 *   R3  no arithmetic operator beside a MONEY-named operand (amount, minor,
 *       ebitda, cash, revenue, fcf, funding, profit, interest, capex, debt,
 *       bridge, revolver, income), and no `Math.*` applied to one;
 *   R4  the PAINTERS reach no value at all: they NAME none of the doors
 *       (`cockpitDisplay`, `cockpitPlot`, and the fp1 lane's `unwrapProjected`,
 *       `projectedDisplay`) — they paint the engine's own formatted text, or
 *       hand an amount to <CockpitAmountView>;
 *   R5  each DOOR has exactly one user of each kind: <CockpitAmountView>
 *       displays (one `cockpitDisplay`), the CHART plots (one `cockpitPlot`,
 *       in `plotValue`, and formats no number itself), the BANK EXPORT paints
 *       once (`cockpitDisplay`, in `paint`) and plots once (`cockpitPlot`, in
 *       `plotValue`); the GATEWAY (lib/forecastCockpit.ts) opens the opaque
 *       amount in exactly two places and divides minor units by 100 in
 *       exactly one;
 *   R6  THE ROSTER IS WHOLE: every non-test file under
 *       components/forecast/cockpit/ is scanned — a new cockpit module cannot
 *       slip in unexamined.
 *
 * PLANT-PROVEN: the planted snippets below each red their rule; the real-file
 * plants are logged in docs/engine_book/gates.md "forecast-cockpit-no-math".
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
const DOORS = /\b(cockpitDisplay|cockpitPlot|unwrapProjected|projectedDisplay)\b/g;
const COCKPIT_DIR = "frontend/components/forecast/cockpit";

const MONEY = /(amount|minor|ebitda|cash|revenue|fcf|funding|profit|interest|capex|debt|bridge|revolver|income)/i;

/** Source as code only: comments gone, literal TEXT blanked, `${}` kept. */
export function codeOnly(src: string): string {
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
      out += src[i] === "\n" ? "\n" : " ";
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
        out += " ";
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
  for (const m of code.matchAll(/\bamount_minor\b|\bamountMinor\b|as\s+unknown\s+as\s+number/g)) {
    hit("R2 wire/opaque amount", m.index ?? 0, m[0]);
  }
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
  });

  it("R5: the GATEWAY opens the opaque amount in exactly two places and divides once", () => {
    const code = codeOnly(read(GATEWAY));
    expect(count(code, /\.reduce\s*\(/g), "a fold in the gateway").toBe(0);
    expect(count(code, /as\s+unknown\s+as\s+number/g), "the two doors, and nowhere else").toBe(2);
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

  it("a PAINTER planted with a door, or an alias of one, reds R4", () => {
    expect(codeOnly("const x = cockpitPlot(a);").match(DOORS)).toEqual(["cockpitPlot"]);
    expect(codeOnly("const door = cockpitDisplay; door(a, (v) => v);").match(DOORS)).toEqual(["cockpitDisplay"]);
    expect(codeOnly("const y = unwrapProjected(f, b, (m) => m);").match(DOORS)).toEqual(["unwrapProjected"]);
    // …but the NAME in a comment or a string is prose, not a door
    expect(codeOnly('// cockpitDisplay is the door\nconst s = "cockpitPlot";').match(DOORS)).toBeNull();
  });
});
