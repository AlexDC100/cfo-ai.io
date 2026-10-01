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
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11)
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
//   · accuracy wording with no number in it ("highly accurate");
//   · the standalone storefront templates and e-mails (not frontend source).
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
import { META_DESCRIPTION } from "@/hooks/useHtmlLangSync";
import { foreignNumber } from "@/test/numberLanguage";
import { numbersIn, renderLanding, setLanguage, textOf, type SurfaceLang } from "@/test/publicSurfaces";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    isAuthenticated: false, displayName: null, initials: null, user: null,
    status: "signed_out", signOut: vi.fn(),
  }),
}));

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

afterEach(() => cleanup());
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
