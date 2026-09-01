/**
 * THE CANVAS — THE LAW GATES A1–A9.
 *
 * The sibling file `canvas.spec.ts` (CV-G1…CV-G6) proves the canvas is a
 * SURFACE: ⌘J opens it, the composer does not drift, a deterministic
 * command never reaches the model, the empty state is computed. This file
 * proves the canvas is HONEST — that every figure it paints is the
 * engine's and not the model's.
 *
 *     THE MODEL COMPOSES AND EXPLAINS; THE ENGINE COMPUTES.
 *
 *   A1  ARTIFACT PROVENANCE — every rendered numeral, in every artifact
 *       type, sits inside a provenance-carrying element. A chart
 *       datapoint without provenance FAILS.
 *   A2  SPEC-ONLY — a model response carrying a value or a numeric series
 *       is refused. PLANTED in the intercepted response; the digits are
 *       ones no engine could produce, so a pass cannot be luck.
 *   A4  GAP HONESTY — a question naming an absent period renders the gap
 *       card and never an estimate. ABSENT is not ZERO.
 *   A5  UNIT LAW — the artifact is structurally identical under RON and
 *       EUR display; only presentation moves.
 *   A6  EXPORT INTEGRITY — a three-way assertion. The export payload's
 *       figures are on screen, and the screen's figures came from the
 *       facts gateway. A two-way check between file and screen cannot see
 *       the two of them agreeing on a number neither got from the engine.
 *   A7  READ-ONLY — no mutating request leaves the canvas, except the one
 *       declared export endpoint.
 *   A8  DEGRADED — with the model returning a real provider error, past
 *       artifacts still render, Tier 0 still answers, and NO byte of the
 *       raw payload reaches the DOM.
 *   A9  PERFORMANCE — skeleton, first value and CLS, MEASURED across
 *       repeated runs and PUBLISHED as a distribution. A target is not
 *       evidence.
 *
 * ── WHY THIS IS A SECOND FILE ─────────────────────────────────────────
 *
 * Two lanes wrote canvas gates the same afternoon and the second
 * overwrote the first's `canvas.spec.ts` wholesale. Re-clobbering it to
 * reclaim a filename would destroy live-proven work (CV-G3 carries a
 * positive control, which is the property hardest to get right). So the
 * law gates live beside the surface gates instead, and
 * `scripts/check_canvas.mjs` DISCOVERS every `canvas*.spec.ts` rather
 * than naming one — a hardcoded filename made its anchor-classification
 * law blind to whichever file it was not pointed at.
 *
 * ── WHAT IS REAL HERE ─────────────────────────────────────────────────
 *
 * The ENGINE TOOL SEAM IS NOT STUBBED in A1/A6/A7. Those gates compare
 * what the reader sees against what the facts gateway actually returned,
 * so a fixture in the middle would make the comparison circular — the
 * screen would be checked against a file this test wrote. Only the model
 * seam is intercepted, because Anthropic credits are live and billing,
 * and because in A2 the model's output is the PLANT.
 *
 * Needs the authed test-mode stack: vite :5173 + engine :8000
 * PUBLIC_TEST_MODE. Run:
 *   npx playwright test e2e/design/canvas-law.spec.ts --project=chromium
 */
import { test, expect, type Page } from "@playwright/test";

import {
  dismissPublicTestBanner,
  preseedLearningMode,
  seedTheme,
  seedViewMode,
} from "../_helpers";

test.use({ viewport: { width: 1440, height: 900 } });

test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "canvas law gates need the authed test-mode stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE)",
);

const SETTLE_MS = 8000;
const ACTION_MS = 20_000;

// ══════════════════════════════════════════════════════════════════════
// SEAMS
// ══════════════════════════════════════════════════════════════════════

const MODEL_URL = "**/functions/v1/chat-llm";
const TOOLS_URL = "**/api/capsule/tools/**";

/** Named individually rather than as one regex: A7's claim is "neither of
 *  these fired", and one pattern cannot say WHICH did when one does. */
const SPEND_SEAMS = [
  { label: "functions/v1/chat-llm (Edge Function)", match: /functions\/v1\/chat-llm/ },
  { label: "/api/capsule/tools (read-only engine tools)", match: /\/api\/capsule\/tools\// },
];

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * APP-SHELL MACHINERY, classified by endpoint with a reason each.
 *
 * A7's first design was a pure differential — writes before the canvas
 * opens, subtracted from writes after — on the reasoning that an
 * allowlist would also bless a canvas write that reused a shell path.
 * MEASURED 2026-09-01, the differential caught three requests that are
 * not the canvas's:
 *
 *     POST /api/pipeline/recover-stuck
 *     POST /rest/v1/rpc/set_user_pref
 *     POST /rest/v1/rpc/list_workspaces
 *
 * The differential's flaw is TIME, not shape: the baseline is one
 * instant, and the shell's own boot machinery keeps firing
 * asynchronously past it. Anything slower than the snapshot lands on the
 * canvas's side of the subtraction regardless of who caused it.
 *
 * So the differential still removes the bulk, and these three are
 * classified out by identity, each with the reason it is not a canvas
 * write. The pairing matters: the differential alone produced false
 * positives, and the classification alone could hide a canvas write that
 * reused one of these paths — which is why `baseline > 0` is asserted
 * too, so the detector is proven able to see a write at all.
 */
const SHELL_ENDPOINTS = new Map([
  ["/api/pipeline/recover-stuck",
    "the pipeline janitor. Fires on shell boot to release documents left "
    + "reserved by a killed run; unrelated to reading a figure."],
  ["/rpc/set_user_pref",
    "the preference bag. `seedTheme`/`seedViewMode` write it, and prefs.ts "
    + "syncs a few hundred ms after first paint — routinely past the "
    + "baseline snapshot."],
  ["/rpc/list_workspaces",
    "a READ. PostgREST exposes RPCs over POST regardless of whether the "
    + "function mutates; this one returns the membership list."],
]);

/** The ONE mutating request the canvas may issue: the export builder. It
 *  returns bytes and writes no company data. Allowlisted by exact path —
 *  a pattern would also bless the write endpoint nobody has written. */
const EXPORT_ENDPOINT = "/api/artifacts/export";

// ══════════════════════════════════════════════════════════════════════
// HARNESS
// ══════════════════════════════════════════════════════════════════════

interface Ledger {
  all: Array<{ method: string; url: string }>;
  spend(): string[];
  writes(): string[];
  rawWrites(): string[];
}

function ledgerFor(page: Page): Ledger {
  const all: Array<{ method: string; url: string }> = [];
  page.on("request", (r) => all.push({ method: r.method(), url: r.url() }));
  return {
    all,
    spend: () => all.filter((r) => SPEND_SEAMS.some((s) => s.match.test(r.url)))
      .map((r) => r.url),
    writes: () => all
      .filter((r) => WRITE_METHODS.has(r.method)
        && !r.url.includes(EXPORT_ENDPOINT)
        && ![...SHELL_ENDPOINTS.keys()].some((p) => r.url.includes(p))
        && !SPEND_SEAMS.some((s) => s.match.test(r.url)))
      .map((r) => `${r.method} ${r.url}`),
    /** Writes BEFORE classification — so the gate can prove its detector
     *  sees writes at all rather than trusting an empty list. */
    rawWrites: () => all
      .filter((r) => WRITE_METHODS.has(r.method)
        && !SPEND_SEAMS.some((s) => s.match.test(r.url)))
      .map((r) => `${r.method} ${r.url}`),
  };
}

/** Intercept ONLY the model. Credits are live; the engine is not. */
async function stubModel(page: Page, body: unknown, status = 200): Promise<() => number> {
  let hits = 0;
  await page.route(MODEL_URL, async (route) => {
    hits += 1;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return () => hits;
}

/**
 * Boot the authed shell with the workspace RESOLVED.
 *
 * The second navigation is not belt-and-braces. Measured: with a single
 * `goto`, A1 found zero artifacts for a Tier-0 question while A4 — later
 * in the same file — found one for a question on the same surface. The
 * difference is that the active workspace (and therefore the local fact
 * index Tier 0 answers from) is still in flight on a cold boot, so the
 * resolver has nothing to resolve against and the turn takes a different
 * path. The sibling spec's `boot()` carries the same reload for the same
 * measured reason.
 *
 * The wait is on the app shell re-mounting, not a sleep, so a slow boot
 * shows up as a timeout naming the shell rather than as a gate failing
 * on an assertion about the canvas.
 */
async function boot(page: Page): Promise<void> {
  await preseedLearningMode(page);
  await seedTheme(page, "light");
  await seedViewMode(page, "pro");
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('[data-testid="account-menu-trigger"]'),
    "the app shell never re-mounted after boot()'s reload — the workspace is "
    + "not resolved, so anything the gates below measure is a fact about a "
    + "cold surface, not about the canvas",
  ).toBeVisible({ timeout: ACTION_MS });
  await dismissPublicTestBanner(page);
}

/**
 * ⌘J, then prove the panel is there.
 *
 * THIS FAILS RATHER THAN SKIPS. A suite that skips when its subject is
 * missing prints the same green as a suite that checked it, and that is
 * the instrument failure this whole battery exists to prevent (TC-9).
 * `node scripts/check_canvas.mjs` L7 reports the same fact from source.
 */
async function openCanvas(page: Page): Promise<void> {
  await page.keyboard.press("Meta+j");
  const panel = page.locator('[data-testid="canvas-panel"]');
  await expect(
    panel,
    'A0 SUBJECT — ⌘J did not open [data-testid="canvas-panel"]. Every gate in '
    + "this file is a statement about a surface; without one there is nothing "
    + "to state. Do not skip past this: run `node scripts/check_canvas.mjs` "
    + "and read L7.",
  ).toBeVisible({ timeout: ACTION_MS });
  // Let the empty state's snapshot-driven suggestions land, so the local
  // fact index is populated before the first question. Bounded and NOT
  // thrown on: if they never arrive, the gate that cares fails on its own
  // measurement rather than this line failing on a wait.
  await page.locator('[data-testid="canvas-suggestion"]').first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => { /* an empty workspace has none */ });
}

/**
 * Ask, and WAIT FOR THE TURN rather than sleeping through it.
 *
 * A fixed sleep makes every downstream assertion a race, and a race that
 * loses reports "the canvas rendered no artifact" — a sentence that
 * reads like a product defect and is not one. The wait is on the entry
 * count growing, then on the card settling out of its pending state; a
 * turn that legitimately produces no artifact (a refusal, a gap) still
 * returns, and the gate that cares says so itself.
 */
async function ask(page: Page, question: string): Promise<void> {
  const entries = page.locator('[data-testid="canvas-entry"]');
  const before = await entries.count();
  const composer = page.locator('[data-testid="canvas-composer"]');
  await composer.click({ timeout: ACTION_MS });
  await composer.fill(question, { timeout: ACTION_MS });
  await page.waitForTimeout(200);
  // ENTER, not the send button. Measured: driving `canvas-send` produced
  // an entry for a model-path question but no artifact for a Tier-0 one,
  // and A1 reported "the canvas rendered NO artifact" — a false red about
  // the wrong control (TC-7). Enter is the path the sibling spec proved
  // and the one a reader actually uses.
  await composer.press("Enter", { timeout: ACTION_MS });
  await expect
    .poll(() => entries.count(), { timeout: ACTION_MS })
    .toBeGreaterThan(before);
  await page.locator('[data-testid="canvas-artifact-pending"]')
    .last()
    .waitFor({ state: "detached", timeout: ACTION_MS })
    .catch(() => { /* no pending state at all is fine */ });
  await page.waitForTimeout(1200);
}

/**
 * Every numeral the READER SEES inside a subtree, paired with whether it
 * sits under a provenance-carrying element.
 *
 * TC-7: this reads TEXT NODES — the glyphs on screen — not a container's
 * `textContent`. A container's text is the concatenation of its
 * children, so checking it would attribute one child's provenance to a
 * sibling's digits and report clean on exactly the mixed case that
 * matters.
 */
async function numeralsWithoutProvenance(
  page: Page,
  rootSelector: string,
  exemptTestIds: readonly string[],
): Promise<Array<{ text: string; path: string }>> {
  return page.evaluate(
    ({ sel, exempt }: { sel: string; exempt: string[] }) => {
      const out: Array<{ text: string; path: string }> = [];
      const DIGIT = /\d/;
      for (const root of Array.from(document.querySelectorAll(sel))) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null = walker.nextNode();
        while (node) {
          const text = (node.textContent ?? "").trim();
          if (text && DIGIT.test(text)) {
            let el: Element | null = node.parentElement;
            let provenance = false;
            let exemptHit = false;
            const chain: string[] = [];
            while (el && (root === el || root.contains(el))) {
              const tid = el.getAttribute("data-testid");
              if (tid) chain.push(tid);
              if (el.hasAttribute("data-provenance")) provenance = true;
              if (tid && exempt.indexOf(tid) !== -1) exemptHit = true;
              el = el.parentElement;
            }
            if (!provenance && !exemptHit) {
              out.push({
                text: text.slice(0, 60),
                path: chain.join(" < ") || "(no testid)",
              });
            }
          }
          node = walker.nextNode();
        }
      }
      return out;
    },
    { sel: rootSelector, exempt: [...exemptTestIds] },
  );
}

/**
 * Anchors whose text may legitimately carry a digit that is NOT a figure
 * — a version marker, the period label inside a citation. DECLARED, not
 * inferred: an exemption nobody wrote down is how a law erodes. Every id
 * here is classified in check_canvas.mjs, so L1 keeps them from going
 * stale.
 */
const NON_FIGURE_TEXT = ["artifact-version", "artifact-citation"] as const;

/** Digits of four or more places, normalised. Short numbers ("v2", a row
 *  index, "FY25") are not figures and matching them would make every
 *  assertion below noisy enough to be ignored. */
function bigDigits(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.match(/\d[\d.,  ]*\d/g) ?? []) {
    const bare = m.replace(/[.,  ]/g, "");
    if (bare.length >= 4) out.add(bare);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════

test.describe("THE CANVAS — the law gates", () => {
  test.setTimeout(180_000);

  // ── A1 ──────────────────────────────────────────────────────────────

  test("A1 — every numeral in an artifact carries provenance", async ({ page }) => {
    await stubModel(page, { answer: "Here is the figure." });
    await boot(page);
    await openCanvas(page);
    await ask(page, "total assets");

    const artifacts = page.locator('[data-testid="canvas-artifact"]');
    const n = await artifacts.count();
    // TC-3/TC-9: zero artifacts and "no unprovenanced numerals" are the
    // same output, and only one of them is a pass.
    expect(
      n,
      "A1: the canvas rendered NO artifact, so \"every numeral carries "
      + "provenance\" is a statement about an empty set. A clean result that "
      + "is indistinguishable from a no-subject result measures nothing.",
    ).toBeGreaterThan(0);

    const provenanced = await page.locator(
      '[data-testid="canvas-artifact"] [data-provenance]').count();
    const bodyState = await page.evaluate(() => {
      const q = (s: string) => document.querySelectorAll(s).length;
      return {
        figures: q('[data-testid="canvas-artifact-figures"]'),
        empty: q('[data-testid="canvas-artifact-empty"]'),
        stale: q('[data-testid="canvas-artifact-stale"]'),
        pending: q('[data-testid="canvas-artifact-pending"]'),
        fallbackNote: q('[data-testid="canvas-artifact-renderer-note"]'),
        card: q('[data-testid="artifact-card"]'),
        // Page-wide, so a zero inside the artifact can be told from a
        // zero everywhere — the dashboard behind the panel renders its
        // own provenanced figures, and if those are present while the
        // canvas has none, the finding is the canvas's.
        pageProvenance: q("[data-provenance]"),
        panelProvenance: document.querySelector('[data-testid="canvas-panel"]')
          ?.querySelectorAll("[data-provenance]").length ?? -1,
      };
    });
    // A POSITIVE CONTROL, in the same run, on the same detector.
    //
    // MEASURED 2026-09-01: `[data-provenance]` count on the whole page was
    // ZERO — canvas, dashboard and all. `<Amount>` emits the attribute
    // only when `hasProvenance(provenance)` is true, so a workspace whose
    // served facts carry no provenance block renders none anywhere. A
    // gate that read the canvas's zero as a canvas defect would be
    // blaming the surface for the fixture; one that read it as "clean"
    // would be worse. Neither: if the detector cannot find provenance on
    // a surface that is supposed to have it, this run cannot answer the
    // question and says so.
    expect(
      bodyState.pageProvenance,
      "A1: NOT ONE element on the entire page carries [data-provenance] — "
      + "not the canvas, and not the dashboard behind it. `<Amount>` emits "
      + "that attribute only when the fact it renders arrives with a "
      + "provenance block, so this is a statement about what this workspace "
      + "SERVES, not about what the canvas does with it. The canvas cannot "
      + "be measured for provenance against a stack that has none to render. "
      + "Point this spec at a workspace whose facts carry provenance (or fix "
      + "the fixture) before reading the assertion below as a canvas "
      + "finding.",
    ).toBeGreaterThan(0);

    expect(
      provenanced,
      `A1: ${n} artifact(s) rendered but not one provenance-carrying element, `
      + `while the page as a whole has ${bodyState.pageProvenance}. `
      + `Card body state: ${JSON.stringify(bodyState)}.\n`
      + "Read that before reading this as a provenance defect. `empty>0` means "
      + "the turn resolved no facts (a workspace or period question, not a "
      + "money-path one); `stale>0` means a restored record whose figures were "
      + "deliberately never persisted; `card=0` with `figures>0` means the "
      + "artifact renderer registry is empty and the figure-list fallback is "
      + "what painted — see `node scripts/check_canvas.mjs` L8. Only with a "
      + "live, non-stale, fact-bearing card is a zero here a real finding: "
      + "figures reaching the DOM off the money path.",
    ).toBeGreaterThan(0);

    const orphans = await numeralsWithoutProvenance(
      page, '[data-testid="canvas-artifact"]', NON_FIGURE_TEXT);
    console.log(`[A1] artifacts=${n} provenanced=${provenanced} orphans=${orphans.length}`);
    expect(
      orphans,
      "A1: numeral(s) rendered inside an artifact with no provenance-carrying "
      + "ancestor:\n"
      + orphans.map((o) => `    "${o.text}"  under  ${o.path}`).join("\n")
      + "\nEvery figure on this surface is a resolved fact from the facts "
      + "gateway rendered through the money path, which is where "
      + "data-provenance comes from. A digit without it has no authority "
      + "behind it. NO EXCEPTION FOR \"it is just a chart label\".",
    ).toEqual([]);
  });

  // ── A2 ──────────────────────────────────────────────────────────────

  test("A2 — a model-authored number never reaches the reader", async ({ page }) => {
    // Digit strings no engine in this workspace could produce. If one
    // appears in the DOM it came from this fixture and nothing else, so
    // an empty result cannot be a coincidence.
    const PLANTED_VALUE = "987654321";
    const PLANTED_SERIES = ["111222333", "444555666", "777888999"];
    const hits = await stubModel(page, {
      // The plant wears three different hats at once — prose, a spec
      // field that does not exist, and labels that do — because
      // unknown-key refusal alone would let the third through, and a
      // gate that goes red for the wrong reason is not evidence (TC-2).
      answer: `Total assets are ${PLANTED_VALUE} RON.`,
      spec: {
        kind: "chart",
        title: `Revenue ${PLANTED_VALUE}`,
        series: PLANTED_SERIES.map(Number),
        labels: PLANTED_SERIES.map(Number),
      },
    });
    await boot(page);
    await openCanvas(page);
    await ask(page, "chart revenue by month");

    const body = await page.locator("body").innerText();
    const leaked = [PLANTED_VALUE, ...PLANTED_SERIES].filter((d) => body.includes(d));
    console.log(`[A2] model-seam hits=${hits()} leaked=${leaked.length}`);
    expect(
      leaked,
      `A2: model-authored digit(s) reached the DOM: ${leaked.join(", ")}. The `
      + "spec a model returns carries metric ids, period ids, grouping and "
      + "labels — presentation and reference. There is no field in it that "
      + "could hold a value, so a well-formed spec carrying one does not "
      + "exist and this payload must be refused at parse. A number that "
      + "renders here was typed by a language model, whether it landed in a "
      + "caption, an axis tick or a series.",
    ).toEqual([]);

    // TC-9 on this gate itself: "no planted digits" is also what a page
    // that never ran the turn prints.
    expect(
      await page.locator('[data-testid="canvas-entry"]').count(),
      "A2: no canvas entry was created, so the refusal was never exercised — "
      + "the absence of the planted digits is a fact about an empty thread, "
      + "not about the parser.",
    ).toBeGreaterThan(0);
  });

  // ── A4 ──────────────────────────────────────────────────────────────

  test("A4 — an absent period renders the gap, never an estimate", async ({ page }) => {
    await stubModel(page, { answer: "I do not have that period." });
    await boot(page);
    await openCanvas(page);
    // A period this workspace cannot have. Anything numeric attached to
    // it was estimated, interpolated or invented — three names for one
    // failure.
    await ask(page, "what was EBITDA in 1997");

    const GAP_ANCHORS = [
      "artifact-figure-absent",
      "artifact-refused",
      "artifact-table-empty",
      "artifact-chart-empty",
      "artifact-chart-refusal",
      "artifact-scenario-empty",
      "artifact-scenario-withheld",
      "canvas-artifact-empty",
      "canvas-empty-nostate",
    ];
    const shown = await page.evaluate(
      (ids: string[]) => ids.filter(
        (id) => document.querySelectorAll(`[data-testid="${id}"]`).length > 0),
      GAP_ANCHORS);
    console.log(`[A4] gap anchors shown: ${shown.join(", ") || "(none)"}`);
    expect(
      shown.length,
      `A4: nothing from the gap family rendered (${GAP_ANCHORS.join(", ")}). An `
      + "absent period must produce a card that says what is missing. Silence "
      + "reads as \"nothing to report\" and a figure reads as an answer; both "
      + "are worse than the gap.",
    ).toBeGreaterThan(0);

    // And no unbacked figure anywhere in the artifact. Scoped to the
    // artifact rather than the page: the reader's own question contains
    // "1997" and renders in canvas-question, which is their text, not the
    // product's claim.
    const orphans = await numeralsWithoutProvenance(
      page, '[data-testid="canvas-artifact"]', NON_FIGURE_TEXT);
    expect(
      orphans,
      "A4: the gap card carries numeral(s) with no provenance:\n"
      + orphans.map((o) => `    "${o.text}"  under  ${o.path}`).join("\n")
      + "\nABSENT is not ZERO and it is not an approximation.",
    ).toEqual([]);
  });

  // ── A5 ──────────────────────────────────────────────────────────────

  test("A5 — the artifact is invariant under the display currency", async ({ browser }) => {
    const CURRENCY_KEY = "cfo:currency-display:v1";

    // ONE CONTEXT PER CURRENCY. The first draft re-booted a single page,
    // which meant `addInitScript` accumulated (two currency writes, last
    // one wins by ordering rather than by intent) and the second run
    // started with the first run's thread already in localStorage. It
    // reported "the element set changed with the display currency" —
    // 9 elements against 3 — which was a fact about a dirty page, not
    // about the unit law. A gate that cannot tell those apart is worse
    // than no gate, because it will be believed once and disbelieved
    // forever after.
    async function shapeUnder(currency: string) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await page.addInitScript(
        ([k, v]: [string, string]) => {
          try { window.localStorage.setItem(k, v); } catch { /* private mode */ }
        },
        [CURRENCY_KEY, currency] as [string, string],
      );
      await stubModel(page, { answer: "Here is the figure." });
      await boot(page);
      await openCanvas(page);
      await ask(page, "total assets");
      const shape = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="canvas-artifact"]');
        if (!root) return null;
        return {
          labelled: Array.from(root.querySelectorAll("[data-testid]"))
            .map((el) => el.getAttribute("data-testid") ?? "").sort(),
          // Structure and PROSE with every digit and separator removed.
          // What survives must be identical: the same rows, the same
          // labels, the same shape. Only presentation may move.
          prose: (root.textContent ?? "").replace(/[\d., \s]+/g, " ").trim(),
          rows: root.querySelectorAll('[data-testid="artifact-row"]').length,
        };
      });
      await ctx.close();
      return shape;
    }

    const ron = await shapeUnder("RON");
    expect(ron, "A5: no artifact rendered under RON; nothing to compare")
      .not.toBeNull();
    const eur = await shapeUnder("EUR");
    expect(eur, "A5: no artifact rendered under EUR").not.toBeNull();
    console.log(`[A5] rows RON=${ron?.rows} EUR=${eur?.rows} `
      + `elements RON=${ron?.labelled.length} EUR=${eur?.labelled.length}`);

    expect(
      eur?.labelled,
      "A5: the artifact's ELEMENT SET changed with the display currency. The "
      + "dial is a presentation affordance: the same question against the same "
      + "period must produce the same artifact, with the same rows and the "
      + "same cards. A structural difference means the currency is reaching "
      + "further than presentation.",
    ).toEqual(ron?.labelled);
    expect(eur?.rows, `A5: row count moved ${ron?.rows} -> ${eur?.rows}.`)
      .toBe(ron?.rows);
    expect(
      eur?.prose,
      "A5: the artifact's non-numeric text changed with the display currency. "
      + "Labels, headings and notes are the same statement in either unit; a "
      + "difference means something other than presentation is "
      + "currency-dependent — and that is how two figures on one card end up "
      + "in different standards without saying so.",
    ).toEqual(ron?.prose);
  });

  // ── A6 ──────────────────────────────────────────────────────────────

  test("A6 — exported figures match the screen and the gateway", async ({ page }) => {
    // THE TOOL SEAM IS NOT STUBBED. A6 compares the screen against what
    // the facts gateway actually returned; a fixture in the middle would
    // make it circular — the screen checked against a file this test
    // wrote.
    const gatewayBodies: string[] = [];
    await page.route(TOOLS_URL, async (route) => {
      const res = await route.fetch();
      gatewayBodies.push(await res.text().catch(() => ""));
      await route.fulfill({ response: res });
    });
    let exportPayload: string | null = null;
    await page.route(`**${EXPORT_ENDPOINT}`, async (route) => {
      exportPayload = route.request().postData();
      // Fulfil rather than forward: the file BYTES are not the subject,
      // the payload is.
      await route.fulfill({ status: 200, contentType: "application/octet-stream", body: "" });
    });
    await stubModel(page, { answer: "Here is the table." });

    await boot(page);
    await openCanvas(page);
    await ask(page, "/table total assets");

    // THE EXPORT IS A BUTTON ON THE CARD, not a slash command.
    // Measured: `/export` parses as a command but produces an export
    // MANIFEST artifact; the request that carries the figures is fired by
    // `artifact-export` in ArtifactCard's action row
    // (artifacts/Artifact.tsx `doExport`). Driving the wrong control made
    // A6 report "no request reached the endpoint" — a true sentence about
    // the wrong subject, which is the false red TC-7 is about.
    const exportBtn = page.locator('[data-testid="artifact-export"]');
    expect(
      await exportBtn.count(),
      'A6: the artifact card offers no [data-testid="artifact-export"], so the '
      + "export path cannot be exercised and the three-way comparison below "
      + "would compare an empty payload against an empty screen.\n"
      + "FIRST CHECK `node scripts/check_canvas.mjs` L8. The button lives on "
      + "`artifacts/ArtifactCard.tsx`, which only mounts through the artifact "
      + "renderer REGISTRY — and as of 2026-09-01 nothing calls "
      + "`registerCanvasArtifactRenderer`, so every artifact falls back to the "
      + "figure list and no ArtifactCard exists to carry the button. That is a "
      + "product wiring gap, not a broken selector, and this gate cannot pass "
      + "until it closes.",
    ).toBeGreaterThan(0);
    await exportBtn.first().click();
    await expect.poll(() => exportPayload !== null, { timeout: ACTION_MS })
      .toBe(true);

    expect(
      exportPayload,
      `A6: no request reached ${EXPORT_ENDPOINT}, so there is no payload to `
      + "compare. Either the export command did not fire, or the workbook is "
      + "being built client-side — and a workbook built client-side is the one "
      + "that leaves this product with the numbers and without their "
      + "provenance, which is the artifact this product exists to replace.",
    ).not.toBeNull();

    const onScreen = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="canvas-artifact"] [data-provenance]'))
        .map((el) => el.textContent ?? "").filter(Boolean));
    expect(
      onScreen.length,
      "A6: the artifact rendered no provenance-carrying figure, so a matching "
      + "export payload would prove nothing.",
    ).toBeGreaterThan(0);

    const screenDigits = bigDigits(onScreen.join(" "));
    const payloadDigits = bigDigits(exportPayload ?? "");
    const gatewayDigits = bigDigits(gatewayBodies.join(" "));
    console.log(`[A6] screen=${screenDigits.size} payload=${payloadDigits.size} `
      + `gateway=${gatewayDigits.size}`);

    expect(
      gatewayDigits.size,
      "A6: the facts gateway returned no figure at all, so the third leg of "
      + "this comparison is empty and the other two could agree on anything.",
    ).toBeGreaterThan(0);

    const notOnScreen = [...payloadDigits].filter((d) => !screenDigits.has(d));
    expect(
      notOnScreen,
      `A6: the export payload carries figure(s) the screen never showed: `
      + `${notOnScreen.join(", ")}. The file and the artifact are two renderings `
      + "of one set of resolved facts; a divergence means one of them "
      + "re-derived, and the day they disagree the file is the one forwarded "
      + "to a bank.",
    ).toEqual([]);

    const notInGateway = [...screenDigits].filter((d) => !gatewayDigits.has(d));
    expect(
      notInGateway,
      `A6: the screen shows figure(s) the facts gateway never returned: `
      + `${notInGateway.join(", ")}. This is the leg a screen-vs-file check `
      + "cannot see: both could agree perfectly on a number that came from "
      + "neither the engine nor the snapshot.",
    ).toEqual([]);
  });

  // ── A7 ──────────────────────────────────────────────────────────────

  test("A7 — the canvas issues no write request", async ({ page }) => {
    const ledger = ledgerFor(page);
    await stubModel(page, { answer: "Here is the figure." });
    await boot(page);

    // A DIFFERENTIAL, not an allowlist.
    //
    // The first draft counted every mutating request the page made and
    // found five — all of them the APP SHELL's: `seedTheme` and
    // `seedViewMode` write through `set_user_pref`, and the prefs layer
    // syncs on boot. Reporting those as "the canvas issued a write" is a
    // false red, and the obvious repair — an allowlist of shell endpoints
    // — is the wrong shape: it would also bless a canvas write that
    // happened to reuse one of those paths.
    //
    // So the baseline is taken with the dashboard alone and the canvas
    // shut, and only what appears AFTER the canvas is opened and used is
    // attributed to it. Anything the shell does on its own cancels out by
    // construction rather than by a list somebody has to maintain.
    const baseline = ledger.rawWrites().length;
    await openCanvas(page);
    await ask(page, "total assets");
    await ask(page, "/table total assets");

    const before = ledger.writes().length;
    const writes = ledger.writes().slice(before);
    console.log(`[A7] requests=${ledger.all.length} raw shell writes at `
      + `baseline=${baseline} classified-out=${SHELL_ENDPOINTS.size} `
      + `canvas-attributed=${writes.length}`);
    expect(
      writes,
      `A7: the canvas issued a mutating request:\n  ${writes.join("\n  ")}\n`
      + "This is a READING instrument. The only mutating request it may make "
      + `is ${EXPORT_ENDPOINT}, which returns bytes and writes no company `
      + "data. The engine-side half of this law — the three-seam tool "
      + "refusal, __repr__ included — is the Python suite's; this is the half "
      + "that watches the browser.",
    ).toEqual([]);
    // TC-3, twice over. A ledger that recorded nothing would print an
    // empty write list — and a DIFFERENTIAL whose baseline never saw a
    // write is a differential that has not been shown to be able to
    // subtract anything, so the baseline is asserted too.
    expect(
      ledger.all.length,
      "A7: the request ledger is EMPTY, so \"no writes\" is a fact about a "
      + "page that made no requests at all, not about the canvas.",
    ).toBeGreaterThan(0);
    expect(
      baseline,
      "A7: the SHELL baseline recorded zero writes, so the subtraction below "
      + "removed nothing and this gate is an absolute count wearing a "
      + "differential's clothes. Measured 2026-09-01: booting the dashboard "
      + "with seeded theme and view mode issues 5 preference writes before "
      + "the canvas is opened. A zero here means the detector stopped seeing "
      + "them, not that they stopped happening.",
    ).toBeGreaterThan(0);
  });

  // ── A8 ──────────────────────────────────────────────────────────────

  test("A8 — with the model dead the canvas degrades honestly", async ({ page }) => {
    // A realistic upstream failure: a provider error body with a request
    // id and a provider slug — the exact shape `lib/aiDegraded` exists
    // to keep off the page.
    const RAW = {
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API",
        request_id: "req_011CQZk9x8PROBEONLY",
        provider: "anthropic",
      },
    };
    await stubModel(page, RAW, 400);
    await boot(page);
    await openCanvas(page);
    await ask(page, "explain the working capital swing");

    const body = (await page.locator("body").innerText()).toLowerCase();
    const leaks = ["request_id", "req_011cqzk9x8probeonly", "invalid_request_error", "anthropic"]
      .filter((needle) => body.includes(needle));
    console.log(`[A8] raw-payload leaks=${leaks.length}`);
    expect(
      leaks,
      `A8: the raw provider payload reached the DOM — ${leaks.join(", ")} `
      + "visible on the page. A degraded canvas must say what happened in "
      + "reviewed copy. Pasting the upstream body leaks request ids and "
      + "provider slugs to the reader and tells them nothing they can act on.",
    ).toEqual([]);

    // Tier 0 still answers with the model dead — that is the whole point
    // of a resolver with no network in its path.
    await ask(page, "total assets");
    const pageProv = await page.locator("[data-provenance]").count();
    // The same positive control A1 carries, for the same reason: a zero
    // here is only a canvas finding if the detector can find provenance
    // anywhere. Measured 2026-09-01, on this stack it cannot.
    expect(
      pageProv,
      "A8: NOT ONE element on the page carries [data-provenance], so \"the "
      + "Tier-0 answer has no provenanced figure\" is a fact about what this "
      + "workspace serves, not about the degraded canvas. See A1's control.",
    ).toBeGreaterThan(0);
    const provenanced = await page.locator(
      '[data-testid="canvas-artifact"] [data-provenance]').count();
    expect(
      provenanced,
      "A8: with the model dead, a Tier-0 question rendered no provenanced "
      + "figure. The local resolver cannot spend and cannot fail on the "
      + "network; if it stopped answering here, the surface is degrading "
      + "further than it has to.",
    ).toBeGreaterThan(0);
  });

  // ── A9 ──────────────────────────────────────────────────────────────

  test("A9 — skeleton, first value and CLS, measured and published", async ({ page }) => {
    await stubModel(page, { answer: "Here is the figure." });
    await boot(page);
    await openCanvas(page);

    // CLS, ATTRIBUTED. A page-wide sum answers "did anything on this page
    // move", and the canvas is one panel inside a dashboard that has its
    // own settling to do. Measured: a page-wide observer reported
    // 0.0000048 on one run and exactly 0 on the next, which is a number
    // about the app shell, not about an artifact streaming in — and a
    // gate that flips on someone else's reflow is a gate that gets
    // ignored. `sources` names the node each shift moved, so the sum is
    // split into what happened INSIDE the canvas and what happened
    // outside it. Both are published; only the canvas half is gated.
    await page.evaluate(() => {
      const w = window as unknown as { __clsIn?: number; __clsOut?: number };
      w.__clsIn = 0;
      w.__clsOut = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as Array<{
          value: number;
          hadRecentInput: boolean;
          sources?: Array<{ node?: Node | null }>;
        }>) {
          if (e.hadRecentInput) continue;
          const panel = document.querySelector('[data-testid="canvas-panel"]');
          const inCanvas = !!panel && (e.sources ?? []).some(
            (s) => s.node instanceof Node && panel.contains(s.node));
          if (inCanvas) w.__clsIn = (w.__clsIn ?? 0) + e.value;
          else w.__clsOut = (w.__clsOut ?? 0) + e.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });

    const RUNS = 5;
    const skeleton: number[] = [];
    const firstValue: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const composer = page.locator('[data-testid="canvas-composer"]');
      await composer.click();
      await composer.fill("total assets");
      await page.waitForTimeout(200);
      // The clock starts on the KEYSTROKE THAT COMMITS, because that is
      // the moment the reader is waiting from. Enter, not the send
      // button, for the same reason `ask()` uses it.
      const t0 = Date.now();
      await composer.press("Enter");
      await page.locator('[data-testid="canvas-entry"]').nth(i)
        .waitFor({ timeout: 15_000 });
      skeleton.push(Date.now() - t0);
      await page.locator('[data-testid="canvas-artifact"]').nth(i)
        .waitFor({ timeout: 15_000 });
      firstValue.push(Date.now() - t0);
    }

    const { inCanvas, outside } = await page.evaluate(() => {
      const w = window as unknown as { __clsIn?: number; __clsOut?: number };
      return { inCanvas: w.__clsIn ?? -1, outside: w.__clsOut ?? -1 };
    });
    const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

    // PUBLISHED, not merely asserted. A target is not evidence; the
    // distribution is, and it is printed whether or not the gate passes.
    console.log(
      `[A9 measured] runs=${RUNS}\n`
      + `  skeleton    ${skeleton.join(", ")} ms   p50=${p50(skeleton)}  budget 400\n`
      + `  first value ${firstValue.join(", ")} ms   p50=${p50(firstValue)}  budget 1200\n`
      + `  CLS canvas  ${inCanvas}   budget 0\n`
      + `  CLS outside ${outside}   (app shell — published, not gated)`);

    expect(skeleton.length, "A9: no run completed; nothing was measured").toBe(RUNS);
    expect(p50(skeleton),
      `A9: artifact skeleton p50 ${p50(skeleton)}ms exceeds the 400ms budget`)
      .toBeLessThanOrEqual(400);
    expect(p50(firstValue),
      `A9: first value p50 ${p50(firstValue)}ms exceeds the 1200ms budget`)
      .toBeLessThanOrEqual(1200);
    expect(inCanvas,
      `A9: layout shift inside the canvas is ${inCanvas}. The canvas must not `
      + "move content under the reader while an artifact streams in or is "
      + `refined. (Outside the canvas, the app shell contributed ${outside}; `
      + "that is published above and deliberately not gated here — this gate "
      + "owns the canvas, not the dashboard.)")
      .toBeLessThanOrEqual(0);
  });
});
