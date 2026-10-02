// price.test — the one price printer (lib/price) and the one checks
// sentence (lib/uploadChecks), each held to its second reader.
//
// WHAT THESE RED ON (TC-11, after the repair):
//   · a price printed with a currency symbol, or with the wrong decimal
//     mark for the reader's language;
//   · lib/price's locale rule drifting from lib/money.moneyLocaleFor (the
//     module is dependency-free on purpose — node scripts load it — so the
//     rule is written twice and this is what keeps it one rule);
//   · the landing or the app naming the upload checks in words of its own
//     ("two checks", "cele două verificări") instead of the shared sentence.
import { describe, it, expect } from "vitest";

import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { moneyLocaleFor } from "@/lib/money";
import { PLAN_PRICES_EUR, formatPrice, priceLocaleFor } from "@/lib/price";
import { proofTokens } from "@/lib/engineProof";
import { UPLOAD_CHECKS_SENTENCE, uploadChecksSentence } from "@/lib/uploadChecks";
import { LANDING_STRINGS, landingStringsFor } from "@/pages/cfo/landingStrings";

const NBSP = " ";

describe("the one price printer", () => {
  it("prints the code after the figure, in the reader's number format", () => {
    expect(formatPrice(4.99, "en")).toBe(`4.99${NBSP}EUR`);
    expect(formatPrice(4.99, "ro")).toBe(`4,99${NBSP}EUR`);
    expect(formatPrice(0, "en")).toBe(`0.00${NBSP}EUR`);
    expect(formatPrice(1234.5, "en")).toBe(`1,234.50${NBSP}EUR`);
    expect(formatPrice(1234.5, "ro-RO")).toBe(`1.234,50${NBSP}EUR`);
  });

  it("never prints a currency symbol", () => {
    for (const lang of ["en", "ro"]) {
      for (const amount of Object.values(PLAN_PRICES_EUR)) {
        expect(formatPrice(amount, lang)).not.toMatch(/[€$]/);
      }
    }
  });

  it("uses lib/money's locale rule", () => {
    for (const lang of ["en", "en-GB", "ro", "ro-RO", "RO", "de", "", null, undefined]) {
      expect(priceLocaleFor(lang), String(lang)).toBe(moneyLocaleFor(lang ?? ""));
    }
  });

  it("fills every {price.*} token of the landing from the table", () => {
    for (const lang of ["en", "ro"] as const) {
      const tokens = proofTokens(lang);
      for (const [name, amount] of Object.entries(PLAN_PRICES_EUR)) {
        expect(tokens[`price.${name}`]).toBe(formatPrice(amount, lang));
      }
    }
  });
});

function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((v) => strings(v, out));
  else if (node && typeof node === "object") Object.values(node).forEach((v) => strings(v, out));
  return out;
}

describe("the one checks sentence", () => {
  it("names the three checks in both languages and counts none", () => {
    expect(UPLOAD_CHECKS_SENTENCE.en).toMatch(/debits.*credits.*balance sheet.*account 121/s);
    expect(UPLOAD_CHECKS_SENTENCE.ro).toMatch(/debitele.*creditele.*bilanțul.*contul 121/s);
    for (const s of Object.values(UPLOAD_CHECKS_SENTENCE)) {
      expect(s).not.toMatch(/\b(two|three|două|trei|2|3)\s+(checks|verificări)/i);
    }
    expect(uploadChecksSentence("ro-RO")).toBe(UPLOAD_CHECKS_SENTENCE.ro);
    expect(uploadChecksSentence(undefined)).toBe(UPLOAD_CHECKS_SENTENCE.en);
  });

  it("is what the landing prints, three times, through its token", () => {
    for (const lang of ["en", "ro"] as const) {
      const raw = strings(LANDING_STRINGS[lang]).filter((s) => s.includes("{checks.upload}"));
      expect(raw.length, `landingStrings[${lang}] uses of {checks.upload}`).toBe(3);
      const filled = strings(landingStringsFor(lang)).filter((s) => s.includes(UPLOAD_CHECKS_SENTENCE[lang]));
      expect(filled.length).toBe(3);
    }
  });

  it("is what the app prints: the receipt takes {{checks}}, and no surface counts the checks itself", () => {
    const dicts = { en, ro } as Record<string, { dash: Record<string, string> }>;
    for (const lang of ["en", "ro"]) {
      expect(dicts[lang].dash.accCleanPost).toContain("{{checks}}");
      expect(dicts[lang].dash.accUnknownBody).toContain("{{checks}}");
    }
    const own = /\b(?:the\s+)?two checks\b|\bcele două verificări\b|\bdouă verificări\b/i;
    const offenders = [
      ...strings(en).filter((s) => own.test(s)),
      ...strings(ro).filter((s) => own.test(s)),
      ...strings(LANDING_STRINGS.en).filter((s) => own.test(s)),
      ...strings(LANDING_STRINGS.ro).filter((s) => own.test(s)),
    ];
    expect(offenders).toEqual([]);
  });
});
