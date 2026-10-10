// uploadGuide.test — the in-app upload surfaces name formats from
// coverage.json (lib/coverage.uploadGuideView), never from a typed list.
//
// WHAT THIS REDS ON (TC-11, after the repair):
//   · a format of a constructed-only row, or an accepted-but-untested one,
//     printed among the tested formats;
//   · a format list typed back into the dictionaries of the three upload
//     surfaces (the dashboard zone, /workspace, the upload flow's hint);
//   · the tab hints or the workspace copy offering a document the engine
//     does not read (a P&L, a balance sheet, an annual report, "financial
//     statements", a photo) or a sample that production does not ship.
// WHAT IT CANNOT SEE: a format typed into a component's JSX rather than
// into a dictionary — the gate `public-claims` renders those surfaces.
import { describe, it, expect } from "vitest";

import coverage from "@/data/coverage.json";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { realBooksOf, uploadGuideView, type CoverageRowData } from "@/lib/coverage";

const rows = (coverage as unknown as { rows: CoverageRowData[] }).rows;

function flat(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === "string") out.push([path, node]);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) flat(v, path ? `${path}.${k}` : k, out);
  }
}

describe("the upload guide is coverage.json's", () => {
  it("lists as tested only formats read on a real book", () => {
    const real = new Set<string>();
    for (const row of rows.filter((r) => r.category === "tested")) {
      const n = realBooksOf(row);
      if (typeof n === "number" && n > 0) row.formats.forEach((f) => real.add(f.toUpperCase()));
    }
    expect(real.size).toBeGreaterThan(0);
    for (const lang of ["en", "ro"]) {
      const v = uploadGuideView(lang);
      expect(v.testedFormats.split(" · ").sort()).toEqual([...real].sort());
      const untested = v.untestedFormats.split(" · ");
      expect(untested).toContain("CSV");
      expect(untested).toContain("XLS");
      for (const f of untested) expect(real.has(f), `${f} is both tested and untested`).toBe(false);
      expect(v.formatsLine).toContain(v.testedFormats);
      expect(v.formatsLine).toContain(v.untestedLine);
      expect(v.untestedDocument.length).toBeGreaterThan(10);
    }
    expect(uploadGuideView("en").untestedLine).toMatch(/not yet tested on a real file/);
    expect(uploadGuideView("ro").untestedLine).toMatch(/netestate pe un fișier real/);
  });

  it("prints the AI reader's availability from its row", () => {
    const ai = rows.find((r) => r.id === "ai_read");
    const v = uploadGuideView("en");
    if (ai?.availability === "unavailable") expect(v.aiReader).toBe("currently unavailable");
    else expect(v.aiReader).toBe("");
  });

  it("leaves no typed format list, untested document or sample offer in the upload dictionaries", () => {
    const typedFormat = /\bXLSX?\b|\.xlsx?\b|\bCSV\b|\.csv\b|\bPDF\b|photo|poză|fotografi/i;
    // Keys that may name ONE tested format in a sentence about that format,
    // or (zoneHintAi) a scan / photo beside the AI reader's own status.
    const mayNameAFormat = /^(?:wsV2\.drop\.zoneHintAi|ws\.unsupportedFileDesc|wsV2\.errors\.(?:unsupported|kind\.|kindNames\.)|errors\.unsupportedFormat|dash\.docTbWhere2|dash\.docStatutoryWhere1|dash\.docSales)/;
    const otherDocument = /financial statements?|situați(?:e|i|ile) financiare|annual report|raport anual|\bP&L\b|balance sheet|\bbilanț\b|load a sample|un exemplu pentru/i;
    const offenders: string[] = [];
    for (const [lang, dict] of [["en", en], ["ro", ro]] as const) {
      const lines: Array<[string, string]> = [];
      for (const ns of ["ws", "wsV2", "tabs"]) flat((dict as Record<string, unknown>)[ns], ns, lines);
      flat((dict as { dash: Record<string, unknown> }).dash.sizeLimit, "dash.sizeLimit", lines);
      for (const [path, text] of lines) {
        if (typedFormat.test(text) && !mayNameAFormat.test(path) && !/^wsV2\.(?:errors|history|card|progress|confirm)\./.test(path) && !/^ws\.(?:delete|file|doc)/.test(path)) {
          offenders.push(`${lang} ${path} types a format: "${text.slice(0, 120)}"`);
        }
        if (/^(?:tabs\.hint_|ws\.stepUploadBody|wsV2\.home\.subtitle|wsV2\.drop\.zoneHint)/.test(path) && otherDocument.test(text)) {
          offenders.push(`${lang} ${path} offers a document the engine does not read: "${text.slice(0, 120)}"`);
        }
      }
      const d = dict as unknown as { dash: Record<string, string>; ws: Record<string, string> };
      expect(d.dash.formatsLimit, `${lang} dash.formatsLimit is back`).toBeUndefined();
      expect(d.ws.uploadFormats, `${lang} ws.uploadFormats is back`).toBeUndefined();
      expect(d.dash.docTbShows).not.toMatch(/reconcil|\b22\b/i);
      expect(d.dash.docStatutoryShows).not.toMatch(/certified|certificate/i);
    }
    expect(offenders).toEqual([]);
  });
});
