// copyHygiene.test.ts — cheap regex sweep that runs at test time and
// fails the build if forbidden copy slips back in.
//
// Spec §1 visual reference uses dark-premium health-app screenshots,
// but explicitly requires REMOVING all medical wording. Spec §6 also
// requires NO recurring €0.99 anywhere. A grep test is the bluntest
// way to enforce that: it catches typos, copy-paste-from-screenshot
// regressions, and AI-generated drift.
//
// What we sweep:
//   · `src/components/cfo/pricing/**/*.tsx`
//   · `src/components/cfo/pricing/**/*.ts` (excluding this test file)
//   · `src/pages/cfo/Pricing.tsx`
//   · `src/pages/cfo/Landing.tsx`
//
// Forbidden bands:
//   1. health-app residue: health, specialist, cases, clinician,
//      household, medical, diagnosis, patient
//   2. recurring intro: €0.99/month, 0.99/month, monthly €0.99
//
// What's allowed:
//   · The literal "Not a subscription" copy in IntroUnlockCallout
//   · "subscription" used in spec answers ("Is the €0.99 Intro Unlock
//     a subscription? Answer: No.") — substring matches against words
//     are scoped to the forbidden list above; "subscription" is NOT
//     on it (it's a fine word to use).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "../../../../..");  // → scandi-desk-main/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      // Skip the test directory itself so the test file's forbidden-word
      // STRINGS (which it must contain to test for them) don't fail
      // the sweep.
      if (entry === "__tests__") continue;
      walk(p, out);
    } else if (s.isFile() && /\.(tsx?|ts)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

function collectTargets(): string[] {
  const targets: string[] = [];
  const pricingDir = join(ROOT, "src/components/cfo/pricing");
  walk(pricingDir, targets);
  // Pricing + Landing pages
  targets.push(join(ROOT, "src/pages/cfo/Pricing.tsx"));
  targets.push(join(ROOT, "src/pages/cfo/Landing.tsx"));
  return targets.filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Strip TS/JS comments before sweeping so a code comment that QUOTES a
 *  forbidden string (e.g. `// Never use "€0.99/month"`) doesn't trip the
 *  test. We strip block comments first (greedy across lines, non-greedy
 *  inside), then line comments. Imperfect (regex can't handle commented
 *  strings inside strings) but good enough — only the RENDERED output
 *  needs to be hygienic, and rendered output cannot live inside comments. */
function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return out;
}

const HEALTH_WORDS = [
  "health",
  "specialist",
  "clinician",
  "household",
  "medical",
  "diagnosis",
  "patient",
] as const;

// "cases" is harder — it's a real English word that could appear in code
// comments innocuously ("in some cases"). We restrict the sweep to
// SCREEN-VISIBLE strings: JSX text children + string literals that look
// like user-facing copy. The pragmatic version: ban the phrase "cases
// this month" + "cases per month" which are the exact health-app
// patterns from the screenshots.
const HEALTH_PHRASES = [
  /cases\s+(this|per)\s+month/i,
  /case[s]?\s+remaining/i,
];

describe("copy hygiene — pricing surfaces", () => {
  const files = collectTargets();

  it("locates pricing surface files (sanity)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("contains no health-app vocabulary in rendered code (comments excluded)", () => {
    const offences: string[] = [];
    for (const file of files) {
      const text = stripComments(readFileSync(file, "utf8"));
      // Whole-word boundaries so "metadata" ≠ "medical", "subscription"
      // ≠ "patient", etc.
      for (const w of HEALTH_WORDS) {
        const rx = new RegExp(`\\b${w}\\b`, "i");
        if (rx.test(text)) {
          offences.push(`${file}: word "${w}"`);
        }
      }
      for (const phrase of HEALTH_PHRASES) {
        if (phrase.test(text)) {
          offences.push(`${file}: phrase /${phrase.source}/`);
        }
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("never renders €0.99 as a recurring/monthly price (comments excluded)", () => {
    const offences: string[] = [];
    const RECURRING_099 = [
      /€\s*0\.99\s*\/\s*month/i,
      /€\s*0\.99\s*per\s*month/i,
      /0\.99\s*\/\s*mo\b/i,
      /monthly\s*€\s*0\.99/i,
      /recurring\s*€\s*0\.99/i,
    ];
    for (const file of files) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const rx of RECURRING_099) {
        if (rx.test(text)) {
          offences.push(`${file}: ${rx.source}`);
        }
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });
});
