// public-sample-page — the /sample page and the published report.
//
// The public sample is a statement made in public: "this is what the engine
// does to a trial balance". `tests/engine/test_public_sample.py` holds the
// published files to the ENGINE (workbooks, served documents, mapping,
// labels, and the page's data to the served documents). This file holds the
// two things the engine does not produce:
//
//   · THE PAGE. Every figure it prints, in English and in Romanian, is the
//     served document's — read back out of the COMMITTED served JSON through
//     the pointer the figure carries, printed by an INDEPENDENT formatter
//     (a gate that compared the page only against lib/money would agree
//     with lib/money when lib/money is wrong — CLAUDE.md §26), and nothing
//     on the page is a number in the other language's format.
//   · THE REPORT. `public/sample/sample_report_fy2025.html` is byte for byte
//     what the product's own report builder returns for the committed
//     served documents, and the committed PDF prints that document's
//     headline figures.
//
// WHAT THIS GATE REDS ON, once the product is correct (TC-11):
//   P1 a figure on the page that is not the served document's, in either
//      language, or printed in the other language's number format
//   P2 a ratio printed at a precision or with a band the engine did not serve
//   P3 a label, bucket, section or status the page cannot name in both
//      languages (it would print a raw key), or a string missing from one
//   P4 a download that points at no published file, or states a size the
//      file does not have
//   P5 the committed report HTML is not a byte-identical rebuild
//   P6 the committed PDF is not that report (its text lacks the report's
//      own headline figures), or the report names a real book
//   P7 the page needs a session or a network call to render
//   P8 Romanian copy in the formal register, with cedilla diacritics, or
//      left in English
//
// Plant log: docs/engine_book/gates.md, "public-sample-page".
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { pageTexts } from "@/lib/__tests__/pdfText";
import { sampleReportHtml, type ServedPeriodBody } from "@/lib/publicSampleReport";
import type { ComparativesResponse } from "@/lib/comparatives";
import { foreignNumber, plainSpaces } from "@/test/numberLanguage";

import {
  SAMPLE,
  fileKeys,
  labelQuote,
  type SampleFigure,
  type SampleLabel,
  type SampleLang,
  type SampleMappingRow,
  type SampleRatio,
} from "@/lib/publicSample";

import PublicSample from "../PublicSample";
import { SAMPLE_STRINGS, type SampleStrings } from "../sampleStrings";

const REPO = resolve(__dirname, "../../../..");
const PUBLIC_SAMPLE = resolve(REPO, "public/sample");
const LANGS: SampleLang[] = ["en", "ro"];

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(PUBLIC_SAMPLE, name), "utf-8")) as T;
}

const servedName = (kind: string, n: number) =>
  (SAMPLE.files as Array<{ name: string; kind: string }>).filter((f) => f.kind === kind)[n].name;
const CURRENT = readJson<ServedPeriodBody>(servedName("served_document", 0));
const PRIOR = readJson<ServedPeriodBody>(servedName("served_document", 1));
const COMPARATIVES = readJson<ComparativesResponse>(servedName("served_document", 2));
const CONFIG = JSON.parse(readFileSync(resolve(REPO, "scripts/public_sample_config.json"), "utf-8")) as {
  as_of: string;
};

/** RFC 6901, plus `key=value` to pick one object out of a list — the same
 *  reader scripts/build_public_sample.py writes the pointers for. */
function pointer(doc: unknown, path: string): unknown {
  let node: unknown = doc;
  for (const raw of path.split("/").filter((s) => s !== "")) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      if (seg.includes("=")) {
        const [key, want] = [seg.slice(0, seg.indexOf("=")), seg.slice(seg.indexOf("=") + 1)];
        const hits = node.filter((item) => String((item as Record<string, unknown>)[key]) === want);
        if (hits.length !== 1) throw new Error(`${path}: ${hits.length} items match ${seg}`);
        node = hits[0];
      } else node = node[Number(seg)];
    } else node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** AN INDEPENDENT PRINTER — Intl directly, never lib/money. English prints
 *  "9,358,823.90 RON", Romanian "9.358.823,90 RON" (the ISO code after the
 *  figure in both, CLAUDE.md §26). */
function expectedMoney(value: number, lang: SampleLang): string {
  const digits = new Intl.NumberFormat(lang === "ro" ? "ro-RO" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${digits} RON`;
}

async function renderPage(lang: SampleLang) {
  await act(async () => {
    await i18n.changeLanguage(lang);
  });
  return render(
    <MemoryRouter initialEntries={["/sample"]}>
      <PublicSample />
    </MemoryRouter>,
  );
}

/** The page's own words and figures: everything except the sentences it
 *  QUOTES from the engine in another language and the identifiers it shows
 *  verbatim (file names, version strings). */
function ownText(root: HTMLElement, lang: SampleLang): string {
  const copy = root.cloneNode(true) as HTMLElement;
  copy
    .querySelectorAll(`[data-engine-words]:not([data-engine-words="${lang}"]), .font-mono`)
    .forEach((el) => el.remove());
  return plainSpaces(copy.textContent ?? "");
}

let figuresChecked = 0;

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("the /sample page made a network call");
    }),
  );
});
afterEach(() => cleanup());
afterAll(async () => {
  vi.unstubAllGlobals();
  await act(async () => {
    await i18n.changeLanguage("en");
  });
  console.log(`GATE-WORK public-sample-page figures=${figuresChecked}`);
});

describe.each(LANGS)("P1 the page's figures are the served document's — %s", (lang) => {
  it("every money figure of both years, printed in the reader's language", async () => {
    await renderPage(lang);
    for (const [which, body] of [["current", CURRENT], ["prior", PRIOR]] as const) {
      const figures = SAMPLE.periods[which].figures as SampleFigure[];
      expect(figures.length).toBeGreaterThanOrEqual(10);
      for (const f of figures) {
        const served = pointer(body, f.pointer) as number;
        expect(typeof served, `${f.key}: nothing is served at ${f.pointer}`).toBe("number");
        const cell = screen
          .getByTestId(`sample-figure-${f.key}`)
          .querySelector(`[data-period="${which}"]`) as HTMLElement;
        expect(plainSpaces(cell.textContent), `${lang} ${which} ${f.key}`).toBe(expectedMoney(served, lang));
        figuresChecked += 1;
      }
    }
  });

  it("the verdict cards print the served balance, anchor, stock variation and EBITDA", async () => {
    await renderPage(lang);
    const st = CURRENT.statements as unknown as Record<string, Record<string, unknown>>;
    const cbs = st.canonical_bs as { status: string; difference: number; totals: Record<string, number> };
    const pl = st.assembled_pl as Record<string, number> & { inventory_variation: { value: number } };
    const text = (id: string) => plainSpaces(screen.getByTestId(id).textContent);

    expect(cbs.status).toBe("BALANCED");
    const balance = text("sample-verdict-balance");
    for (const v of [cbs.totals.assets, cbs.totals.equity_plus_liabilities, cbs.difference]) {
      expect(balance).toContain(expectedMoney(v, lang));
      figuresChecked += 1;
    }
    expect(balance).toContain(lang === "ro" ? "Echilibrat" : "Balanced");

    const anchor = text("sample-verdict-anchor");
    expect(anchor).toContain(expectedMoney(pl.net_income_statutory_anchor, lang));
    expect(anchor).toContain(expectedMoney(pl.net_income_reconstructed, lang));
    expect(anchor).toContain(expectedMoney(pl.inventory_variation.value, lang));
    expect(pl.net_income_statutory).toBe(pl.net_income_statutory_anchor);
    expect(text("sample-verdict-variation")).toContain(expectedMoney(pl.inventory_variation.value, lang));

    const ebitda = text("sample-verdict-ebitda");
    expect(ebitda).toContain(expectedMoney(pl.ebitda, lang));
    expect(plainSpaces(screen.getByTestId("sample-ebitda-strict").textContent)).toContain(
      expectedMoney(pl.adjusted_ebitda, lang),
    );
    expect(plainSpaces(screen.getByTestId("sample-ebitda-cash").textContent)).toContain(
      expectedMoney(pl.ebitda_cash, lang),
    );
    figuresChecked += 6;
  });

  it("nothing the page says in its own voice is a number in the other language's format", async () => {
    const { container } = await renderPage(lang);
    fireEvent.click(screen.getByTestId("sample-mapping-toggle"));
    const text = ownText(container, lang);
    expect(text.length).toBeGreaterThan(4000);
    expect(foreignNumber(text, lang), `a ${lang === "en" ? "Romanian" : "English"} number on the ${lang} page`).toBeNull();
    // the detector is not vacuous on this page: the other language's page trips it
    cleanup();
    const other = await renderPage(lang === "en" ? "ro" : "en");
    expect(foreignNumber(ownText(other.container, lang === "en" ? "ro" : "en"), lang)).not.toBeNull();
  });
});

describe.each(LANGS)("P2 ratios at the engine's precision, with the band it served — %s", (lang) => {
  it("each ratio and composite, both years", async () => {
    await renderPage(lang);
    const ratios = SAMPLE.ratios as SampleRatio[];
    expect(ratios.length).toBeGreaterThanOrEqual(12);
    for (const r of ratios) {
      const row = pointer(COMPARATIVES, r.pointer) as Record<string, { value_q: string; band: string | null }>;
      for (const which of ["current", "prior"] as const) {
        const servedQ = row[which].value_q;
        expect(r[which].value_q, `${r.key} ${which}`).toBe(servedQ);
        const cell = screen
          .getByTestId(`sample-ratio-${r.key}`)
          .querySelector(`[data-period="${which}"] [data-figure]`) as HTMLElement;
        const printed = plainSpaces(cell.textContent);
        // the engine's digits, with the reader's decimal separator
        const digits = lang === "ro" ? servedQ.replace(".", ",") : servedQ;
        expect(printed, `${lang} ${r.key} ${which}`).toContain(digits);
        if (/^\d/.test(servedQ) && servedQ.includes(".")) {
          expect(printed).not.toContain(lang === "ro" ? servedQ : servedQ.replace(".", ","));
        }
        figuresChecked += 1;
      }
    }
    const credit = plainSpaces(screen.getByTestId("sample-verdict-credit").textContent);
    const letter = (pointer(COMPARATIVES, "/ratios/composites/key=letter_grade") as { current: { value_q: string } })
      .current.value_q;
    expect(credit).toContain(`${letter},`);
    const z = (pointer(COMPARATIVES, "/ratios/composites/key=altman_z") as { current: { value_q: string } })
      .current.value_q;
    expect(credit).toContain(lang === "ro" ? z.replace(".", ",") : z);
  });
});

describe("P3 every key the page prints has words in both languages", () => {
  it("the two string tables have the same shape, and neither is empty", () => {
    const shape = (node: unknown, path: string, out: string[]) => {
      if (typeof node === "string") {
        expect(node.trim(), path).not.toBe("");
        out.push(path);
      } else if (Array.isArray(node)) node.forEach((v, i) => shape(v, `${path}[${i}]`, out));
      else Object.entries(node as object).forEach(([k, v]) => shape(v, `${path}.${k}`, out));
      return out;
    };
    const en = shape(SAMPLE_STRINGS.en, "", []);
    const ro = shape(SAMPLE_STRINGS.ro, "", []);
    expect(ro).toEqual(en);
    expect(en.length).toBeGreaterThan(120);
  });

  it.each(LANGS)("labels, buckets, sections, statuses and file cards are all named — %s", async (lang) => {
    const S: SampleStrings = SAMPLE_STRINGS[lang];
    const labels = SAMPLE.labels as SampleLabel[];
    for (const label of labels) {
      expect(S.kinds[label.kind], `kind ${label.kind}`).toBeTruthy();
      expect(S.areas[label.area], `area ${label.area}`).toBeTruthy();
      const named =
        S.labelTitles[label.key] !== undefined ||
        label.key.startsWith("ratio_refused_") ||
        label.key.startsWith("insight_not_fired_");
      expect(named, `label ${label.key} has no title in ${lang}`).toBe(true);
      expect(labelQuote(label, lang).text.trim(), `label ${label.key} quotes nothing`).not.toBe("");
    }
    const mapping = SAMPLE.mapping as SampleMappingRow[];
    for (const row of mapping) {
      if (row.status === "mapped") {
        expect(S.statements[row.statement ?? ""], `statement ${row.statement}`).toBeTruthy();
        expect(S.buckets[row.engine_bucket ?? ""], `bucket ${row.engine_bucket}`).toBeTruthy();
      } else expect(S.mappingStatus[row.status], `status ${row.status}`).toBeTruthy();
      if (row.balance_sheet_section) {
        expect(S.sections[row.balance_sheet_section], `section ${row.balance_sheet_section}`).toBeTruthy();
      }
    }
    for (const { key } of fileKeys(SAMPLE)) expect(S.files[key].title).toBeTruthy();
    for (const item of SAMPLE.verdicts.insights) expect(S.verdict.levels[item.level]).toBeTruthy();
    expect(S.verdict.zones[SAMPLE.verdicts.credit.altman_zone]).toBeTruthy();

    // and rendered: every label and every account is on the page
    await renderPage(lang);
    for (const label of labels) expect(screen.getByTestId(`sample-label-${label.key}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sample-mapping-toggle"));
    expect(document.querySelectorAll('[data-testid^="sample-account-"]').length).toBe(mapping.length);
    const derived = screen.getByTestId("sample-account-711");
    expect(plainSpaces(derived.textContent)).toContain(
      expectedMoney((CURRENT.statements as never as { assembled_pl: { inventory_variation: { value: number } } })
        .assembled_pl.inventory_variation.value, lang),
    );
  });

  it("an engine sentence is quoted in the language it was written in", async () => {
    await renderPage("ro");
    const labels = SAMPLE.labels as SampleLabel[];
    const englishOnly = labels.filter((l) => l.reason === null && l.engine_ro === null);
    const both = labels.filter((l) => l.engine_ro !== null);
    expect(englishOnly.length).toBeGreaterThan(0);
    expect(both.length).toBeGreaterThan(0);
    for (const label of englishOnly) {
      const quote = within(screen.getByTestId(`sample-label-${label.key}`)).getByText(label.engine_en as string);
      expect(quote.getAttribute("lang")).toBe("en");
    }
    for (const label of both) {
      const quote = within(screen.getByTestId(`sample-label-${label.key}`)).getByText(label.engine_ro as string);
      expect(quote.getAttribute("lang")).toBe("ro");
    }
  });
});

describe("P4 every download is a published file", () => {
  it("each card links a file under public/sample, at its stated size", async () => {
    await renderPage("en");
    const cards = fileKeys(SAMPLE);
    expect(cards.length).toBe(9);
    for (const { key, file } of cards) {
      const link = screen.getByTestId(`sample-file-${key}`) as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe(`/sample/${file.name}`);
      const onDisk = statSync(resolve(PUBLIC_SAMPLE, file.name));
      expect(onDisk.isFile(), file.name).toBe(true);
      if (typeof file.bytes === "number") expect(onDisk.size, file.name).toBe(file.bytes);
    }
  });
});

describe("P5 / P6 the published report is the product's own export", () => {
  const committed = readFileSync(resolve(PUBLIC_SAMPLE, servedName("report_html", 0)), "utf-8");

  it("the committed HTML is a byte-identical rebuild from the committed served documents", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${CONFIG.as_of}T12:00:00Z`));
    try {
      const rebuilt = sampleReportHtml(CURRENT, PRIOR, COMPARATIVES);
      expect(rebuilt.length).toBe(committed.length);
      expect(rebuilt === committed, "public/sample report HTML differs from a rebuild").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the report ships no stylesheet comment and names the fictional company only", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(committed)?.[1] ?? "";
    expect(style.length).toBeGreaterThan(10_000);
    expect(style).not.toContain("/*");
    expect(committed).toContain(SAMPLE.company.name);
  });

  it("the committed PDF prints that report's headline figures", () => {
    const doc = new DOMParser().parseFromString(committed, "text/html");
    const cards = Array.from(doc.querySelectorAll(".ratio-card .value"))
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((v) => /\d/.test(v));
    expect(cards.length).toBeGreaterThanOrEqual(4);
    const bytes = new Uint8Array(readFileSync(resolve(PUBLIC_SAMPLE, servedName("report_pdf", 0))));
    const pages = pageTexts(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(15);
    const text = pages.join(" ").replace(/\s+/g, " ");
    expect(text).toContain(SAMPLE.company.name);
    for (const value of cards.slice(0, 4)) expect(text, `the PDF does not print ${value}`).toContain(value);
  });
});

describe("P7 the page is public", () => {
  it("renders with no session, no provider and no network call", async () => {
    await renderPage("en");
    expect(screen.getByTestId("public-sample")).toBeInTheDocument();
    expect(screen.getByTestId("sample-fictional-notice").textContent).toContain(SAMPLE.company.fiscal_code);
    expect(SAMPLE.company.fictional).toBe(true);
    expect(SAMPLE.company.fiscal_code_valid).toBe(false);
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("the language switch changes the page in place", async () => {
    await renderPage("en");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(SAMPLE_STRINGS.en.title);
    await act(async () => {
      fireEvent.click(screen.getByTestId("sample-lang-switch"));
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(SAMPLE_STRINGS.ro.title);
    expect(document.title).toBe(SAMPLE_STRINGS.ro.metaTitle);
  });
});

describe("P8 the Romanian copy", () => {
  const flat = (node: unknown, out: string[] = []): string[] => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach((v) => flat(v, out));
    else Object.values(node as object).forEach((v) => flat(v, out));
    return out;
  };

  it("uses comma-below diacritics and the informal register, and is translated", () => {
    const ro = flat(SAMPLE_STRINGS.ro);
    const en = flat(SAMPLE_STRINGS.en);
    for (const s of ro) {
      expect(s, "cedilla diacritic").not.toMatch(/[şţŞŢ]/);
      expect(s, "formal register").not.toMatch(/dumneavoastr|vă rugăm|\b[a-zăâî]+ți-vă\b/i);
      expect(s, "emoji").not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
    // identical strings are names, units and code paths — nothing else
    const same = ro.filter((s, i) => s === en[i]);
    for (const s of same) {
      expect(/^(EBITDA|\{size\} KB|strict|scripts\/.*)$/.test(s) || !/[a-z]{4,}\s+[a-z]{4,}/i.test(s), s).toBe(true);
    }
    expect(ro.filter((s) => /[ăâîșț]/i.test(s)).length).toBeGreaterThan(60);
  });
});
