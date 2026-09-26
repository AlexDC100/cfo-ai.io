// A refusal of the comparison is a plain sentence for its CODE — never the
// engine's message (live walkthrough, 2026-09-26: EEI's Overview printed "No
// comparison: period '<uuid>' is not in this workspace", Scandia's raw
// period id included).
//
// Fails on: a refusal code without a sentence in either language; the export
// English drifting from en.json; the statement tabs' note printing anything
// but the code's sentence.
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { ComparativesRefusedNote } from "@/components/cfo/ComparativesPanel";
import {
  COMPARISON_REFUSAL_CODES,
  COMPARISON_REFUSAL_ENGLISH,
  comparisonRefusalEnglish,
  comparisonRefusalKey,
} from "@/lib/comparisonRefusal";

const locale = (lang: string) =>
  JSON.parse(readFileSync(resolve(__dirname, `../../i18n/locales/${lang}.json`), "utf8"));
const at = (tree: Record<string, unknown>, key: string): unknown =>
  key.split(".").reduce<unknown>((node, k) => (node && typeof node === "object" ? (node as Record<string, unknown>)[k] : undefined), tree);

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("every refusal code reads as a sentence, in both languages", () => {
  const keys = [...COMPARISON_REFUSAL_CODES.map(comparisonRefusalKey), comparisonRefusalKey("a_code_the_route_may_add")];

  it.each(["en", "ro"])("%s carries a sentence for every code and for the general case", (lang) => {
    for (const key of keys) {
      const sentence = at(locale(lang), key);
      expect(typeof sentence === "string" && sentence.length > 0, `${lang}: ${key}`).toBe(true);
      expect(String(sentence)).not.toMatch(/workspace|spațiu de lucru/i);
    }
  });

  it("the exports' English is en.json's, word for word", () => {
    for (const [key, sentence] of Object.entries(COMPARISON_REFUSAL_ENGLISH)) {
      expect(at(locale("en"), key), key).toBe(sentence);
    }
    expect(comparisonRefusalEnglish("period_not_in_workspace")).toBe("The comparison period belongs to another company.");
    expect(comparisonRefusalEnglish(undefined)).toBe("These two periods can't be compared.");
  });
});

describe("the statement tabs' note", () => {
  it("prints the sentence for the code", () => {
    render(<ComparativesRefusedNote code="period_not_in_workspace" />);
    expect(screen.getByTestId("comparatives-refused").textContent).toBe(
      "Comparison unavailable: The comparison period belongs to another company.",
    );
  });

  it("an unknown code reads the general sentence", () => {
    render(<ComparativesRefusedNote code="another_code" />);
    expect(screen.getByTestId("comparatives-refused").textContent).toBe(
      "Comparison unavailable: These two periods can't be compared.",
    );
  });

  it("in Romanian", async () => {
    await i18n.changeLanguage("ro");
    render(<ComparativesRefusedNote code="period_not_in_workspace" />);
    expect(screen.getByTestId("comparatives-refused").textContent).toBe(
      "Comparația nu este disponibilă: Perioada de comparație aparține altei companii.",
    );
  });
});
