// public-claims — NO COVERAGE CLAIM STRONGER THAN THE TESTS.
//
// Owner, 2026-10-01, after the first public review: the headline module
// card read "from any European country"; the strip under the hero read
// "Any other country accepted" over seven market names; the page title
// sold "analysis for European SMEs"; the FAQ named SAGA, "European
// accounting software", CSV and annual reports as supported; the dashboard
// listed five accounting systems by name; a plan called Multi-Country was
// on sale with "Any accounting jurisdiction". What the tests in this
// repository cover is Romanian trial balances, in one spreadsheet layout
// and one PDF export proven on real books.
//
// THE LAW
//   frontend/data/coverage.json is the ONLY source of coverage wording.
//   This gate renders every public surface in English and Romanian — the
//   landing (hero, modules, how-it-works + coverage table, proof, pricing
//   cards, FAQ, footer), the signed-in pricing table, the page <title> and
//   its description / Open Graph / Twitter tags, the web manifest, the
//   runtime meta the language hook writes, the share image's text record
//   and alt, the in-app upload copy, the plan bullets, the non-Romanian
//   refusal dialog — and holds:
//
//   C1  no country or region is claimed as covered other than Romania;
//   C2  no accounting-software name that is not in a TESTED row backed by a
//       real file;
//   C3  no input format that is not in a tested row, unless the sentence
//       says it is AI-read or not supported;
//   C4  every tested row carries evidence — a battery gate that exists, or
//       a dated production measurement — and a book count the proof agrees
//       with; the AI row is marked unavailable; rows are dated;
//   C5  the coverage table renders every row, on the landing and in-app;
//   C6  Multi-Country is coming soon everywhere: marked, no checkout;
//   C7  the non-Romanian refusal says "not supported yet", never "upgrade";
//   C8  the section count a plan sells is the count the report renders;
//   C9  the share image says what the hero says;
//   C10 the page title, description and manifest claim Romania only.
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11)
//   "from any European country", "Any other country accepted", "European
//   SMEs", "EU filings", "worldwide", "Cross-border", "Any accounting
//   jurisdiction", a market name in a list, "SAGA" / "SmartBill" / "NEXTUP" /
//   "CIEL" anywhere in copy, "scanned PDF" without the AI marker, a tested
//   row with no evidence or naming a gate that does not exist, a
//   /signup?plan=multi link, "needs Multi-Country", "9-section", an image
//   record that differs from the hero.
//
// WHAT IT CANNOT SEE (TC-11)
//   · whether a tested row's evidence gate actually exercises that layout —
//     it checks the gate EXISTS in the battery and, where the row is tied to
//     the proof, that the count agrees;
//   · the pixels of the share image (it compares the generator's text
//     record with the hero; regenerate with scripts/build_og_image.mjs);
//   · e-mails and the server-rendered storefront templates;
//   · coverage implied without a region word, a software name or a format.
//
// Plant log: docs/engine_book/gates.md, "public-claims".

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import coverage from "@/data/coverage.json";
import proof from "@/data/engineProof.json";
import "@/components/cfo/bsCanonicalStatusI18n";
import { CoverageTable } from "@/components/cfo/CoverageTable";
import { JurisdictionSelect } from "@/components/cfo/JurisdictionSelect";
import { NonRoUpgradeDialog } from "@/components/cfo/pricing/NonRoUpgradeDialog";
import { PricingTableV2 } from "@/components/cfo/PricingTableV2";
import { META_DESCRIPTION } from "@/hooks/useHtmlLangSync";
import { coverageView } from "@/lib/coverage";
import { bulletText, planFeatureBulletsFor, planKeysWithFeatures } from "@/lib/planFeatures";
import {
  __clearPricingConfigForTest,
  __setPricingConfigForTest,
  type PlanConfig,
  type PricingPublicConfig,
} from "@/lib/pricingConfig";
import { friendlyDocumentError, parseUploadRefusal } from "@/lib/uploadRefusals";
import { landingStringsFor } from "@/pages/cfo/landingStrings";
import { renderLanding, setLanguage, textOf, type SurfaceLang } from "@/test/publicSurfaces";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    isAuthenticated: false, displayName: null, initials: null, user: null,
    status: "signed_out", signOut: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const REPO = resolve(__dirname, "../../..");
const LANGS: SurfaceLang[] = ["en", "ro"];

interface Row {
  id: string; category: string; label_en: string; label_ro: string;
  formats: string[]; software: string[]; evidence: string;
  real_books: number | string; real_books_proof?: string;
  availability?: string; availability_en?: string; availability_ro?: string;
  note_en: string; note_ro: string; as_of: string;
}
const ROWS = (coverage as unknown as { rows: Row[] }).rows;
const TESTED = ROWS.filter((r) => r.category === "tested");

// ── the pricing config the signed-in table renders from ───────────────
function plan(p: Partial<PlanConfig> & { key: PlanConfig["key"] }): PlanConfig {
  return {
    display_name: p.key, blurb: "", price_eur: 0, recurring: false, requires_card: false,
    included_docs: 1, extra_doc_eur: null, chat_daily_cap: null, chat_monthly_cap: null,
    window_days: null, ...p,
  } as PlanConfig;
}
// The blurbs are the backend's, verbatim (_pricing_config.py) — including
// the Multi-Country one the card must NOT show.
const CONFIG: PricingPublicConfig = {
  plans: [
    plan({ key: "trial" }),
    plan({ key: "intro", price_eur: 0.99, window_days: 7 }),
    plan({ key: "solo", display_name: "RO Solo", price_eur: 4.99, recurring: true, purchasable: true,
      included_docs: 3, extra_doc_eur: 1.49, max_workspaces: 1, allows_non_ro: false,
      blurb: "Three Romanian analyses per month, extras at €1.49/doc." }),
    plan({ key: "pro", display_name: "Pro", price_eur: 9.99, recurring: true, purchasable: true,
      included_docs: 15, extra_doc_eur: 0.99, max_workspaces: 5, allows_non_ro: false,
      blurb: "Fifteen Romanian analyses per month, extras at €0.99/doc." }),
    plan({ key: "multi", display_name: "Multi-Country", price_eur: 16.99, recurring: true, purchasable: true,
      included_docs: 15, extra_doc_eur: 0.99, max_workspaces: 5, allows_non_ro: true,
      included_nonro_docs: 8, extra_nonro_doc_eur: 1.49,
      blurb: "Fifteen analyses per month plus eight non-Romanian documents included; overages metered." }),
  ],
};

// ── harvest ───────────────────────────────────────────────────────────

interface Line { where: string; text: string }

function flat(obj: unknown, path: string, where: string, out: Line[]): void {
  if (typeof obj === "string") out.push({ where: `${where} ${path}`, text: obj });
  else if (Array.isArray(obj)) obj.forEach((v, i) => flat(v, `${path}[${i}]`, where, out));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) flat(v, path ? `${path}.${k}` : k, where, out);
  }
}

/** The dictionary namespaces an upload, pricing or coverage surface reads. */
const UPLOAD_NAMESPACES = ["dash", "dashboard", "upload", "expectedFormat", "tmpl", "pricing", "coverage"];

function indexHtmlLines(): Line[] {
  const src = readFileSync(join(REPO, "index.html"), "utf8");
  const out: Line[] = [];
  const title = /<title>([^<]*)<\/title>/i.exec(src);
  if (title) out.push({ where: "index.html <title>", text: title[1].trim() });
  for (const m of src.matchAll(/<meta\s+([^>]*?)\/?>/gi)) {
    const name = /(?:name|property)\s*=\s*"([^"]+)"/i.exec(m[1]);
    const content = /content\s*=\s*"([^"]*)"/i.exec(m[1]);
    if (!name || !content) continue;
    if (!/^(description|og:(title|description|image:alt)|twitter:(title|description|image:alt))$/i.test(name[1])) continue;
    out.push({ where: `index.html meta[${name[1]}]`, text: content[1].trim() });
  }
  return out;
}

const OG_RECORD = join(REPO, "public/og/homepage.json");

/** Everything a visitor or a signed-in user can read about coverage, per
 *  language. The rendered surfaces are harvested as TEXT off the DOM. */
async function harvest(lang: SurfaceLang): Promise<Line[]> {
  const out: Line[] = [];
  // 1. the public landing, as rendered
  const landing = await renderLanding(lang);
  for (const el of landing.querySelectorAll("h1,h2,h3,p,li,a,button,span,div,time")) {
    // leaf-ish text only: an element whose own child nodes carry text
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (own.length > 2) out.push({ where: `landing[${lang}] <${el.tagName.toLowerCase()}>`, text: own });
  }
  cleanup();
  // 2. the signed-in pricing table, as rendered
  __setPricingConfigForTest(CONFIG);
  const table = render(<MemoryRouter><PricingTableV2 /></MemoryRouter>);
  for (const el of table.container.querySelectorAll("h3,p,li,span,button,a")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (own.length > 2) out.push({ where: `pricing-table[${lang}] <${el.tagName.toLowerCase()}>`, text: own });
  }
  cleanup();
  // 3. the in-app coverage table and the refusal dialog, as rendered
  const cov = render(<MemoryRouter><CoverageTable showHeading /></MemoryRouter>);
  out.push({ where: `coverage-table[${lang}]`, text: textOf(cov.container) });
  cleanup();
  render(<MemoryRouter><NonRoUpgradeDialog open onClose={() => {}} serverMessage="Non-RO documents are included on the Multi-Country plan." /></MemoryRouter>);
  out.push({ where: `non-ro-dialog[${lang}]`, text: textOf(screen.getByTestId("non-ro-upgrade-dialog")) });
  cleanup();
  // 4. upload / pricing copy in the dictionaries
  const dict = (lang === "ro" ? ro : en) as Record<string, unknown>;
  for (const ns of UPLOAD_NAMESPACES) flat(dict[ns], ns, `${lang}.json`, out);
  // (the country dropdown's rows are checked STRUCTURALLY — C1b — because a
  // row's meaning depends on the group it sits in)
  // 5. plan bullets
  for (const key of planKeysWithFeatures()) {
    for (const b of planFeatureBulletsFor(key)) {
      out.push({ where: `planFeatures.${key}[${lang}]`, text: bulletText(b, lang) });
    }
  }
  // 6. meta the hook writes, the refusal default, the coverage data itself
  out.push({ where: `META_DESCRIPTION.${lang}`, text: META_DESCRIPTION[lang] });
  if (lang === "en") {
    out.push(...indexHtmlLines());
    const manifest = JSON.parse(readFileSync(join(REPO, "public/manifest.webmanifest"), "utf8"));
    out.push({ where: "manifest.name", text: String(manifest.name) });
    out.push({ where: "manifest.description", text: String(manifest.description) });
    flat(JSON.parse(readFileSync(OG_RECORD, "utf8")).text, "text", "og/homepage.json", out);
    out.push({
      where: "uploadRefusals default",
      text: parseUploadRefusal({ error: "non_ro_not_included" })?.message ?? "",
    });
  }
  return out;
}

/** Sentences, and the items of a "·"-separated line. An em dash does NOT
 *  split: "Coming soon — international coverage is not available yet" is
 *  one statement, and its negation belongs to its claim. */
const sentencesOf = (text: string): string[] =>
  text.split(/(?<=[.!?;])\s+|\s·\s/).map((s) => s.trim()).filter(Boolean);

// ── vocabulary ────────────────────────────────────────────────────────

/** A country or region other than Romania, or a word that claims reach
 *  beyond it. Two patterns: words (any case) and ABBREVIATIONS, which are
 *  matched case-sensitively — "US" is a country, "Contact us" is not; "EUR"
 *  is a currency and does not match `\bEU\b`. */
const BEYOND_WORDS = new RegExp(
  [
    "\\beurop\\w*", "worldwide", "\\bglobal\\w*", "internation\\w*",
    "internațional\\w*", "cross-?border", "transfrontalier\\w*", "multi-?countr\\w*",
    "any (?:other )?countr\\w+", "orice (?:altă )?țară", "întreaga lume",
    "any (?:accounting )?jurisdiction\\w*", "orice jurisdicți\\w+",
    "other (?:countr\\w+|jurisdiction\\w*)", "alte (?:țări|jurisdicții)", "altă țară",
    "non-?ro\\b", "non-?romanian", "non-?românești",
    "united states", "statele unite", "german\\w*", "united kingdom",
    "regatul unit", "franc(?:e|eză)\\b", "franța", "ital(?:y|ia|ian)\\b", "spain", "spania",
    "emirate\\w*", "hungar\\w*", "ungari\\w*", "maghiar\\w*", "poland", "polonia",
    "bulgari\\w*", "moldov\\w*",
  ].join("|"),
  "i",
);
const BEYOND_ABBREVIATIONS = /\b(?:EU|UE|USA|US|UK|UAE|EAU|SUA|IFRS)\b/;
const BEYOND_ROMANIA = {
  exec(sentence: string): RegExpExecArray | null {
    return BEYOND_WORDS.exec(sentence) ?? BEYOND_ABBREVIATIONS.exec(sentence);
  },
};

/** The sentence says the thing is NOT available — the not-supported row
 *  and the coming-soon card. */
const NEGATED = new RegExp(
  [
    "not (?:yet )?(?:supported|available|analysed|on sale|tested)", "\\b(?:is|are) not\\b",
    "not supported yet", "coming soon", "other than romania", "no real book",
    "\\bnu (?:este|sunt|e)\\b", "\\bîncă\\b", "nesuportat\\w*", "indisponibil\\w*", "în curând",
    "decât românia", "nicio balanță", "planned",
    "planificat",
  ].join("|"),
  "i",
);

/** A region word that is not about coverage: where data is stored, where
 *  the model provider is, the GDPR badge. */
const NOT_COVERAGE = new RegExp(
  [
    "infrastructure", "infrastructură", "GDPR", "model provider", "furnizorului nostru de model",
    "made in the eu", "creat în ue",
  ].join("|"),
  "i",
);

/** Named exemptions — each one a string a reader meets that is NOT a claim
 *  that the product reads another country's files, with the reason. A new
 *  entry here is a decision, not a convenience. */
const EXEMPT: Array<{ where: RegExp; text: RegExp; why: string }> = [
  {
    where: /\.json pricing\.usageNonRo$/, text: /^(Non-RO documents|Documente non-RO)$/,
    why: "the usage-meter label on the current-plan card of an EXISTING Multi-Country subscriber — a counter of their allowance, not an offer; untouched by decision (existing subscribers unchanged)",
  },
];

const SOFTWARE = [
  "SAGA", "WinMENTOR", "WinMentor", "Mentor", "SmartBill", "Smart Bill", "NEXTUP", "NextUp", "CIEL",
  "SAP", "Crystal Reports", "Crystal", "SceptrumERP", "Sceptrum", "ContSal", "Oblio", "FGO",
  "Charisma", "Navision", "Dynamics", "QuickBooks", "Xero", "Sage", "DATEV", "Odoo", "Senior",
  "Nexus", "WizCount", "Facturis",
];
const softwareIn = (text: string): string[] =>
  SOFTWARE.filter((name) => new RegExp(`(?<![\\w-])${name.replace(/ /g, "\\s?")}(?![\\w-])`, "i").test(text))
    // "Mentor" inside "WinMENTOR" is one name, not two
    .filter((name, _i, all) => !(name === "Mentor" && all.some((o) => /winmentor/i.test(o))))
    .filter((name) => !(name === "Crystal" && /crystal reports/i.test(text) === false && !/\bcrystal\b/i.test(text)));

/** Input formats NO tested row covers. ("scan" alone is the product's
 *  word for running an analysis — "Start scan" — so only the adjective
 *  counts.) */
const UNTESTED_FORMAT =
  /\bscanned\b|\bscanat\w*|\bphotos?\b|\bfotografi\w*|\bimages?\b|\bimagine\b|\bimagini\b|\.xls\b|\bxls\b|\bdocx\b|\bpptx?\b|\bjpe?g\b|\bpng\b|\bheic\b|\bOCR\b/i;
const AI_OR_NEGATED = new RegExp(
  `\\bAI\\b|${NEGATED.source}|real-file test|test pe fișier real|\\bnu scanat\\w*|not a scan`, "i");

let unitsChecked = 0;

afterEach(() => { cleanup(); __clearPricingConfigForTest(); });
afterAll(async () => {
  await setLanguage("en");
  console.log(`GATE-WORK public-claims units=${unitsChecked}`);
});
beforeEach(() => navigateSpy.mockReset());

// ── C1–C3 — every surface, both languages ─────────────────────────────

describe.each(LANGS)("public-claims · every surface (%s)", (lang) => {
  it("C1 claims no country or region as covered but Romania", async () => {
    const lines = await harvest(lang);
    // Floors — a harvest that stops reading a surface must not pass.
    expect(lines.length, "harvest collapsed").toBeGreaterThan(400);
    for (const prefix of ["landing[", "pricing-table[", "coverage-table[", "non-ro-dialog[", `${lang}.json pricing`, "planFeatures.multi", "META_DESCRIPTION"]) {
      expect(lines.some((l) => l.where.startsWith(prefix)), `nothing harvested from ${prefix}`).toBe(true);
    }
    if (lang === "en") {
      for (const w of ["index.html <title>", "index.html meta[description]", "index.html meta[og:image:alt]", "manifest.description", "og/homepage.json text.headline"]) {
        expect(lines.some((l) => l.where === w), `nothing harvested from ${w}`).toBe(true);
      }
    }
    const offenders: string[] = [];
    for (const line of lines) {
      for (const sentence of sentencesOf(line.text)) {
        const hit = BEYOND_ROMANIA.exec(sentence);
        if (!hit) continue;
        unitsChecked += 1;
        if (NEGATED.test(sentence) || NOT_COVERAGE.test(sentence)) continue;
        // The plan's own name, alone, on its coming-soon card.
        if (/^multi-country$/i.test(sentence.trim())) continue;
        if (EXEMPT.some((e) => e.where.test(line.where) && e.text.test(line.text))) continue;
        offenders.push(`${line.where}: "${hit[0]}" in "${sentence.slice(0, 180)}"`);
      }
    }
    expect(offenders, "a coverage claim beyond Romania that is not negated").toEqual([]);
    unitsChecked += lines.length;
  });

  it("C2 names no accounting software that is not a tested row's, backed by a real file", async () => {
    const lines = await harvest(lang);
    const allowed = new Set(TESTED.flatMap((r) => r.software.map((s) => s.toLowerCase())));
    const offenders: string[] = [];
    for (const line of lines) {
      for (const name of softwareIn(line.text)) {
        unitsChecked += 1;
        if (!allowed.has(name.toLowerCase())) {
          offenders.push(`${line.where}: names "${name}" — not in coverage.json tested rows [${[...allowed].join(", ")}]: "${line.text.slice(0, 160)}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // the detector is alive: the one proven name IS found on the page
    expect(lines.some((l) => softwareIn(l.text).some((n) => /winmentor/i.test(n))), "WinMENTOR was not found anywhere — the software detector is dead").toBe(true);
  });

  it("C3 offers no input format outside the tested rows unless it says AI-read or not supported", async () => {
    const lines = await harvest(lang);
    const offenders: string[] = [];
    let seen = 0;
    for (const line of lines) {
      for (const sentence of sentencesOf(line.text)) {
        const hit = UNTESTED_FORMAT.exec(sentence);
        if (!hit) continue;
        seen += 1;
        if (AI_OR_NEGATED.test(sentence)) continue;
        offenders.push(`${line.where}: "${hit[0]}" in "${sentence.slice(0, 180)}"`);
      }
    }
    expect(seen, "no untested-format word found anywhere — the detector is dead").toBeGreaterThan(0);
    expect(offenders).toEqual([]);
    unitsChecked += seen;
  });
});

describe.each(LANGS)("public-claims · the upload dialog's country dropdown (%s)", (lang) => {
  it("C1b every row but Romania sits in a group that says not supported, and cannot be chosen", async () => {
    await setLanguage(lang);
    render(<JurisdictionSelect data-testid="jx" />);
    const select = screen.getByTestId("jx") as HTMLSelectElement;
    const options = Array.from(select.options);
    expect(options.length).toBeGreaterThanOrEqual(4);
    for (const o of options) {
      unitsChecked += 1;
      if (o.value === "auto" || o.value === "RO") {
        expect(o.parentElement?.tagName, `${o.value} must be top-level`).toBe("SELECT");
        expect(o.disabled).toBe(false);
        continue;
      }
      const group = o.parentElement as HTMLOptGroupElement;
      expect(group.tagName, `${o.value} is offered outside the not-supported group`).toBe("OPTGROUP");
      expect(NEGATED.test(group.label), `${o.value}: its group "${group.label}" does not say it is unsupported`).toBe(true);
      expect(o.disabled, `${o.value} ("${o.textContent}") can be chosen`).toBe(true);
    }
  });
});

// ── literals the dictionaries do not hold ─────────────────────────────

describe("public-claims · component literals", () => {
  it("C2 no accounting-software name is typed into an upload or marketing component", () => {
    const files = [
      "frontend/pages/cfo/FinancialStatements.tsx",
      "frontend/pages/cfo/Landing.tsx",
      "frontend/pages/cfo/landingStrings.ts",
      "frontend/pages/cfo/Workspace.tsx",
      "frontend/components/cfo/products/TemplateDownloadCard.tsx",
      "frontend/components/cfo/PricingTableV2.tsx",
      "frontend/components/cfo/CoverageTable.tsx",
      "frontend/components/cfo/pricing/NonRoUpgradeDialog.tsx",
      "frontend/lib/planFeatures.ts",
      "frontend/lib/uploadRefusals.ts",
      "frontend/hooks/useHtmlLangSync.ts",
    ];
    const allowed = new Set(TESTED.flatMap((r) => r.software.map((s) => s.toLowerCase())));
    const offenders: string[] = [];
    for (const rel of files) {
      expect(existsSync(join(REPO, rel)), `${rel} is gone — update this list`).toBe(true);
      const src = readFileSync(join(REPO, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");
      for (const m of src.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`|>[^<>{}]+</g)) {
        for (const name of softwareIn(m[0])) {
          if (!allowed.has(name.toLowerCase())) offenders.push(`${rel}: "${name}" in ${m[0].slice(0, 120)}`);
        }
      }
      unitsChecked += 1;
    }
    expect(offenders).toEqual([]);
  });
});

// ── C4 — the data file ────────────────────────────────────────────────

describe("public-claims · coverage.json", () => {
  it("C4 every tested row has evidence a reader can check, a dated count the proof agrees with", () => {
    const battery = readFileSync(join(REPO, "scripts/run_battery.py"), "utf8");
    const formats = (proof as unknown as { formats: Record<string, number> }).formats;
    expect(TESTED.length).toBeGreaterThanOrEqual(3);
    for (const r of ROWS) {
      expect(["tested", "ai_interpreted", "not_supported"], r.id).toContain(r.category);
      expect(r.as_of, `${r.id}: as_of`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.label_en.length, `${r.id}: label_en`).toBeGreaterThan(10);
      expect(r.label_ro.length, `${r.id}: label_ro`).toBeGreaterThan(10);
      expect(r.note_en.length, `${r.id}: note_en`).toBeGreaterThan(10);
      expect(r.note_ro.length, `${r.id}: note_ro`).toBeGreaterThan(10);
      unitsChecked += 1;
    }
    for (const r of TESTED) {
      expect(r.evidence.trim().length, `${r.id}: a tested row with no evidence`).toBeGreaterThan(0);
      const production = /^production reprocess \d{4}-\d{2}-\d{2}$/.test(r.evidence);
      if (!production) {
        const gates = r.evidence.split(",").map((g) => g.trim());
        for (const g of gates) {
          expect(battery.includes(`Gate("${g}"`), `${r.id}: evidence names "${g}", which is not a battery gate`).toBe(true);
        }
      }
      if (typeof r.real_books === "number") {
        expect(r.real_books, `${r.id}: a tested row counting no real book`).toBeGreaterThan(0);
        if (r.real_books_proof) {
          expect(formats[r.real_books_proof], `${r.id}: real_books is not engineProof.json formats.${r.real_books_proof}`).toBe(r.real_books);
        } else {
          expect(production, `${r.id}: a typed real-book count needs either real_books_proof or a dated production measurement`).toBe(true);
        }
      } else {
        expect(r.real_books).toBe("constructed test files only");
      }
      // A software name is a claim about a real export: it needs a real
      // file inside a gate.
      if (r.software.length > 0) {
        expect(typeof r.real_books === "number" && !!r.real_books_proof, `${r.id}: names ${r.software.join(", ")} without a gate-backed real file`).toBe(true);
      }
    }
    // every layout the proof read is a row here — nothing tested is unlisted
    const tied = new Set(TESTED.map((r) => r.real_books_proof).filter(Boolean));
    expect(Object.keys(formats).sort()).toEqual([...tied].sort());
    // the AI path is dated and says whether it works
    const ai = ROWS.filter((r) => r.category === "ai_interpreted");
    expect(ai.length).toBe(1);
    expect(["available", "unavailable"]).toContain(ai[0].availability);
    if (ai[0].availability === "unavailable") {
      expect(ai[0].availability_en).toBeTruthy();
      expect(ai[0].availability_ro).toBeTruthy();
    }
    // exactly one row says other countries are not supported, and it names none
    const ns = ROWS.filter((r) => r.category === "not_supported");
    expect(ns.length).toBe(1);
    expect(ns[0].real_books).toBe(0);
  });
});

// ── C5 — the table renders, on the landing and in-app ─────────────────

describe.each(LANGS)("public-claims · the coverage table (%s)", (lang) => {
  it("C5 renders every row beside the upload step, with what it was tested on and when", async () => {
    const root = await renderLanding(lang);
    const how = root.querySelector("#how");
    const table = how?.querySelector("#coverage");
    expect(table, "the coverage table is not inside the how-it-works section").not.toBeNull();
    const ids = [...(table as Element).querySelectorAll("[data-coverage-row]")].map((e) => e.getAttribute("data-coverage-row"));
    expect(ids.sort()).toEqual(ROWS.map((r) => r.id).sort());
    expect([...(table as Element).querySelectorAll("[data-coverage-category]")].map((e) => e.getAttribute("data-coverage-category")))
      .toEqual(["tested", "ai_interpreted", "not_supported"]);
    const view = coverageView(lang);
    for (const g of view.groups) for (const r of g.rows) {
      const el = (table as Element).querySelector(`[data-coverage-row="${r.id}"]`) as Element;
      expect(textOf(el)).toContain(textOf({ textContent: r.label } as Element));
      expect(textOf(el.querySelector("[data-coverage-tested-on]"))).toBe(r.testedOn);
      expect(textOf(el.querySelector("[data-coverage-evidence]"))).toBe(r.evidence);
      expect(el.querySelector("time")?.getAttribute("datetime")).toBe(r.asOfIso);
      unitsChecked += 1;
    }
    // the count on the xlsx row is the proof's number
    const xlsx = (table as Element).querySelector('[data-coverage-row="xlsx_10_column"] [data-coverage-tested-on]');
    expect(textOf(xlsx)).toContain(String((proof as unknown as { formats: Record<string, number> }).formats.xlsx_10_column_layout));
    // the AI row says it is unavailable
    const ai = (table as Element).querySelector('[data-coverage-row="ai_read"] [data-coverage-availability]');
    expect(textOf(ai).toLowerCase()).toBe((lang === "ro" ? "Indisponibil momentan" : "Currently unavailable").toLowerCase());
    // a link to the public sample sits beside the upload step
    expect((table as Element).querySelector('a[href="/sample"][data-sample-link="upload"]')).not.toBeNull();
  });

  it("C5 renders the same rows in the in-app table", async () => {
    await setLanguage(lang);
    render(<MemoryRouter><CoverageTable /></MemoryRouter>);
    const table = screen.getByTestId("coverage-table");
    const ids = [...table.querySelectorAll("[data-coverage-row]")].map((e) => e.getAttribute("data-coverage-row"));
    expect(ids.sort()).toEqual(ROWS.map((r) => r.id).sort());
    for (const r of ROWS) {
      expect(textOf(table)).toContain(textOf({ textContent: lang === "ro" ? r.label_ro : r.label_en } as Element));
    }
    expect(table.querySelector('a[href="/sample"]')).not.toBeNull();
  });
});

describe("public-claims · the upload zone", () => {
  it("C5 the in-app upload zone opens the coverage table and lists no software", () => {
    const src = readFileSync(join(REPO, "frontend/pages/cfo/FinancialStatements.tsx"), "utf8");
    expect(src).toContain("<CoverageDisclosure />");
    expect(src).toContain('from "@/components/cfo/CoverageTable"');
  });
});

// ── C6 — Multi-Country is coming soon ─────────────────────────────────

describe.each(LANGS)("public-claims · Multi-Country (%s)", (lang) => {
  it("C6 the landing card is marked coming soon and starts no checkout", async () => {
    const root = await renderLanding(lang);
    const card = root.querySelector('[data-plan="multi"]');
    expect(card, "the Multi-Country card is gone — it must stay visible").not.toBeNull();
    expect(card?.getAttribute("data-plan-state")).toBe("coming-soon");
    const L = landingStringsFor(lang);
    expect(textOf(card?.querySelector("[data-plan-badge]"))).toBe(L.pricing.pro.badge);
    expect(textOf(card)).toMatch(lang === "ro" ? /nu este încă disponibilă/ : /is not available yet/);
    expect(card?.querySelector("a"), "the coming-soon card carries a link").toBeNull();
    expect(card?.querySelector('[data-plan-cta="disabled"]')?.getAttribute("aria-disabled")).toBe("true");
    expect(root.querySelector('a[href*="plan=multi"]'), "a checkout link for Multi-Country").toBeNull();
    // the plans on sale keep their links
    expect(root.querySelector('a[href="/signup?plan=solo"]')).not.toBeNull();
    expect(root.querySelector('a[href="/signup?plan=pro"]')).not.toBeNull();
    // planned lines are not ticked as included
    expect(card?.querySelectorAll('li[data-pending="true"]').length).toBeGreaterThanOrEqual(2);
    unitsChecked += 6;
  });

  it("C6 the signed-in pricing table marks it coming soon; its button cannot start a checkout", async () => {
    await setLanguage(lang);
    __setPricingConfigForTest(CONFIG);
    render(<MemoryRouter><PricingTableV2 /></MemoryRouter>);
    const card = screen.getByTestId("pricing-plan-multi");
    expect(card.getAttribute("data-plan-state")).toBe("coming-soon");
    expect(screen.queryByTestId("pricing-plan-multi-cta")).toBeNull();
    const button = screen.getByTestId("pricing-plan-multi-coming-soon") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(navigateSpy).not.toHaveBeenCalled();
    // the backend's blurb ("eight non-Romanian documents included") is not shown
    expect(textOf(card)).not.toMatch(/non-Romanian documents included/i);
    expect(textOf(card)).toMatch(lang === "ro" ? /nu este încă disponibilă/ : /is not available yet/);
    // a plan that IS on sale still navigates
    fireEvent.click(screen.getByTestId("pricing-plan-solo-cta"));
    expect(navigateSpy).toHaveBeenCalledWith("/signup?plan=solo&intent=checkout");
    unitsChecked += 5;
  });
});

// ── C7 — the refusal does not upsell ──────────────────────────────────

describe.each(LANGS)("public-claims · the non-Romanian refusal (%s)", (lang) => {
  it("C7 says other countries are not supported yet, offers the coverage table, sells nothing", async () => {
    await setLanguage(lang);
    render(
      <MemoryRouter>
        <NonRoUpgradeDialog open onClose={() => {}} serverMessage="Non-RO documents are included on the Multi-Country plan." />
      </MemoryRouter>,
    );
    const dialog = screen.getByTestId("non-ro-upgrade-dialog");
    const text = textOf(dialog);
    expect(text).toMatch(lang === "ro" ? /nu sunt încă suportate/ : /not supported yet/);
    expect(text).not.toMatch(/Multi-Country/i);
    expect(text).not.toMatch(/upgrade|included on|inclus[ăe] în planul/i);
    expect(screen.queryByTestId("non-ro-upgrade-cta")).toBeNull();
    expect(screen.queryByTestId("non-ro-server-message")).toBeNull();
    fireEvent.click(screen.getByTestId("non-ro-see-coverage"));
    expect(screen.getByTestId("coverage-table")).toBeTruthy();
    expect(navigateSpy).not.toHaveBeenCalledWith("/pricing");
    // the persisted refusal reads the same way on every failure surface
    const friendly = friendlyDocumentError(JSON.stringify({ error: "non_ro_not_included", upgrade_to: "multi", message: "x" }));
    expect(friendly).toBe(i18n.t("pricing.nonRoBlockedDesc"));
    expect(friendly).not.toMatch(/Multi-Country/i);
    unitsChecked += 4;
  });
});

// ── C8, C9, C10 ───────────────────────────────────────────────────────

describe("public-claims · figures and identity", () => {
  it("C8 the section count a plan sells is the count the report renders", () => {
    const report = readFileSync(join(REPO, "frontend/pages/cfo/ComprehensiveReport.tsx"), "utf8");
    const sections = new Set([...report.matchAll(/data-testid="report-section-(\d+)-/g)].map((m) => Number(m[1])));
    expect(sections.size, "no report sections found").toBeGreaterThanOrEqual(6);
    expect([...sections].sort((a, b) => a - b)).toEqual([...Array(sections.size)].map((_, i) => i + 1));
    let quoted = 0;
    for (const lang of LANGS) {
      const lines: Line[] = [];
      flat(landingStringsFor(lang), "", `landingStrings[${lang}]`, lines);
      for (const key of planKeysWithFeatures()) {
        for (const b of planFeatureBulletsFor(key)) lines.push({ where: `planFeatures.${key}`, text: bulletText(b, lang) });
      }
      for (const line of lines) {
        for (const m of line.text.matchAll(/(\d+)[- ](?:section|secțiuni)\b|\b(?:în|in)\s+(\d+)\s+secțiuni/gi)) {
          quoted += 1;
          expect(Number(m[1] ?? m[2]), `${line.where}: "${m[0]}" — the report renders ${sections.size} sections`).toBe(sections.size);
        }
      }
    }
    expect(quoted, "no surface quotes a section count").toBeGreaterThanOrEqual(2);
    unitsChecked += quoted;
  });

  it("C9 the share image's text is the hero's; its alt says what the image says", () => {
    const record = JSON.parse(readFileSync(OG_RECORD, "utf8")) as { text: Record<string, string> };
    const L = landingStringsFor("en");
    expect(record.text.headline, "the image is stale — node scripts/build_og_image.mjs").toBe(L.hero.t1 + L.hero.thl + L.hero.t2);
    expect(record.text.body).toBe(L.hero.body);
    expect(record.text.eyebrow).toBe(L.hero.eyebrow);
    expect(existsSync(join(REPO, "public/og/homepage.png"))).toBe(true);
    const alts = indexHtmlLines().filter((l) => /image:alt/.test(l.where));
    expect(alts.length).toBe(2);
    const headline = record.text.headline.replace(/\.$/, "").toLowerCase();
    for (const alt of alts) {
      expect(alt.text.toLowerCase(), `${alt.where} does not describe the image`).toContain(
        headline.replace(/^turn a /, "turn a "),
      );
    }
    // The stale design brief that sat in public/ ("Auto-detects 15 European
    // chart-of-accounts standards") is gone from the served directory.
    expect(existsSync(join(REPO, "public/og/README.md"))).toBe(false);
    unitsChecked += 5;
  });

  it("C10 the page title, description and manifest claim Romanian trial balances", () => {
    const lines = indexHtmlLines();
    const title = lines.find((l) => l.where === "index.html <title>")?.text ?? "";
    expect(title).toMatch(/Romanian trial balance/);
    for (const key of ["og:title", "twitter:title"]) {
      expect(lines.find((l) => l.where === `index.html meta[${key}]`)?.text).toBe(title);
    }
    // index.html ships the English description the hook would write
    expect(lines.find((l) => l.where === "index.html meta[description]")?.text).toBe(META_DESCRIPTION.en);
    expect(META_DESCRIPTION.en).toMatch(/Romanian trial balance/);
    expect(META_DESCRIPTION.ro).toMatch(/balanță de verificare românească/);
    const manifest = JSON.parse(readFileSync(join(REPO, "public/manifest.webmanifest"), "utf8"));
    expect(String(manifest.description)).toMatch(/Romanian trial balance/);
    unitsChecked += 6;
  });
});
