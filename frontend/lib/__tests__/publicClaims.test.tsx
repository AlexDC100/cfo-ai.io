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
//   refusal dialog, the public sample page's copy (/sample), the /pricing
//   page as a visitor gets it (hero, billing toggle, FAQ) and the /signup
//   card — and holds:
//
//   C1  no country or region is claimed as covered other than Romania;
//   C2  no accounting-software name that is not in a TESTED row backed by a
//       real file;
//   C3  no input format that is not in a tested row, and no DOCUMENT TYPE
//       other than a trial balance offered as an input, unless the sentence
//       says it is AI-read or not supported;
//   C4  every tested row carries evidence — battery gates that exist, or a
//       dated record (frontend/data/coverageRecords.json) — and counts the
//       proof or the record states; software names are the proof's; the AI
//       row is marked unavailable; rows are dated;
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
// SECOND REVIEW, 2026-10-02 — WHAT THE FIRST VERSION OF THIS GATE LET
// THROUGH, each planted and observed GREEN by a verifier, each RED now:
//   · surfaces it never read: /pricing's hero ("Upload one trial balance,
//     balance sheet, or P&L"), its English-only FAQ ("a balance sheet, a
//     P&L, or an annual report", "Ask CFO AI is available after launch",
//     "What happens if billing is not wired yet?") and /signup ("Free
//     tier"). They are harvested now, as rendered, with a floor each;
//   · a claim excused by ANY negation word in its sentence: "Files from any
//     European country are read by AI — full certification coming soon",
//     "Any European country works, and distance is not a problem". The
//     negation must now sit in the SAME CLAUSE as the claim and say that it
//     is not supported / available / analysed — bare "is not", "planned",
//     "coming soon" and "încă" excuse nothing;
//   · countries outside a typed list of eleven ("Austria · Czechia ·
//     Greece…"): the vocabulary is now every region name the runtime knows
//     (Intl.DisplayNames, English and Romanian), minus Romania;
//   · document types as inputs ("Balance sheets, P&L statements and annual
//     reports are read too", "Ministry-of-Finance filings … SAF-T files —
//     all read automatically"): C3 knew file formats, not document types;
//   · a software name typed as JSX text after an expression, and one added
//     to a tested row of coverage.json (which then allowed it everywhere):
//     a row may name only software engineProof.json `software.proven`
//     holds — a name a committed real file prints;
//   · a book count typed into coverage.json (2 → 20): a count is the
//     proof's or a dated record's, and the row must equal it.
//
// WHAT IT CANNOT SEE (TC-11)
//   · whether a tested row's evidence gate actually exercises that layout —
//     it checks the gate EXISTS in the battery and, where the row is tied to
//     the proof, that the count agrees;
//   · the pixels of the share image (it compares the generator's text
//     record with the hero; regenerate with scripts/build_og_image.mjs);
//   · e-mails and the server-rendered storefront templates;
//   · coverage implied without a region word, a software name, a format
//     or a document type;
//   · an accounting-software name that is not on its list — the software
//     vocabulary is a DENY-LIST of names (it cannot know every product);
//   · whether a dated record is TRUE: it holds a count to its record, and
//     the record says who measured what and when — it cannot re-run a
//     measurement taken on files that are not in the repository.
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
import coverageRecords from "@/data/coverageRecords.json";
import proof from "@/data/engineProof.json";
import "@/components/cfo/bsCanonicalStatusI18n";
import { CoverageTable } from "@/components/cfo/CoverageTable";
import { JurisdictionSelect } from "@/components/cfo/JurisdictionSelect";
import { NonRoUpgradeDialog } from "@/components/cfo/pricing/NonRoUpgradeDialog";
import { PricingTableV2 } from "@/components/cfo/PricingTableV2";
import { MonthlyBillEstimator } from "@/components/cfo/pricing/MonthlyBillEstimator";
import { COMING_SOON_PLAN_IDS, SELLABLE_PLAN_IDS, isOnSalePlanId } from "@/lib/plans";
import { META_DESCRIPTION, META_IMAGE_ALT, META_TITLE } from "@/hooks/useHtmlLangSync";
import { coverageView, evidenceText, type CoverageRowData } from "@/lib/coverage";
import Pricing from "@/pages/cfo/Pricing";
import Signup from "@/pages/cfo/Signup";
import { bulletText, planFeatureBulletsFor, planKeysWithFeatures } from "@/lib/planFeatures";
import {
  __clearPricingConfigForTest,
  __setPricingConfigForTest,
  type PlanConfig,
  type PricingPublicConfig,
} from "@/lib/pricingConfig";
import { friendlyDocumentError, parseUploadRefusal } from "@/lib/uploadRefusals";
import { landingStringsFor } from "@/pages/cfo/landingStrings";
import { SAMPLE_STRINGS } from "@/pages/cfo/sampleStrings";
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
    signIn: vi.fn(), signUp: vi.fn(), signInWithOAuth: vi.fn(),
  }),
}));
// A signed-out visitor has no plan; the page must not reach for the network.
vi.mock("@/lib/planState", async (orig) => ({
  ...(await orig<typeof import("@/lib/planState")>()),
  usePlanState: () => ({ state: null, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const REPO = resolve(__dirname, "../../..");
const LANGS: SurfaceLang[] = ["en", "ro"];

type Row = CoverageRowData;
const ROWS = (coverage as unknown as { rows: Row[] }).rows;
interface CoverageRecordRow {
  id: string; row: string; measured_at: string; measured_by: string; how_en: string; how_ro: string;
  detail: string; real_books_read: number; real_files_refused: number;
}
const RECORDS = (coverageRecords as unknown as { records: CoverageRecordRow[] }).records;
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

/** The dictionary namespaces an upload, pricing, signup or coverage surface
 *  reads. `pricingX` (the /pricing hero), `pricingFaq` and `authX` (the
 *  signup card) were not here until 2026-10-02 — which is how "Upload one
 *  trial balance, balance sheet, or P&L" and "Free tier" stayed public. */
const UPLOAD_NAMESPACES = [
  "dash", "dashboard", "upload", "expectedFormat", "tmpl", "pricing", "coverage",
  "pricingX", "pricingFaq", "authX", "cookieConsent",
];

/** Own text of every element under `root` that carries any. */
function ownTexts(root: Element, selector: string, where: string, out: Line[]): void {
  for (const el of root.querySelectorAll(selector)) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (own.length > 2) out.push({ where: `${where} <${el.tagName.toLowerCase()}>`, text: own });
  }
}

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
  // 3b. the /pricing page as a signed-out visitor gets it — the hero, the
  //     billing toggle, the plan cards, the FAQ — and the /signup page
  __setPricingConfigForTest(CONFIG);
  const pricing = render(<MemoryRouter initialEntries={["/pricing"]}><Pricing /></MemoryRouter>);
  ownTexts(pricing.container, "h1,h2,h3,p,li,span,button,a,summary,div,footer", `pricing-page[${lang}]`, out);
  cleanup();
  const signup = render(<MemoryRouter initialEntries={["/signup"]}><Signup /></MemoryRouter>);
  ownTexts(signup.container, "h1,h2,h3,p,li,span,button,a,label,div,footer", `signup-page[${lang}]`, out);
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
  // 5b. the public sample page (/sample): its own copy, title and meta
  flat(SAMPLE_STRINGS[lang], "", `sample[${lang}]`, out);
  // 6. meta the hook writes, the refusal default, the coverage data itself
  out.push({ where: `META_DESCRIPTION.${lang}`, text: META_DESCRIPTION[lang] });
  out.push({ where: `META_TITLE.${lang}`, text: META_TITLE[lang] });
  out.push({ where: `META_IMAGE_ALT.${lang}`, text: META_IMAGE_ALT[lang] });
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

/** EVERY country and region the runtime can name, in English and Romanian,
 *  minus Romania — generated, not typed. The first version listed eleven
 *  countries; "Austria · Czechia · Greece · Netherlands · Portugal · Serbia
 *  · Croatia" passed it. Matched case-sensitively as whole words (a country
 *  is a proper noun: "Turkey", not "turkey"). */
function regionNames(): string[] {
  const names = new Set<string>();
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const locale of ["en", "ro"]) {
    const display = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
    for (const a of A) for (const b of A) {
      const code = a + b;
      if (code === "RO") continue;
      const name = display.of(code);
      if (name && name.length >= 4) names.add(name);
    }
  }
  // CLDR's long forms and the short ones people type
  for (const extra of ["Czechia", "Cehia", "Olanda", "Holland", "Great Britain", "Marea Britanie", "America"]) {
    names.add(extra);
  }
  return [...names];
}
const REGION_NAMES = regionNames();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REGIONS = new RegExp(
  `(?<![\\p{L}-])(?:${REGION_NAMES.sort((a, b) => b.length - a.length).map(esc).join("|")})(?![\\p{L}-])`, "u");

const BEYOND_ROMANIA = {
  exec(sentence: string): RegExpExecArray | null {
    return BEYOND_WORDS.exec(sentence) ?? BEYOND_ABBREVIATIONS.exec(sentence) ?? REGIONS.exec(sentence);
  },
};

/** THE NEGATION MUST GOVERN THE CLAIM. These say, of the thing named in
 *  the same clause, that it is not supported / available / analysed / read
 *  / on sale / tested — or name it as "other than Romania". Words that
 *  negate SOMETHING ("is not", "planned", "coming soon", "încă", "în
 *  curând") are not here: "Any European country works, and distance is not
 *  a problem" used to pass on its "is not". */
const NEGATED = new RegExp(
  [
    "not (?:yet )?(?:supported|available|analysed|analyzed|read|on sale|tested)",
    "(?:isn't|aren't) (?:yet )?(?:supported|available|read|on sale)",
    "other than romania", "no real book",
    "\\bnu (?:este|sunt|e|a fost|au fost) (?:încă )?(?:suportat\\w*|disponibil\\w*|analizat\\w*|citit\\w*|de vânzare|testat\\w*)",
    "nesuportat\\w*", "indisponibil\\w*", "decât românia",
  ].join("|"),
  "i",
);

/** A sentence's clauses: split at a dash, a semicolon, a colon or a comma.
 *  A claim is excused only by a negation INSIDE ITS OWN clause. */
const clausesOf = (sentence: string): string[] =>
  sentence.split(/\s[—–]\s|;\s|:\s|,\s/).map((c) => c.trim()).filter(Boolean);

/** A clause that is ONLY the verdict on what came before it — "… — not
 *  supported yet", "… — încă nesuportate" — with no subject of its own. */
const BARE_VERDICT = new RegExp(`^(?:încă |yet |still )?(?:${NEGATED.source})`, "i");

/** The clause of `sentence` that makes a coverage claim beyond Romania and
 *  is not said to be unavailable — by its own clause, or by a bare verdict
 *  that follows it — or null. A negation in another clause WITH ITS OWN
 *  SUBJECT excuses nothing: "Any European country works — scanned files
 *  are not supported yet" is a claim. */
function unexcusedClaim(sentence: string): { hit: string; clause: string } | null {
  const clauses = clausesOf(sentence);
  for (let i = 0; i < clauses.length; i += 1) {
    const hit = BEYOND_ROMANIA.exec(clauses[i]);
    if (!hit || NEGATED.test(clauses[i])) continue;
    if (i + 1 < clauses.length && BARE_VERDICT.test(clauses[i + 1])) continue;
    return { hit: hit[0], clause: clauses[i] };
  }
  return null;
}

/** A region word that is not about coverage: where data is stored, where
 *  the model provider is, the GDPR badge. */
const NOT_COVERAGE = new RegExp(
  [
    "infrastructure", "infrastructură", "GDPR", "model provider", "furnizorului nostru de model",
    "made in the eu", "creat în ue",
  ].join("|"),
  "i",
);

/** STRUCTURALLY NEGATIVE SURFACES — places whose own heading says "not
 *  supported yet" / "coming soon", so a line inside them is not a claim
 *  even without a negation in its own clause. Identified by where the line
 *  was harvested from, never by its wording. */
const NEGATIVE_SURFACE: Array<{ where: RegExp; why: string }> = [
  { where: /\.json pricing\.(comingSoon\w*|nonRoBlocked\w*)$/, why: "the coming-soon plan's and the refusal's own dictionary keys" },
  { where: /^non-ro-dialog\[/, why: "the refusal dialog, held to its wording by C7" },
];

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
  "Nexus", "WizCount", "Facturis", "Pluriva", "Keez", "SocrateCloud", "Socrate", "Entersoft",
  "Softone", "Lexware", "NetSuite", "Zoho", "FreshBooks",
];
// A DENY-LIST: it reds on a name it knows. A product it has never heard of
// passes — stated under "cannot see".
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
const AI_OR_NEGATED_RX = new RegExp(
  `\\bAI\\b|${NEGATED.source}|real-file test|test pe fișier real|\\bnu scanat\\w*|not a scan`, "i");
/** Does the sentence say the thing is AI-read or unavailable? The product's
 *  own NAME is not that marker: "…one uploaded file that CFO AI analyzes —
 *  a trial balance, a balance sheet, a P&L" passed on the "AI" in "CFO AI". */
const AI_OR_NEGATED = {
  test: (sentence: string): boolean =>
    AI_OR_NEGATED_RX.test(sentence.replace(/\b(?:Ask )?CFO AI\b/g, " ")),
};

/** A DOCUMENT TYPE other than a trial balance. The engine reads trial
 *  balances; these are read (when they are read at all) by the AI reader. */
const OTHER_DOCUMENT =
  /\bbalance sheets?\b|\bbilan[țt](?:uri|ul|urile)?\b|\bP&(?:amp;)?L\b|profit (?:and|&) loss|income statements?|cont(?:ul|uri)? de profit și pierdere|\bannual reports?\b|raport(?:ul|ului)? anual|rapoarte(?:le)? anuale|\bfilings?\b|raportări (?:depuse|UE)|\bF30\b|\bF10\b|\bSAF-?T\b|e-?Factura|bank statements?|extras(?:e|ul)? de cont|accountant exports?|invoice exports?/i;
const DOC = OTHER_DOCUMENT.source;
const TB = "(?:trial balances?|balanț[ăae](?:le)? de verificare)";
const AND = "(?:,|\\bor\\b|\\band\\b|\\bsau\\b|\\bși\\b)";
/** …offered as an INPUT. Three shapes, each seen in the retired copy:
 *    · listed as a peer of the trial balance ("a trial balance, a balance
 *      sheet, a P&L, or an annual report");
 *    · the object of upload / import ("Upload a balance sheet");
 *    · said to be read, accepted or supported ("…annual reports are read
 *      too", "…SAF-T files — all read automatically").
 *  "CFO AI reconstructs your P&L and balance sheet" and "the balance sheet
 *  must close" name OUTPUTS and are none of these. */
const INPUT_SHAPES: RegExp[] = [
  // (a dash ends the list: "rebuilt from your trial balance — P&L, balance
  // sheet and cash flow" names what is BUILT from it)
  new RegExp(`${TB}[^.;!?—–]{0,40}?${AND}[^.;!?—–]{0,70}?(?:${DOC})`, "i"),
  new RegExp(`(?:${DOC})[^.;!?—–]{0,70}?${AND}[^.;!?—–]{0,40}?${TB}`, "i"),
  new RegExp(`\\b(?:upload\\w*|import\\w*|încarc\\w*|încărc\\w*)\\s+(?:(?:a|an|one|your|the|o|un|una)\\s+)?(?:[\\p{L}-]+\\s+){0,2}?(?:${DOC})`, "iu"),
  new RegExp(`(?:${DOC})[^.!?]{0,90}?\\b(?:(?:is|are|sunt|este)\\s+(?:also\\s+|all\\s+)?(?:read|accepted|supported|ingested|citit\\w*|acceptat\\w*|suportat\\w*)|all read|read too|read automatically)\\b`, "i"),
];
const INPUT_CONTEXT = { test: (sentence: string): boolean => INPUT_SHAPES.some((rx) => rx.test(sentence)) };

/** Software a surface may name: in a tested row's `software` AND printed by
 *  a committed real file (engineProof.json `software.proven`). The row alone
 *  is not enough — typing "SAGA" into a row used to allow it everywhere. */
function allowedSoftware(): Set<string> {
  const proven = new Set(
    (proof as unknown as { software: { proven: string[] } }).software.proven.map((s) => s.toLowerCase()));
  return new Set(TESTED.flatMap((r) => r.software.map((s) => s.toLowerCase())).filter((s) => proven.has(s)));
}

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
    for (const [prefix, floor] of [
      ["landing[", 150], ["pricing-table[", 10], ["coverage-table[", 1], ["non-ro-dialog[", 1],
      [`${lang}.json pricing.`, 30], ["planFeatures.multi", 1], ["sample[", 150], ["META_DESCRIPTION", 1],
      // added 2026-10-02 — surfaces the first version never read
      ["pricing-page[", 40], ["signup-page[", 10], [`${lang}.json pricingX.`, 30],
      [`${lang}.json pricingFaq.`, 12], [`${lang}.json authX.`, 30],
    ] as const) {
      const n = lines.filter((l) => l.where.startsWith(prefix)).length;
      expect(n, `only ${n} line(s) harvested from ${prefix} (floor ${floor})`).toBeGreaterThanOrEqual(floor);
    }
    // the rendered pages are the real ones: their own landmarks are in the harvest
    const pricingPage = lines.filter((l) => l.where.startsWith("pricing-page[")).map((l) => l.text).join(" | ");
    expect(pricingPage, "the /pricing hero was not rendered").toContain(i18n.t("pricingX.hero_sub"));
    expect(pricingPage, "the /pricing FAQ was not rendered").toContain(i18n.t("pricingFaq.whatCounts.q"));
    const signupPage = lines.filter((l) => l.where.startsWith("signup-page[")).map((l) => l.text).join(" | ");
    expect(signupPage, "the /signup subtitle was not rendered").toContain(i18n.t("authX.subtitle_sign_up_page"));
    if (lang === "en") {
      for (const w of ["index.html <title>", "index.html meta[description]", "index.html meta[og:image:alt]", "manifest.description", "og/homepage.json text.headline"]) {
        expect(lines.some((l) => l.where === w), `nothing harvested from ${w}`).toBe(true);
      }
    }
    const offenders: string[] = [];
    for (const line of lines) {
      for (const sentence of sentencesOf(line.text)) {
        if (!BEYOND_ROMANIA.exec(sentence)) continue;
        unitsChecked += 1;
        if (NOT_COVERAGE.test(sentence)) continue;
        const claim = unexcusedClaim(sentence);
        if (!claim) continue;
        // The plan's own name, alone, on its coming-soon card.
        if (/^multi-country$/i.test(sentence.trim())) continue;
        if (NEGATIVE_SURFACE.some((n) => n.where.test(line.where))) continue;
        if (EXEMPT.some((e) => e.where.test(line.where) && e.text.test(line.text))) continue;
        offenders.push(`${line.where}: "${claim.hit}" in the clause "${claim.clause.slice(0, 160)}" of "${sentence.slice(0, 200)}"`);
      }
    }
    expect(offenders, "a coverage claim beyond Romania that its own clause does not negate").toEqual([]);
    unitsChecked += lines.length;
  });

  it("C1 the detector: negation must govern the claim; every country is a country", () => {
    // The four sentences a verifier planted and saw GREEN on the first
    // version of this gate, and the honest ones that must stay green.
    const red = [
      "Files from any European country are read by AI — full certification coming soon.",
      "Any European country works, and distance is not a problem.",
      "Austria · Czechia · Greece · Netherlands · Portugal · Serbia · Croatia.",
      "A trial balance from Romania, Austria or Greece as an Excel .xlsx sheet.",
      "Balanțe din Austria, Grecia sau Olanda.",
      "International coverage is planned.",
    ];
    const green = [
      "Files from other countries are not supported yet, and the Multi-Country plan is not available.",
      "Coming soon — international coverage is not available yet.",
      "Trial balances and financial statements from any country other than Romania",
      "Fișierele din alte țări nu sunt încă suportate.",
      "A file from another country is not analysed correctly today, on any plan.",
      "Upload a Romanian trial balance.",
    ];
    const offends = (text: string) =>
      sentencesOf(text).some((s) => !NOT_COVERAGE.test(s) && unexcusedClaim(s) !== null);
    for (const text of red) expect(offends(text), `should be RED: ${text}`).toBe(true);
    for (const text of green) expect(offends(text), `should be green: ${text}`).toBe(false);
    expect(REGION_NAMES.length, "the region vocabulary collapsed").toBeGreaterThan(400);
    for (const name of ["Austria", "Greece", "Grecia", "Portugal", "Serbia", "Japan", "Japonia", "Brazil"]) {
      expect(REGIONS.test(name), `${name} is not in the vocabulary`).toBe(true);
    }
    expect(REGIONS.test("Romania") || REGIONS.test("România"), "Romania must not be a foreign region").toBe(false);
    unitsChecked += red.length + green.length;
  });

  it("C2 names no accounting software that is not a tested row's, backed by a real file", async () => {
    const lines = await harvest(lang);
    const allowed = allowedSoftware();
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

  it("C3 offers no document type but a trial balance as an input, unless it says AI-read or not supported", async () => {
    const lines = await harvest(lang);
    const offenders: string[] = [];
    let seen = 0;
    for (const line of lines) {
      for (const sentence of sentencesOf(line.text)) {
        const hit = OTHER_DOCUMENT.exec(sentence);
        if (!hit || !INPUT_CONTEXT.test(sentence)) continue;
        seen += 1;
        if (AI_OR_NEGATED.test(sentence)) continue;
        offenders.push(`${line.where}: "${hit[0]}" offered as an input in "${sentence.slice(0, 200)}"`);
      }
    }
    // alive: the landing FAQ and the coverage table DO name these documents — beside the AI reader
    expect(seen, "no document type found in an input sentence — the detector is dead").toBeGreaterThan(1);
    expect(offenders).toEqual([]);
    unitsChecked += seen;
    // the retired sentences, and the outputs that must not trip it
    const red = [
      "Upload one trial balance, balance sheet, or P&L.",
      "A document is one uploaded file that CFO AI analyzes — a trial balance, a balance sheet, a P&L, or an annual report.",
      "Balance sheets, P&L statements and annual reports are read too, deterministically.",
      "Ministry-of-Finance filings, accountant exports, annual reports and SAF-T files — all read automatically.",
      "Încărcați o balanță de verificare, un bilanț sau un cont de profit și pierdere.",
    ];
    const green = [
      "CFO AI reconstructs your P&L and balance sheet, estimates your cash flow.",
      "The balance sheet must close and net income must equal account 121.",
      "A balance sheet, a P&L, an annual report or a scan is not read by the engine: it needs the AI reader.",
    ];
    const offends = (text: string) => sentencesOf(text).some(
      (s) => OTHER_DOCUMENT.test(s) && INPUT_CONTEXT.test(s) && !AI_OR_NEGATED.test(s));
    for (const text of red) expect(offends(text), `should be RED: ${text}`).toBe(true);
    for (const text of green) expect(offends(text), `should be green: ${text}`).toBe(false);
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
    const allowed = allowedSoftware();
    const offenders: string[] = [];
    for (const rel of files) {
      expect(existsSync(join(REPO, rel)), `${rel} is gone — update this list`).toBe(true);
      const src = readFileSync(join(REPO, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");
      // String literals, and JSX TEXT — which starts after a tag (`>`) OR
      // after an expression (`}`): `{" "}SAGA, SmartBill … are supported.`
      // was typed after a `}` and the first version of this scan skipped it.
      for (const m of src.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`|(?<=[>}])[^<>{}]+(?=[<{])/g)) {
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
    const records = new Map(RECORDS.map((rec) => [rec.id, rec]));
    for (const rec of RECORDS) {
      expect(rec.measured_at, `${rec.id}: measured_at`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rec.id.endsWith(rec.measured_at), `${rec.id}: a record's id carries its date`).toBe(true);
      for (const key of ["measured_by", "how_en", "how_ro", "detail"] as const) {
        expect(rec[key].trim().length, `${rec.id}: ${key}`).toBeGreaterThan(3);
      }
      expect(ROWS.some((r) => r.id === rec.row && r.evidence.record === rec.id), `${rec.id}: no row cites this record`).toBe(true);
    }
    const proven = new Set((proof as unknown as { software: { proven: string[] } }).software.proven);
    for (const r of TESTED) {
      const gates = r.evidence.gates ?? [];
      const record = r.evidence.record ? records.get(r.evidence.record) : undefined;
      expect(gates.length > 0 || !!record, `${r.id}: a tested row with no evidence`).toBe(true);
      if (r.evidence.record) {
        expect(record, `${r.id}: evidence names record "${r.evidence.record}", which frontend/data/coverageRecords.json does not hold`).toBeTruthy();
        expect(record?.row, `${r.id}: its record is another row's`).toBe(r.id);
      }
      for (const g of gates) {
        expect(battery.includes(`Gate("${g}"`), `${r.id}: evidence names "${g}", which is not a battery gate`).toBe(true);
      }
      if (typeof r.real_books === "number") {
        expect(r.real_books, `${r.id}: a tested row counting no real book`).toBeGreaterThan(0);
        // A COUNT IS NEVER TYPED ALONE: it is the proof's, or a dated record's.
        if (r.real_books_proof) {
          expect(formats[r.real_books_proof], `${r.id}: real_books is not engineProof.json formats.${r.real_books_proof}`).toBe(r.real_books);
          if (record) expect(record.real_books_read, `${r.id}: its record disagrees with the proof`).toBe(r.real_books);
        } else {
          expect(record, `${r.id}: a typed real-book count needs either real_books_proof or a dated record`).toBeTruthy();
          expect(record?.real_books_read, `${r.id}: real_books is not its record's real_books_read`).toBe(r.real_books);
        }
      } else {
        expect(r.real_books).toBe("constructed test files only");
        expect(r.real_files_refused, `${r.id}: a refusal count on a row with no real file`).toBeUndefined();
      }
      // files refused: stated only with a record, and equal to it
      if (r.real_files_refused !== undefined || (record && record.real_files_refused > 0)) {
        expect(record, `${r.id}: real_files_refused without a dated record`).toBeTruthy();
        expect(r.real_files_refused, `${r.id}: real_files_refused is not its record's`).toBe(record?.real_files_refused);
      }
      // a note states a count only through a token
      for (const note of [r.note_en, r.note_ro]) {
        expect(/\b\d+\s+(?:real\b|balanțe reale|fișier(?:e)? real)/i.test(note), `${r.id}: a count typed into a note — use {read} / {refused} / {held}: "${note.slice(0, 120)}"`).toBe(false);
        expect(/\b\d{4}-\d{2}-\d{2}\b/.test(note), `${r.id}: an ISO date typed into a note — use {record_date}`).toBe(false);
      }
      // A software name is a claim about a real export: it must be a name a
      // committed real file PRINTS (engineProof.json software.proven).
      for (const name of r.software) {
        expect(proven.has(name), `${r.id}: names ${name}, which no committed real file prints (engineProof.json software.proven = [${[...proven].join(", ")}])`).toBe(true);
      }
      if (r.software.length > 0) {
        expect(typeof r.real_books === "number" && !!r.real_books_proof, `${r.id}: names ${r.software.join(", ")} without a gate-backed real file`).toBe(true);
      }
    }
    for (const r of ROWS) {
      if (r.category !== "tested") expect(r.software, `${r.id}: software named outside a tested row`).toEqual([]);
      // what the row prints as evidence exists in both languages
      for (const lang of LANGS) expect(evidenceText(r, lang).length, `${r.id}: no evidence text (${lang})`).toBeGreaterThan(5);
      if (r.evidence.note_en || r.evidence.note_ro) {
        expect(r.evidence.note_en && r.evidence.note_ro, `${r.id}: an evidence note in one language only`).toBeTruthy();
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
    // the AI row lists a trial balance in an unrecognised layout too — such a
    // file was in no row at all until 2026-10-02
    expect(ai[0].label_en).toMatch(/layout none of the readers above recognises/);
    expect(ai[0].label_ro).toMatch(/format pe care niciunul dintre cititoarele de mai sus nu îl recunoaște/);
    // the model-written features say whether they answer today, or that nobody has measured
    const features = (coverage as unknown as { ai_features: Record<string, { availability?: string; as_of?: string }> & { owner_action: string; unavailable_en: string; unavailable_ro: string } }).ai_features;
    for (const key of ["chat", "briefing"]) {
      expect(["available", "unavailable", "unverified"], `ai_features.${key}`).toContain(features[key].availability);
      expect(features[key].as_of, `ai_features.${key}.as_of`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(features.unavailable_en && features.unavailable_ro && features.owner_action).toBeTruthy();
  });

  it("C4 the table prints the denominator: files read, files refused, in the reader's date format", () => {
    for (const lang of LANGS) {
      const view = coverageView(lang);
      const rows = view.groups.flatMap((g) => g.rows);
      const xlsx = rows.find((r) => r.id === "xlsx_10_column")!;
      const text = rows.find((r) => r.id === "pdf_text_layer")!;
      const xlsxRecord = RECORDS.find((rec) => rec.row === "xlsx_10_column")!;
      const textRecord = RECORDS.find((rec) => rec.row === "pdf_text_layer")!;
      const read = (proof as unknown as { formats: Record<string, number> }).formats.xlsx_10_column_layout;
      expect(xlsx.testedOn).toContain(String(read));
      expect(xlsx.testedOn).toMatch(lang === "ro" ? /refuzat/ : /refused/);
      expect(xlsx.note, "the xlsx note states the files held").toContain(String(read + xlsxRecord.real_files_refused));
      expect(text.testedOn).toContain(String(textRecord.real_books_read));
      expect(text.testedOn).toMatch(lang === "ro" ? /refuzat/ : /refused/);
      for (const r of rows) {
        expect(r.note, `${r.id} (${lang}): an unfilled token`).not.toMatch(/\{\w+\}/);
        // no ISO date beside a formatted one: every date goes through the page's printer
        expect(`${r.note} ${r.evidence}`, `${r.id} (${lang}): an ISO date on the page`).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
        unitsChecked += 1;
      }
      // the evidence line is in the reader's language (gate ids are identifiers)
      const prose = rows.map((r) => r.evidence).join(" ");
      if (lang === "ro") expect(prose).not.toMatch(/production reprocess|constructed file|no real book|scripted model reply/);
      else expect(prose).not.toMatch(/reprocesare|fișier construit|nicio balanță/);
    }
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

describe("public-claims · Multi-Country has no other way in", () => {
  it("C6 a ?plan=multi signup link selects nothing, and the bill estimator prices only plans on sale", () => {
    // The landing carried /signup?plan=multi until 2026-10-01; old links and
    // a typed URL still arrive. The signup card resolves a plan only through
    // isOnSalePlanId.
    expect(COMING_SOON_PLAN_IDS).toEqual(["multi"]);
    expect(SELLABLE_PLAN_IDS).toContain("multi"); // the backend's set, unchanged
    expect(isOnSalePlanId("multi")).toBe(false);
    expect(isOnSalePlanId("solo")).toBe(true);
    expect(isOnSalePlanId("pro")).toBe(true);
    const auth = readFileSync(join(REPO, "frontend/components/cfo/AuthCard.tsx"), "utf8")
      .replace(/\/\/[^\n]*/g, " ");
    expect(auth).toContain("isOnSalePlanId(planFromUrl)");
    expect(auth).not.toMatch(/isSellablePlanId\(/);

    render(<MonthlyBillEstimator config={CONFIG} />);
    expect(screen.getByTestId("estimator-plan-solo")).toBeTruthy();
    expect(screen.getByTestId("estimator-plan-pro")).toBeTruthy();
    expect(screen.queryByTestId("estimator-plan-multi"), "a monthly bill is estimated for a plan that is not on sale").toBeNull();
    unitsChecked += 6;
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
    // the title and the image alt follow the reader's language at runtime;
    // index.html ships the English ones the hook would write
    expect(title).toBe(META_TITLE.en);
    expect(META_TITLE.ro).toMatch(/balanță de verificare românească/);
    for (const alt of lines.filter((l) => /image:alt/.test(l.where))) expect(alt.text).toBe(META_IMAGE_ALT.en);
    expect(META_IMAGE_ALT.ro).toMatch(/balanță de verificare românească/);
    const manifest = JSON.parse(readFileSync(join(REPO, "public/manifest.webmanifest"), "utf8"));
    expect(String(manifest.description)).toMatch(/Romanian trial balance/);
    unitsChecked += 6;
  });
});
