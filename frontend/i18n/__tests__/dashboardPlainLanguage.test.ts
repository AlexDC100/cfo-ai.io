// Plain language on the analysed dashboard (workspace redesign, 2026-09-26).
//
// The redesign's screens never say "source" or "attachment" (either
// language): a file is a file, and where a value came from is a plain
// phrase. The danger zone at the bottom of the ANALYSED dashboard still said
// "The source files stay in Recently deleted…" / "Fișierele sursă rămân…",
// and called the company a workspace. These are the strings that zone and
// its wipe dialog render (`dash.*`, FinancialStatements' DangerZone).
//
// Fails on: any of them carrying source / attachment / sursă / atașament, or
// "workspace" / "spațiu de lucru" — in either language.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = /\b(source|sources|attachment|attachments|sursă|sursa|surse|atașament|atasament|atașamente)\b/i;
const NOT_A_COMPANY = /\b(workspaces?|workspace-ul(?:ui)?|spa[țt]i(?:u|ul|i|ile)(?:\s+de\s+lucru)\b|spa[țt]i(?:u|ul|i|ile) de lucru)\b/i;

const DANGER_ZONE_KEYS = [
  "dangerZone",
  "dangerZoneBody",
  "wipeButtonTitle",
  "wipeData",
  "wipeDialogTitle",
  "wipeDialogBody1",
  "wipeDialogBody2",
  "filesMovedRecentlyDeleted",
  "wipeFailedTitle",
  "alreadyCleanTitle",
  "alreadyCleanBody",
  "deleteAllPeriods",
];

function dashStrings(lang: "en" | "ro"): Record<string, string> {
  const file = resolve(__dirname, `../locales/${lang}.json`);
  const dash = (JSON.parse(readFileSync(file, "utf8")) as { dash: Record<string, string> }).dash;
  return Object.fromEntries(DANGER_ZONE_KEYS.map((k) => [k, dash[k]]));
}

describe("the analysed dashboard's danger zone speaks plainly", () => {
  for (const lang of ["en", "ro"] as const) {
    it(`${lang}: every string exists and names no source, attachment or workspace`, () => {
      const strings = dashStrings(lang);
      const missing = Object.entries(strings).filter(([, v]) => typeof v !== "string" || !v.trim()).map(([k]) => k);
      expect(missing, "danger-zone strings the dashboard renders").toEqual([]);
      const offenders = Object.entries(strings)
        .filter(([, v]) => FORBIDDEN.test(v) || NOT_A_COMPANY.test(v))
        .map(([k, v]) => `${k}: ${v}`);
      expect(offenders).toEqual([]);
    });
  }
});
