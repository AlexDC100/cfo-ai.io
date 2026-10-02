// landing-proof — EVERY ACCURACY NUMBER ON A PUBLIC PAGE IS THE PROOF'S.
//
// Owner, 2026-10-01, after the first public review: the landing said "eight
// calibration fixtures" in one sentence and "9 / 9" in the block beside it.
// Both were typed by hand on 2026-09-08. They counted different things —
// eight books whose balance sheet closes; nine file PATHS re-run five
// times, which are five distinct books — and neither carried a date or the
// list of what was checked.
//
// THE LAW
//   One generated source: frontend/data/engineProof.json, written by
//   scripts/build_engine_proof.py, which RUNS the checks. The landing's
//   proof block and the FAQ render from it. This gate mounts the real
//   <Landing /> in English and Romanian and holds:
//
//   L1  the proof file is whole: five checks, each with what is checked in
//       both languages, how, a count of books, a date; no company named;
//   L2  the proof was measured on THIS engine: its tree digest, parser
//       version and EBITDA definition are the working tree's (a stale
//       proof is a red, not a footnote);
//   L3  every figure the proof block prints is the JSON's — the headline
//       "held / examined" computed here independently of the page, the
//       sentence of what is checked, the date, and every number in the
//       caption — in the reader's number format;
//   L4  the FAQ's answer prints only numbers the JSON holds;
//   L5  no accuracy number is TYPED: the raw copy carries tokens, never a
//       digit, in the accuracy block, and no typed accuracy claim anywhere
//       in the landing copy, the page meta or the manifest;
//   L6  every token resolves, in both languages, and none reaches a reader;
//   L7  the listing counts on the public-company card and in the FAQ are
//       the JSON's;
//   L8  the public sample (/sample) lists THE SAME checks, in the same
//       order and the same words, as the proof block, and the block's
//       link lands on that list (the fragment exists on the sample page).
//   L9  each caption speaks for ITS OWN check: it uses only that check's
//       tokens, and the first "N of M" it prints is that check's held /
//       examined. (2026-10-02: a verifier wired the rerun caption to the
//       replay tokens — "18 of 18 real books", where 5 books were re-run and
//       12 of the 18 replay cases are constructed files — and the turnover
//       caption to the total — "8 of 8 real books match the Ministry-of-
//       Finance figure", where 3 were checkable. Both printed, and L3 and
//       the pair law stayed green: 18 and 8 are numbers of the JSON, and
//       18/18 is a pair of another count. The same defect as the original
//       "9 / 9": a true count under the wrong noun.)
//   L10 no speed and no ratio count nobody measured: "in 90 seconds",
//       "under five minutes", "in minutes", "22 ratios" are on no public
//       surface.
//   L11 a sentence about THE VISITOR'S OWN FILE promises only what runs on
//       every file — the balance check and account 121. The proof block is
//       measured on test books; "your own file gets the same checks, and
//       its report shows each result" (the note under the block, and the
//       FAQ) was false for three of the five: an upload is not re-run five
//       times and byte-compared, its turnover is not compared with a filing,
//       and the methodology-vs-code comparison is a script over the test
//       books. No gate read the sentence: "Your own file is guaranteed to
//       reconcile exactly" was planted and passed.
//
//   L12 THE RENDERED PAGES (2026-10-02, the third review). L3–L5 read the
//       proof block and the landing's string table. A verifier typed an
//       accuracy claim into the landing's MARKUP above the proof block, as
//       a number WORD ("all nine real books"), in words outside the fixed
//       vocabulary ("Tested on 40 real company books, all correct"), and on
//       /pricing, /signup and /sample — every gate printed PASS. L12 mounts
//       the landing, /pricing, /signup, /sample and /contact-sales in both
//       languages and reads EVERY TEXT NODE (a TreeWalker): outside the
//       proof block, the coverage table and the hero's illustrative mock,
//       no percentage, no "N of M", and no digit or number word beside
//       books / balanțe / fixtures / tested / verified / correct / accurate
//       — unless the text IS a string of the copy that carries proof tokens
//       (its numbers then came from engineProof.json; its typed remainder
//       is read by the raw scan). The raw scan reads the same rules over
//       the landing's strings, the /pricing, /signup and /contact-sales
//       dictionaries, the plan bullets and the sample page's strings.
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11)
//   · an accuracy claim typed anywhere a visitor reads — markup, a string
//     table, a dictionary — on any of the five public pages, as a
//     percentage, an "N of M" or a count beside a measuring word — L12;
//   · a digit typed into `defensible.*` or into an accuracy sentence
//     ("all eight within 1%", "9 / 9", "four of eight") — L5;
//   · a caption whose number is not in that check's JSON block — L3;
//   · the proof block's headline differing from held / examined — L3;
//   · the JSON edited by hand without re-measuring, or the engine changed
//     without re-measuring (digest mismatch) — L2;
//   · a check dropped from the page or from the JSON — L1, L3;
//   · "re-run on every deploy" or any cadence the proof does not carry — L5;
//   · the sample page wording a check its own way, dropping or reordering
//     one, or the proof block's link pointing at a fragment the sample page
//     does not carry — L8.
//
// WHAT IT CANNOT SEE (TC-11)
//   · whether the JSON's counts are TRUE. That is `engine-proof`
//     (tests/engine/test_engine_proof.py), which re-runs the script;
//   · accuracy wording with no number in it ("highly accurate", "always
//     right", "every book we tried");
//   · a count parted from its measuring word by a dash, a colon or a
//     bracket ("Tested — on 40 files"), or beside a word that is not in the
//     vocabulary ("40 companies' ledgers, all fine");
//   · a number above twenty written out in compound words ("ninety-nine
//     point nine percent" is caught on "percent"; "a hundred and four" is
//     caught on "hundred"; "twoscore" is not);
//   · text in an image, a canvas or a CSS `content:` string;
//   · the hero's illustrative mock and its decorative ticker — exempt by
//     region, labelled "Illustrative dashboard" on the page (L12 holds that
//     label to exist);
//   · pages behind a session, the standalone storefront templates and
//     e-mails (not rendered here).
//
// Plant log: docs/engine_book/gates.md, "landing-proof".

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import proof from "@/data/engineProof.json";
import { ENGINE_PROOF, fillProofDeep, hasProofToken, proofDate } from "@/lib/engineProof";
import { LANDING_STRINGS, landingStringsFor } from "@/pages/cfo/landingStrings";
import PublicSample from "@/pages/cfo/PublicSample";
import { META_DESCRIPTION, META_IMAGE_ALT, META_TITLE } from "@/hooks/useHtmlLangSync";
import enDict from "@/i18n/locales/en.json";
import roDict from "@/i18n/locales/ro.json";
import { foreignNumber } from "@/test/numberLanguage";
import { accuracyClaims, plainText } from "@/test/accuracyClaims";
import {
  PUBLIC_PAGES, numbersIn, renderLanding, renderPublicPage, setLanguage, textNodes, textOf,
  type PublicPage, type SurfaceLang,
} from "@/test/publicSurfaces";
import { __clearPricingConfigForTest } from "@/lib/pricingConfig";
import { bulletText, planFeatureBulletsFor, planKeysWithFeatures } from "@/lib/planFeatures";
import { SAMPLE } from "@/lib/publicSample";
import { SAMPLE_STRINGS } from "@/pages/cfo/sampleStrings";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    isAuthenticated: false, displayName: null, initials: null, user: null,
    status: "signed_out", signOut: vi.fn(),
    signIn: vi.fn(), signUp: vi.fn(), signInWithOAuth: vi.fn(),
  }),
}));
// A signed-out visitor has no plan; the pages must not reach for the network.
vi.mock("@/lib/planState", async (orig) => ({
  ...(await orig<typeof import("@/lib/planState")>()),
  usePlanState: () => ({ state: null, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const REPO = resolve(__dirname, "../../..");
const LANGS: SurfaceLang[] = ["en", "ro"];

// The numerator each check's headline prints — written HERE, not imported
// from lib/engineProof, so the page's printer is checked against a second
// reading of the same file.
const HELD: Record<string, string> = {
  rerun_identical: "books_identical",
  balance_sheet_closes: "books_closing_exactly",
  net_income_equals_121: "books_equal_to_the_cent",
  turnover_equals_filing: "books_within_tolerance",
  ebitda_variants_agree: "books_within_tolerance",
};
const CHECK_IDS = Object.keys(HELD);

interface RawCheck {
  id: string; what_en: string; what_ro: string; how: string; subjects: number;
  result: Record<string, number>; passed: boolean; measured_at: string;
}
const CHECKS = (proof as unknown as { checks: RawCheck[] }).checks;
const checkOf = (id: string): RawCheck => {
  const c = CHECKS.find((x) => x.id === id);
  if (!c) throw new Error(`engineProof.json has no check ${id}`);
  return c;
};

/** Every number a check's caption may print: its book count, each figure
 *  of its result block, and the total of real books. */
function allowedNumbers(c: RawCheck): Set<number> {
  const out = new Set<number>([c.subjects, ...Object.values(c.result)]);
  const total = (proof as { real_books_total: number | null }).real_books_total;
  if (typeof total === "number") out.add(total);
  return out;
}

/** "account 121" / "contul 121" is an account number, not a measurement. */
const stripAccountIds = (text: string): string =>
  text.replace(/\b(account|accounts|contul|contului|cont|conturile)\s+121\b/gi, "$1");

let figuresChecked = 0;

afterEach(() => { cleanup(); __clearPricingConfigForTest(); });
afterAll(async () => {
  await setLanguage("en");
  console.log(`GATE-WORK landing-proof figures=${figuresChecked}`);
});

// ── L1 ────────────────────────────────────────────────────────────────

describe("landing-proof · the proof file", () => {
  it("L1 carries five dated checks, each saying what is checked, in both languages", () => {
    expect(ENGINE_PROOF.schema).toBe("engine_proof/1");
    expect(ENGINE_PROOF.scope, "a proof over the committed subset must never be published").toBe("full");
    expect(ENGINE_PROOF.measured_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CHECKS.map((c) => c.id)).toEqual(CHECK_IDS);
    for (const c of CHECKS) {
      expect(c.subjects, `${c.id}: no book examined`).toBeGreaterThan(0);
      expect(c.what_en.length, `${c.id}: what_en`).toBeGreaterThan(20);
      expect(c.what_ro.length, `${c.id}: what_ro`).toBeGreaterThan(20);
      expect(c.how.length, `${c.id}: how`).toBeGreaterThan(10);
      expect(c.measured_at, `${c.id}: date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.passed, `${c.id} did not hold and must not be published`).toBe(true);
      expect(c.result[HELD[c.id]], `${c.id}: ${HELD[c.id]}`).toBeTypeOf("number");
      expect(c.result[HELD[c.id]]).toBeLessThanOrEqual(c.subjects);
      figuresChecked += 1;
    }
  });

  it("L1 names no company and publishes no company's figure", () => {
    // The labels the proof scripts use for the calibration books, read off
    // the scripts themselves — so a label added there is forbidden here.
    const drift = readFileSync(join(REPO, "scripts/measure_bs_drift.py"), "utf8");
    const block = /_PER_FIXTURE_THRESHOLD\s*=\s*\{([\s\S]*?)\}/.exec(drift);
    expect(block, "fixture label table not found in measure_bs_drift.py").not.toBeNull();
    const labels = [...(block as RegExpExecArray)[1].matchAll(/"([A-Za-z]+)"\s*:/g)].map((m) => m[1]);
    for (const dir of readdirSync(join(REPO, "corpus"))) {
      const m = /^saga_10_col_([a-z]+)$/.exec(dir);
      if (m) labels.push(m[1]);
    }
    expect(labels.length, "no fixture labels harvested").toBeGreaterThanOrEqual(8);
    const text = JSON.stringify(proof).toLowerCase();
    const named = labels.filter((l) => new RegExp(`\\b${l.toLowerCase()}\\b`).test(text));
    expect(named, "engineProof.json names a calibration book").toEqual([]);
    // Counts, tolerances and one largest difference only: nothing with the
    // magnitude of a company's turnover or balance.
    const big = [...JSON.stringify(proof).matchAll(/:\s*(-?\d+(?:\.\d+)?)/g)]
      .map((m) => Number(m[1])).filter((n) => Math.abs(n) >= 1000);
    expect(big, "a figure of company size is in the public proof").toEqual([]);
  });
});

// ── L2 ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["__pycache__", ".pytest_cache", ".mypy_cache"]);

function identityFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(REPO, rel))) {
      const child = `${rel}/${name}`;
      const st = statSync(join(REPO, child));
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(child);
      } else if (st.isFile()) {
        if (name === ".DS_Store" || name.endsWith(".pyc") || name.endsWith(".pyo")) continue;
        out.push(child);
      }
    }
  };
  for (const root of ENGINE_PROOF.engine.tree_roots) walk(root);
  // The script sorts by code point; so does this (not localeCompare).
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("landing-proof · the proof speaks for this engine", () => {
  it("L2 the tree digest, parser version and EBITDA definition are the working tree's", () => {
    const files = identityFiles();
    const h = createHash("sha256");
    for (const rel of files) {
      h.update(rel, "utf8");
      h.update("\0");
      h.update(createHash("sha256").update(readFileSync(join(REPO, rel))).digest("hex"), "ascii");
      h.update("\n");
    }
    const digest = h.digest("hex");
    expect(
      { files: files.length, digest },
      "STALE PROOF — src/engine or packs changed since frontend/data/engineProof.json was " +
        "measured. Re-measure: python scripts/build_engine_proof.py",
    ).toEqual({ files: ENGINE_PROOF.engine.tree_files, digest: ENGINE_PROOF.engine.tree_sha256 });

    const parser = readFileSync(
      join(REPO, "src/engine/country_packs/ro_romania/trial_balance_parser.py"), "utf8");
    expect(/^PARSER_VERSION = "([^"]+)"/m.exec(parser)?.[1]).toBe(ENGINE_PROOF.engine.parser_version);

    const coa = readFileSync(
      join(REPO, "src/engine/country_packs/ro_romania/chart_of_accounts.py"), "utf8");
    const def = /^EBITDA_DEFINITION_REVISION = \(\s*((?:"[^"]*"\s*)+)\)/m.exec(coa);
    expect(def, "EBITDA_DEFINITION_REVISION not found").not.toBeNull();
    const revision = [...(def as RegExpExecArray)[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
    expect(revision).toBe(ENGINE_PROOF.engine.ebitda_definition);
    figuresChecked += 3;
  });
});

// ── L3, L4, L7 — the rendered page ────────────────────────────────────

describe.each(LANGS)("landing-proof · the rendered landing (%s)", (lang) => {
  it("L3 the proof block prints the JSON: headline, what is checked, date, caption figures", async () => {
    const root = await renderLanding(lang);
    const strip = root.querySelector("#proof-strip");
    expect(strip, "the proof block is not on the landing").not.toBeNull();
    const rows = [...(strip as Element).querySelectorAll("[data-proof-check]")];
    expect(rows.map((r) => r.getAttribute("data-proof-check"))).toEqual(CHECK_IDS);

    for (const row of rows) {
      const c = checkOf(row.getAttribute("data-proof-check") as string);
      // headline — held / examined, computed here
      expect(textOf(row.querySelector("[data-proof-value]")), `${c.id} headline`).toBe(
        `${c.result[HELD[c.id]]} / ${c.subjects}`,
      );
      // what is checked — the JSON's sentence
      expect(textOf(row.querySelector("[data-proof-what]")), `${c.id} what`).toBe(
        lang === "ro" ? c.what_ro : c.what_en,
      );
      // the date
      const time = row.querySelector("time[data-proof-date]");
      expect(time?.getAttribute("datetime"), `${c.id} date`).toBe(c.measured_at);
      const [year, , day] = c.measured_at.split("-");
      expect(textOf(time)).toContain(year);
      expect(textOf(time)).toContain(String(Number(day)));
      // every number in the caption is one of this check's numbers
      const caption = stripAccountIds(textOf(row.querySelector("[data-proof-caption]")));
      expect(caption.length, `${c.id}: empty caption`).toBeGreaterThan(20);
      expect(hasProofToken(caption), `${c.id}: unfilled token in "${caption}"`).toBe(false);
      const allowed = allowedNumbers(c);
      const printed = numbersIn(caption, lang);
      expect(printed.length, `${c.id}: the caption states no figure`).toBeGreaterThan(0);
      for (const n of printed) {
        expect(allowed.has(n), `${c.id} (${lang}) prints ${n}, which is not in its proof block ` +
          `[${[...allowed].join(", ")}]: "${caption}"`).toBe(true);
        figuresChecked += 1;
      }
      // …in the reader's number format, the code after the figure, never "lei"
      expect(foreignNumber(caption, lang), `${c.id} (${lang}): other language's number format`).toBeNull();
      expect(/\blei\b/i.test(caption), `${c.id}: "lei"`).toBe(false);
    }
    expect(textOf(strip)).not.toMatch(/every deploy|fiecare instalare|latest battery|ultima baterie/i);
    // the block links to the public sample's list of these checks (L8
    // holds the fragment to the sample page)
    expect(strip?.querySelector('a[href^="/sample"][data-sample-link="proof"]'),
      "no link to /sample in the proof block").not.toBeNull();
  });

  it("L8 the public sample lists the same checks in the same words, and the proof block's link lands on them", async () => {
    const root = await renderLanding(lang);
    const strip = root.querySelector("#proof-strip") as Element;
    const onLanding = [...strip.querySelectorAll("[data-proof-check]")].map((row) => ({
      id: row.getAttribute("data-proof-check"),
      what: textOf(row.querySelector("[data-proof-what]")),
    }));
    const href = strip.querySelector('a[data-sample-link="proof"]')?.getAttribute("href") ?? "";
    cleanup();

    const sample = render(
      <MemoryRouter initialEntries={[href]}>
        <PublicSample />
      </MemoryRouter>,
    );
    const list = sample.getByTestId("sample-checks");
    const onSample = [...list.querySelectorAll("[data-proof-check]")].map((row) => ({
      id: row.getAttribute("data-proof-check"),
      what: textOf(row.querySelector("[data-proof-what]")),
    }));
    expect(onLanding.length, "the proof block lists no check").toBe(CHECK_IDS.length);
    expect(onSample, `${lang}: the sample page's checks are not the proof block's, word for word`).toEqual(onLanding);
    // each check says what it reads on the fictional book, in this language
    for (const row of list.querySelectorAll("[data-proof-check]")) {
      const reading = textOf(row.querySelector("[data-check-reading]"));
      expect(reading.length, `${row.getAttribute("data-proof-check")}: no reading on the sample`).toBeGreaterThan(40);
      expect(reading, "an unfilled placeholder").not.toMatch(/\{\w+\}/);
      expect(foreignNumber(reading, lang), `${lang}: other language's number format`).toBeNull();
      expect(/\blei\b/i.test(reading), `"lei"`).toBe(false);
      figuresChecked += 1;
    }
    // the link's fragment is an element of the sample page
    const [path, fragment] = href.split("#");
    expect(path).toBe("/sample");
    expect(fragment, "the proof block's link names no fragment of the sample page").toBeTruthy();
    expect(sample.container.querySelector(`#${fragment}`), `/sample has no #${fragment}`).not.toBeNull();
    expect(sample.container.querySelector(`#${fragment}`)?.contains(list)).toBe(true);
    figuresChecked += onSample.length;
  });

  it("L4 the FAQ's proof answer prints only numbers the JSON holds", async () => {
    const root = await renderLanding(lang);
    const raw = LANDING_STRINGS[lang].faq.items;
    const filled = landingStringsFor(lang).faq.items;
    const idx = raw.findIndex((it) => /\{rerun\./.test(it.a));
    expect(idx, "no FAQ item carries the proof").toBeGreaterThanOrEqual(0);
    const answer = stripAccountIds(filled[idx].a);
    expect(textOf(root.querySelector("#faq")), "the proof answer is not rendered").toContain(
      textOf({ textContent: filled[idx].q } as Element),
    );
    const allowed = new Set<number>();
    for (const c of CHECKS) for (const n of allowedNumbers(c)) allowed.add(n);
    // the date's own digits (day, year) are the proof's date
    const date = proofDate(ENGINE_PROOF.measured_at, lang);
    const printed = numbersIn(answer.replace(date, ""), lang);
    expect(printed.length).toBeGreaterThanOrEqual(10);
    for (const n of printed) {
      expect(allowed.has(n), `FAQ (${lang}) prints ${n}, not in the proof: "${answer}"`).toBe(true);
      figuresChecked += 1;
    }
    expect(answer).toContain(date);
    expect(foreignNumber(answer, lang)).toBeNull();
  });

  it("L7 the listing counts are the JSON's, on the card and in the FAQ", async () => {
    const root = await renderLanding(lang);
    const { bvb_listings, bvb_listings_with_financials } = ENGINE_PROOF.counts;
    const product = textOf(root.querySelector("#product"));
    const faq = textOf(root.querySelector("#faq"));
    for (const [where, text] of [["module card", product], ["FAQ", faq]] as const) {
      expect(text, `${where} (${lang}): listings`).toContain(String(bvb_listings));
      expect(text, `${where} (${lang}): with financials`).toContain(String(bvb_listings_with_financials));
      figuresChecked += 2;
    }
    expect(product).not.toMatch(/every company|toate companiile/i);
  });

  it("L6 no token reaches a reader", async () => {
    const root = await renderLanding(lang);
    const text = textOf(root);
    expect(/\{[a-z]+\.[A-Za-z0-9_.]+\}/.exec(text)?.[0] ?? null).toBeNull();
    expect(text).not.toContain("{when}");
  });
});

// ── L5, L6 — the raw copy ─────────────────────────────────────────────

/** A typed accuracy claim: a percentage, an "N of M" or a number word
 *  beside the vocabulary of measuring the engine. */
const ACCURACY_WORDS =
  /drift|abatere|reconcil|accura|acurate|precizi|fixture|calibr|byte|octet|identic|imbalance|dezechilibr|re-?run|rerul|every deploy|fiecare instalare/i;
const TYPED_FIGURE =
  /\d+(?:[.,]\d+)?\s*%|[≤<]\s*\d|\b\d+\s*(?:\/|of|din)\s*\d+\b|\b(?:two|three|four|five|six|seven|eight|nine|ten|două|trei|patru|cinci|șase|șapte|opt|nouă|zece)\s+(?:of|din|calibration|cazuri|fixtures)\b/i;

function flat(obj: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof obj === "string") out.push([path, obj]);
  else if (Array.isArray(obj)) obj.forEach((v, i) => flat(v, `${path}[${i}]`, out));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) flat(v, path ? `${path}.${k}` : k, out);
  }
}

/** The token namespaces a check's caption may use. `proof.books` (the total
 *  of real books) belongs to the one check whose sentence is about the
 *  books it could NOT examine. */
const CAPTION_TOKENS: Record<string, RegExp> = {
  rerun_identical: /^(?:rerun|replay)\./,
  balance_sheet_closes: /^(?:balance|drift)\./,
  net_income_equals_121: /^net\./,
  turnover_equals_filing: /^(?:turnover\.|proof\.books$)/,
  ebitda_variants_agree: /^ebitda\./,
};

describe("landing-proof · each caption speaks for its own check", () => {
  it("L9 a caption uses only its own check's tokens, and leads with that check's held / examined", () => {
    for (const lang of LANGS) {
      const raw = LANDING_STRINGS[lang].defensible.proof.captions as Record<string, string>;
      const filled = landingStringsFor(lang).defensible.proof.captions as Record<string, string>;
      for (const id of CHECK_IDS) {
        const tokens = [...raw[id].matchAll(/\{([a-z]+(?:\.[A-Za-z0-9_]+)+)\}/g)].map((m) => m[1]);
        expect(tokens.length, `${lang} ${id}: no token`).toBeGreaterThan(1);
        const foreign = tokens.filter((t) => !CAPTION_TOKENS[id].test(t));
        expect(foreign, `${lang} caption ${id} prints another check's figure`).toEqual([]);
        const c = checkOf(id);
        const lead = /(\d+)\s+(?:of|din)\s+(\d+)/.exec(filled[id]);
        expect(lead, `${lang} caption ${id} states no "N of M"`).not.toBeNull();
        expect(
          [Number(lead![1]), Number(lead![2])],
          `${lang} caption ${id} leads with ${lead![0]}, which is not this check's ` +
            `held / examined (${c.result[HELD[id]]} / ${c.subjects}): "${filled[id]}"`,
        ).toEqual([c.result[HELD[id]], c.subjects]);
        figuresChecked += 2;
      }
    }
  });
});

describe("landing-proof · nothing unmeasured", () => {
  it("L10 quotes no speed and no ratio count on any public surface", () => {
    // Nobody has measured upload-to-report in production; and the "22" the
    // hero carried is the Excel export's ratio-spec count, while the report
    // the landing links to states 30 ratios and composites. Until either is
    // measured and dated, neither is printed.
    // (`u` flag and explicit look-arounds: without it `\b` does not see "î"
    // as a letter, so a pattern starting `\bîn` can never match.)
    const SPEED = new RegExp(
      [
        "(?<![\\p{L}\\d])\\d+\\s*(?:de\\s+)?(?:seconds?|secunde|minutes?|minute)(?![\\p{L}])",
        "(?<![\\p{L}])(?:under|in|within|less than)\\s+(?:a few |five |ten |two |\\d+ )?(?:seconds|minutes)(?![\\p{L}])",
        "(?<![\\p{L}])în(?:tr-un)?\\s+(?:mai puțin de )?(?:câteva |cinci |zece |două |\\d+ (?:de )?)?(?:secunde|minute|minut)(?![\\p{L}])",
      ].join("|"),
      "iu",
    );
    const RATIO_COUNT = /\b\d+\+?\s*(?:de\s+)?(?:financial\s+)?(?:ratios|indicatori)\b/i;
    const lines: Array<[string, string]> = [];
    for (const lang of LANGS) flat(landingStringsFor(lang), `landingStrings[${lang}]`, lines);
    const html = readFileSync(join(REPO, "index.html"), "utf8");
    lines.push(["index.html <title>", /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? ""]);
    for (const m of html.matchAll(/content\s*=\s*"([^"]*)"/g)) lines.push(["index.html meta", m[1]]);
    const manifest = JSON.parse(readFileSync(join(REPO, "public/manifest.webmanifest"), "utf8"));
    lines.push(["manifest.description", String(manifest.description)]);
    for (const lang of LANGS) {
      lines.push([`META_DESCRIPTION.${lang}`, META_DESCRIPTION[lang]]);
      lines.push([`META_TITLE.${lang}`, META_TITLE[lang]]);
      lines.push([`META_IMAGE_ALT.${lang}`, META_IMAGE_ALT[lang]]);
    }
    flat(JSON.parse(readFileSync(join(REPO, "public/og/homepage.json"), "utf8")).text, "og/homepage.json", lines);
    for (const [lang, dict] of [["en", enDict], ["ro", roDict]] as const) {
      const d = dict as unknown as Record<string, Record<string, unknown>>;
      for (const ns of ["pricingX", "pricingFaq"]) flat(d[ns], `${lang}.json ${ns}`, lines);
      flat({ a: d.authX.subtitle_sign_up, b: d.authX.subtitle_sign_up_page }, `${lang}.json authX`, lines);
    }
    expect(lines.length, "the harvest is empty").toBeGreaterThan(450);
    const offenders = lines
      // the 7-day trial and "7 zile" are durations of an offer, not a speed;
      // the proof's own dates are not either
      .filter(([, text]) => SPEED.test(text) || RATIO_COUNT.test(text))
      .map(([where, text]) => `${where}: "${text.slice(0, 160)}"`);
    expect(offenders, "an unmeasured speed or count is printed").toEqual([]);
    // the detector is alive
    for (const text of ["a CFO-grade analysis in 90 seconds.", "get a full analysis in under five minutes", "în 90 de secunde", "în mai puțin de cinci minute", "first analysis in minutes.", "22 ratios", "22 de indicatori", "în câteva minute fiecare"]) {
      expect(SPEED.test(text) || RATIO_COUNT.test(text), `not detected: ${text}`).toBe(true);
    }
    figuresChecked += lines.length;
  });
});

describe("landing-proof · the visitor's own file", () => {
  /** The visitor's own upload, in either language. */
  const OWN_FILE =
    /\byour (?:own )?(?:file|upload|trial balance|data|books?)\b|(?<![\p{L}])(?:fișierul tău|balanța ta|datele tale|încărcarea ta)(?![\p{L}])/iu;
  /** A promise wider than "these two checks run, and the difference is
   *  shown": the same checks as the test books, a guarantee, exactness,
   *  accuracy, each / every result. */
  const PROMISE =
    /\bsame checks\b|aceleași verificări|guarantee\w*|garant\w*|\bexactly\b|\bexact\b(?! la)|\baccura\w*|\bprecis\w*|each result|every result|fiecare rezultat|\balways (?:reconcil|balanc|clos)\w*|reconcil\w* (?:exactly|to|within)|\bbyte|octet/iu;

  it("L11 a sentence about your own file promises only the two checks that run on every file", () => {
    const lines: Array<[string, string]> = [];
    for (const lang of LANGS) flat(landingStringsFor(lang), `landingStrings[${lang}]`, lines);
    for (const lang of LANGS) lines.push([`META_DESCRIPTION.${lang}`, META_DESCRIPTION[lang]]);
    const sentences = lines.flatMap(([where, text]) =>
      text.split(/(?<=[.!?])\s+/).map((sentence) => [where, sentence] as const));
    const about = sentences.filter(([, sentence]) => OWN_FILE.test(sentence));
    // the copy does speak about the visitor's file, in both languages
    expect(about.filter(([w]) => w.startsWith("landingStrings[en]")).length).toBeGreaterThanOrEqual(3);
    expect(about.filter(([w]) => w.startsWith("landingStrings[ro]")).length).toBeGreaterThanOrEqual(3);
    const offenders = about
      .filter(([, sentence]) => PROMISE.test(sentence))
      .map(([where, sentence]) => `${where}: "${sentence.slice(0, 220)}"`);
    expect(offenders, "a promise about the visitor's own file that no check on that file backs").toEqual([]);
    // what the copy must say instead, where it says anything: the two checks
    for (const lang of LANGS) {
      const note = landingStringsFor(lang).defensible.proof.note;
      expect(note).toMatch(lang === "ro" ? /contul 121/ : /account 121/);
      expect(note).toMatch(lang === "ro" ? /doar pe balanțele de test/ : /on the test books only/);
    }
    // the detector is alive on the two sentences that were on the page or planted
    for (const text of [
      "These are checks on our test books — your own file gets the same checks, and its report shows each result.",
      "Your own file is guaranteed to reconcile exactly.",
      "Fișierul tău trece prin aceleași verificări, iar raportul lui arată fiecare rezultat.",
    ]) {
      expect(OWN_FILE.test(text) && PROMISE.test(text), `not detected: ${text}`).toBe(true);
    }
    figuresChecked += about.length;
  });
});

describe("landing-proof · the raw copy", () => {
  it("L5 the accuracy block carries tokens, never a digit", () => {
    for (const lang of LANGS) {
      const lines: Array<[string, string]> = [];
      flat(LANDING_STRINGS[lang].defensible, "defensible", lines);
      expect(lines.length).toBeGreaterThan(10);
      const typed = lines
        .map(([where, text]) => [where, stripAccountIds(text)] as const)
        .filter(([, text]) => /\d/.test(text.replace(/\{[^}]+\}/g, "")))
        .map(([where, text]) => `landingStrings[${lang}].${where}: "${text}"`);
      expect(typed, "a number is typed into the accuracy copy — it must come from engineProof.json").toEqual([]);
      // and the captions do use the proof
      for (const id of CHECK_IDS) {
        const caption = LANDING_STRINGS[lang].defensible.proof.captions[id as keyof typeof HELD];
        expect(hasProofToken(caption), `${lang} caption ${id} uses no proof token`).toBe(true);
      }
    }
  });

  it("L5 no accuracy claim is typed anywhere in the landing copy, the page meta or the manifest", () => {
    const lines: Array<[string, string]> = [];
    for (const lang of LANGS) flat(LANDING_STRINGS[lang], `landingStrings[${lang}]`, lines);
    const html = readFileSync(join(REPO, "index.html"), "utf8");
    lines.push(["index.html <title>", /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? ""]);
    for (const m of html.matchAll(/content\s*=\s*"([^"]*)"/g)) lines.push(["index.html meta", m[1]]);
    const manifest = JSON.parse(readFileSync(join(REPO, "public/manifest.webmanifest"), "utf8"));
    lines.push(["manifest.description", String(manifest.description)]);
    for (const lang of LANGS) lines.push([`META_DESCRIPTION.${lang}`, META_DESCRIPTION[lang]]);
    expect(lines.length, "the harvest is empty").toBeGreaterThan(300);
    expect(lines.some(([w]) => w === "index.html <title>")).toBe(true);

    const offenders = lines
      .map(([where, text]) => [where, stripAccountIds(text).replace(/\{[^}]+\}/g, "")] as const)
      .filter(([, text]) => ACCURACY_WORDS.test(text) && TYPED_FIGURE.test(text))
      .map(([where, text]) => `${where}: "${text.slice(0, 200)}"`);
    expect(offenders, "a typed accuracy figure — every such number comes from engineProof.json").toEqual([]);
    figuresChecked += lines.length;
  });

  it("L6 every token resolves in both languages", () => {
    for (const lang of LANGS) {
      const filled = fillProofDeep(LANDING_STRINGS[lang], lang);
      const lines: Array<[string, string]> = [];
      flat(filled, "", lines);
      const left = lines.filter(([, text]) => hasProofToken(text)).map(([w]) => w);
      expect(left, `${lang}: unfilled tokens`).toEqual([]);
    }
    // an unknown token is refused, not printed
    expect(() => fillProofDeep({ x: "{rerun.boks} of {rerun.subjects}" }, "en")).toThrow(/unknown proof token/);
  });
});

// ── L12 — every text node of every public page ────────────────────────

/** Where a number MAY stand on a rendered page without coming from a proof
 *  token, and why. Regions, never sentences. */
const EXEMPT_REGIONS: Record<PublicPage, Array<{ selector: string; why: string }>> = {
  landing: [
    { selector: "#proof-strip", why: "the proof block — held figure by figure to engineProof.json by L3 and L9" },
    { selector: "#coverage", why: "the coverage table — held to coverage.json and the proof by public-claims C4 / C5" },
    { selector: "[data-hero-mock]", why: "the hero's illustrative dashboard, labelled so by the note under it" },
    { selector: "#cfo-ticker-board", why: "the hero's decorative ticker (aria-hidden, random moves) — part of the same illustration" },
  ],
  pricing: [],
  signup: [],
  "contact-sales": [],
  sample: [
    { selector: "[data-engine-words]", why: "the engine's own sentences, quoted — held to the served document by public-sample S6" },
  ],
};

/** The strings of the copy that carry proof tokens, FILLED, cut at their
 *  inline tags: a rendered text node that IS one of these got its numbers
 *  from engineProof.json. (Its typed remainder is read raw, below.) */
function tokenFilledSegments(lang: SurfaceLang): Set<string> {
  const raw: Array<[string, string]> = [];
  flat(LANDING_STRINGS[lang], "", raw);
  const filled: Array<[string, string]> = [];
  flat(landingStringsFor(lang), "", filled);
  const out = new Set<string>();
  raw.forEach(([, text], i) => {
    if (!hasProofToken(text)) return;
    for (const segment of filled[i][1].split(/<[^>]+>/)) {
      const plain = plainText(segment);
      if (plain) out.add(plain);
    }
  });
  return out;
}

/** THE SAMPLE PAGE'S OWN TWO NUMBERS, each checked against its data before
 *  it is set aside:
 *    · "the two trial balances" / "cele două balanțe" are the two workbooks
 *      the page publishes — counted in publicSample.json, and the phrase is
 *      removed only while that count is two;
 *    · the composite score is printed "N of 100", and N is the served
 *      composite. */
const SAMPLE_BOOKS = (SAMPLE.files as Array<{ kind: string }>).filter((f) => f.kind === "trial_balance").length;
const TWO_BOOKS = /\b(?:the two trial balances|cele două balanțe(?: de verificare)?)/giu;
function sampleText(text: string): string {
  return SAMPLE_BOOKS === 2 ? text.replace(TWO_BOOKS, " ") : text;
}
function sampleScoreOf100(hit: string, sentence: string, lang: SurfaceLang): boolean {
  const composite = (SAMPLE.verdicts.credit as { composite: number }).composite;
  const printed = new Intl.NumberFormat(lang === "ro" ? "ro-RO" : "en-US", { maximumFractionDigits: 1 }).format(composite);
  // "…composite 69.6 of 100": the rule read the "6 of 100" after the decimal mark
  return /\b(?:of|din)\s+100$/.test(hit)
    && new RegExp(`(?<![\\d.,])${printed.replace(/[.,]/g, "\\$&")}\\s+(?:of|din)\\s+100\\b`).test(sentence);
}

describe.each(LANGS)("landing-proof · every text node of every public page (%s)", (lang) => {
  it("L12 no accuracy number is rendered outside the proof block unless a proof token supplied it", async () => {
    const fromTokens = tokenFilledSegments(lang);
    expect(fromTokens.size, "no token-bearing copy was found — the allowance is dead").toBeGreaterThan(8);
    const offenders: string[] = [];
    const read: Record<string, number> = {};
    let allowedByToken = 0;
    for (const page of PUBLIC_PAGES) {
      const root = await renderPublicPage(page, lang);
      // the regions exempted exist where they are named, so an exemption is
      // never a selector that matches nothing
      for (const region of EXEMPT_REGIONS[page]) {
        expect(root.querySelector(region.selector), `${page}: exempt region ${region.selector} is not on the page`).not.toBeNull();
      }
      if (page === "landing") {
        // the mock is exempt BECAUSE the page calls it illustrative
        expect(textOf(root)).toContain(plainText(landingStringsFor(lang).hero.mockNote).slice(0, 22));
      }
      const skip = EXEMPT_REGIONS[page].map((r) => r.selector).join(", ") || undefined;
      const nodes = textNodes(root, skip);
      read[page] = nodes.length;
      for (const node of nodes) {
        const text = page === "sample" ? sampleText(node.text) : node.text;
        const claims = accuracyClaims(text, { percentAnywhere: page !== "sample" });
        if (claims.length === 0) continue;
        if (fromTokens.has(node.text)) { allowedByToken += 1; continue; }
        for (const claim of claims) {
          if (page === "sample" && claim.rule === "n-of-m" && sampleScoreOf100(claim.hit, claim.sentence, lang)) continue;
          offenders.push(`/${page === "landing" ? "" : page} (${lang}) ${node.where}: ${claim.rule} "${claim.hit}" in "${claim.sentence.slice(0, 200)}"`);
        }
      }
      cleanup();
      __clearPricingConfigForTest();
    }
    expect(offenders, "a typed accuracy claim on a public page — every such number comes from engineProof.json").toEqual([]);
    // floors: a page that stops rendering, or a walker that stops walking, is not a pass
    for (const [page, floor] of [["landing", 150], ["pricing", 80], ["signup", 30], ["sample", 400], ["contact-sales", 20]] as const) {
      expect(read[page], `only ${read[page]} text node(s) read on /${page} (floor ${floor})`).toBeGreaterThanOrEqual(floor);
    }
    // the allowance is used: the FAQ's proof answer is on the landing
    expect(allowedByToken, "no rendered text matched a token-filled string").toBeGreaterThan(0);
    figuresChecked += Object.values(read).reduce((a, b) => a + b, 0);
  });
});

describe("landing-proof · the raw copy of every public page", () => {
  it("L12 no accuracy claim is typed into a string table, a dictionary or a plan bullet", () => {
    const lines: Array<[string, string, boolean]> = [];
    const push = (where: string, obj: unknown, percentAnywhere = true) => {
      const found: Array<[string, string]> = [];
      flat(obj, where, found);
      for (const [w, text] of found) lines.push([w, text, percentAnywhere]);
    };
    for (const lang of LANGS) {
      // the accuracy block is held to "no digit at all" by L5; its captions
      // print the proof's own "N of M" through tokens
      push(`landingStrings[${lang}]`, LANDING_STRINGS[lang]);
      push(`sampleStrings[${lang}]`, SAMPLE_STRINGS[lang], false);
      for (const key of planKeysWithFeatures()) {
        for (const b of planFeatureBulletsFor(key)) lines.push([`planFeatures.${key}[${lang}]`, bulletText(b, lang), true]);
      }
    }
    for (const [lang, dict] of [["en", enDict], ["ro", roDict]] as const) {
      const d = dict as unknown as Record<string, unknown>;
      for (const ns of ["pricing", "pricingX", "pricingFaq", "authX", "contactSales"]) {
        expect(d[ns], `${lang}.json has no ${ns} namespace`).toBeTruthy();
        push(`${lang}.json ${ns}`, d[ns]);
      }
    }
    const html = readFileSync(join(REPO, "index.html"), "utf8");
    lines.push(["index.html <title>", /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "", true]);
    for (const m of html.matchAll(/content\s*=\s*"([^"]*)"/g)) lines.push(["index.html meta", m[1], true]);
    for (const lang of LANGS) {
      lines.push([`META_DESCRIPTION.${lang}`, META_DESCRIPTION[lang], true]);
      lines.push([`META_TITLE.${lang}`, META_TITLE[lang], true]);
      lines.push([`META_IMAGE_ALT.${lang}`, META_IMAGE_ALT[lang], true]);
    }
    expect(lines.length, "the harvest is empty").toBeGreaterThan(1200);
    for (const prefix of ["landingStrings[en]", "landingStrings[ro]", "sampleStrings[en]", "sampleStrings[ro]",
      "en.json pricing", "ro.json pricing", "en.json pricingX", "ro.json pricingFaq", "en.json authX",
      "ro.json contactSales", "planFeatures."]) {
      expect(lines.some(([w]) => w.startsWith(prefix)), `nothing harvested from ${prefix}`).toBe(true);
    }
    const offenders: string[] = [];
    for (const [where, text, percentAnywhere] of lines) {
      // the hero's illustrative mock is exempt as a region (L12, rendered)
      if (/^landingStrings\[\w+\]\.hero\.mock\./.test(where)) continue;
      // tokens and placeholders are filled by code: what is TYPED is the rest
      const placeholderFree = plainText(text).replace(/\{\{[^}]*\}\}|\{[^}]*\}/g, " ");
      const typed = where.startsWith("sampleStrings[") ? sampleText(placeholderFree) : placeholderFree;
      for (const claim of accuracyClaims(typed, { percentAnywhere })) {
        offenders.push(`${where}: ${claim.rule} "${claim.hit}" in "${claim.sentence.slice(0, 200)}"`);
      }
    }
    expect(offenders, "an accuracy claim typed into the copy — its numbers must be proof tokens").toEqual([]);
    figuresChecked += lines.length;
  });

  it("L12 the detector: the sentences a verifier typed are claims; the copy's own sentences are not", () => {
    const red: Array<[string, boolean]> = [
      ["Verified on 9 of 9 real books — every balance sheet reconciles within 0.1%.", true],
      ["Checked on our test set; all nine real books are byte-identical.", true],
      ["We tested 20 real company books and every one matched.", true],
      ["Tested on 40 real company books, all correct.", true],
      ["Correct on 100% of the books we tested.", true],
      ["Reconciled to your source to ≤1% drift on all 9 of 9 calibration books", true],
      ["99.9% accurate on 9 of 9 calibration books", true],
      ["A sample that is accurate on 12 of 12 real books, within 0.1% drift", false],
      ["Testat pe 40 de balanțe reale, toate corecte.", true],
      ["Toate cele nouă balanțe sunt identice octet cu octet.", true],
      ["Verificat pe 9 din 9 balanțe.", true],
      ["Ninety-nine percent of uploads reconcile.", true],
      ["9/9 fixtures pass", true],
    ];
    const green: Array<[string, boolean]> = [
      ["We do not publish an accuracy percentage.", true],
      ["Net income must equal account 121.", true],
      ["Availability not verified since 29 Sept 2026.", true],
      ["Disponibilitate neverificată din 29 sept. 2026.", true],
      ["3 balanțe de verificare / lună", true],
      ["15 trial balances / month", true],
      ["Ask CFO AI: 10 chats / day, 50 / month — availability not verified since 29 Sept 2026", true],
      ["Fișierul tău este verificat de fiecare dată pe propriile lui cifre: debitele din sursă trebuie să fie egale cu creditele, bilanțul trebuie să se închidă, iar rezultatul net trebuie să fie egal cu contul 121.", true],
      ["The result rebuilt from classes 6 and 7 is printed beside it, with any gap.", true],
      ["Gross margin 31.4% in FY2025.", false],
      ["The trade-register number J99/9999/2099 does not exist.", false],
    ];
    for (const [text, percentAnywhere] of red) {
      expect(accuracyClaims(text, { percentAnywhere }).length, `should be RED: ${text}`).toBeGreaterThan(0);
    }
    for (const [text, percentAnywhere] of green) {
      expect(accuracyClaims(text, { percentAnywhere }), `should be green: ${text}`).toEqual([]);
    }
    figuresChecked += red.length + green.length;
  });
});
