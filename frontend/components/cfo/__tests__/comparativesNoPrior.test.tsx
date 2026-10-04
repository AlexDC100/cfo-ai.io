// A COMPARISON THAT IS ON SAYS WHAT IT COMPARES — OR THAT IT COMPARES NOTHING.
//
// INCIDENT (production, 2026-10-04). A company with two analysed year-ends,
// the EARLIER one on screen. "Compare with: Previous year (auto)" was
// selected, the Prior, Δ, Δ % and "% of revenue" boxes were ticked — and the
// P&L, the balance sheet and the cash flow each showed one column, with no
// word about why. Nothing was broken: no balance for the year before exists,
// AUTO resolved to no period (`pickDefaultPrior` → null), the page asked the
// engine for nothing, and the controls went on implying a comparison.
//
// LAW. Whenever the comparison is ON (the reader did not choose "No
// comparison") and no prior resolves:
//   · the picker's AUTO option names the balance it looked for, as missing —
//     unless a balance closing that month IS in the list at another length;
//   · a notice says, in the reader's language and month names, which balance
//     is missing and which period is therefore shown alone, and offers the
//     next step: where a balance is uploaded, and the company's EARLIER
//     periods (nearest first, at most three) one click away — never a later
//     one, which would read the change backwards;
//   · every COMPARISON column box (Prior, Δ, Δ %) is OFF (disabled,
//     unticked): no such column is on screen — and the share box with them
//     on a tab that has no share column of its own (cash flow, ratios);
//     AMENDED 2026-10-04 by gate single-year-share: on the P&L and the
//     balance sheet the share box stays the reader's own, because the share
//     of turnover / of total assets is the period's own figure and needs no
//     comparison (owner ruling: "'% din venituri' must work for a single
//     year without a comparison");
//   · AUTO never picks another period in its place, and the reader's stored
//     columns are not overwritten by the state;
//   · NO DOCUMENT OF ANOTHER PAIR IS ON SCREEN: stepping here from a period
//     that was compared leaves no comparison behind (the app's query client
//     keeps the previous result as a placeholder; the comparison does not).
// And whenever a prior DOES resolve and the engine serves the comparison: no
// notice, no disabled box.
//
// Fails on: the notice not rendered (the incident), a box left enabled or
// ticked with nothing compared, AUTO's label silent about the missing
// balance or calling an uploaded one missing, a later period offered in the
// notice, a missing Romanian or English sentence (a raw key on screen), an
// English month name in a Romanian sentence, the previous comparison's
// document served for a period it is not about, the page not handing the
// controls and the notice the prior it actually requests.
//
// What it cannot see: whether the engine's document, once a prior exists,
// fills the columns (comparatives.test.ts, plCompareSubtotals.test.tsx); the
// same-length rule itself (comparatives.test.ts owns it); a company with ONE
// period — no picker and no notice there, the share box alone on the P&L and
// the balance sheet (gate single-year-share owns it; the page used to render
// no controls at all); a comparison that WAS requested and was refused or
// failed, whose sentence is the outcome note's (single-year-share — the two
// per-tab copies of the refusal are gone); the page's own render condition
// around the controls (the wiring law below reads the source).
// Plant log: docs/engine_book/gates.md, "compare-no-prior" and "compare-no-prior
// — amended by single-year-share".
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";

import pairJson from "@/lib/__tests__/fixtures/comparatives/pair_served.json";

// ── A company, as the engine lists its periods (no real id, no real name) ──
const ORG = "0c0a0000-0000-4000-8000-00000000c0a1";
const P25 = "9e2d0000-0000-4000-8000-000000002025";
const P24 = "9e2d0000-0000-4000-8000-000000002024";
const P23 = "9e2d0000-0000-4000-8000-000000002023";

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok", user: { id: "u1" } } } }) },
  }),
  currentOrgId: async () => "0c0a0000-0000-4000-8000-00000000c0a1",
}));

const { ComparativesControls, ComparativesNoPriorNote, NO_PRIOR_ALTERNATIVES } = await import(
  "@/components/cfo/ComparativesPanel"
);
const { comparisonChoiceOf, comparisonHasNoPrior, noPriorStateOf, previousYearEnd, useComparatives } = await import(
  "@/lib/comparatives"
);
const { ComparativesViewProvider, useComparativesView, readComparativesView } = await import(
  "@/stores/comparativesView"
);
const { ratioSurfacesOf } = await import("@/lib/useRatioSurfaces");
const { queryClient: appQueryClient } = await import("@/lib/queryClient");

interface Row {
  id: string;
  start: string | null;
  end: string;
}
const year = (id: string, y: number): Row => ({ id, start: `${y}-01-01`, end: `${y}-12-31` });
/** A cumulative month of 2025, as a company uploading monthly holds them. */
const month = (m: number): Row => {
  const mm = String(m).padStart(2, "0");
  const last = new Date(Date.UTC(2025, m, 0)).getUTCDate();
  return { id: `9e2d0000-0000-4000-8000-0000002025${mm}`, start: "2025-01-01", end: `2025-${mm}-${last}` };
};

const companyOf = (rows: Row[]) => ({
  orgId: ORG,
  periods: rows.map((r) => ({
    period_id: r.id,
    period_label: r.end,
    period_start: r.start,
    period_end: r.end,
    documents: [{ id: `doc-${r.id}` }],
  })),
});

/** The incident's company: the year on screen and the year AFTER it. */
const TWO_YEARS = [year(P25, 2025), year(P24, 2024)];

/** The month label a reader of `lang` is shown — the app's one locale rule
 *  (lib/locale.ts), written out here so the expectation is not the
 *  component's own output. */
const monthLabel = (iso: string, lang: "en" | "ro"): string =>
  new Date(iso).toLocaleDateString(lang === "ro" ? "ro-RO" : "en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

let statesChecked = 0;
let lastChoice: ReturnType<typeof comparisonChoiceOf> | null = null;

/** What the dashboard composes: the reader's stored choice → the one rule
 *  (`comparisonChoiceOf`) → the controls and the notice, both handed the
 *  prior the page requests. */
function Page({
  rows,
  currentId,
  currentEnd,
  columns = true,
  share = null,
}: {
  rows: Row[];
  currentId: string;
  currentEnd: string | null;
  columns?: boolean;
  /** What the tab on screen can paint from the period's own share block —
   *  null on a tab with no share column of its own (cash flow, ratios),
   *  which is what every law here models unless it says otherwise. */
  share?: { base: "PL" | "BS"; served: boolean } | null;
}) {
  const view = useComparativesView();
  const choice = comparisonChoiceOf(
    { currentId, currentEnd, currentOrgId: ORG, activeOrgId: ORG, stored: view.view.priorPeriodId },
    companyOf(rows),
  );
  lastChoice = choice;
  return (
    <>
      <ComparativesControls
        periods={choice.periods}
        currentId={currentId}
        currentEnd={currentEnd}
        autoPick={choice.autoPick}
        priorId={choice.priorId}
        currency="RON"
        columns={columns}
        share={share}
      />
      <ComparativesNoPriorNote
        periods={choice.periods}
        currentId={currentId}
        currentEnd={currentEnd}
        priorId={choice.priorId}
        uploadHref={`/workspace?period=${currentId}`}
      />
    </>
  );
}

const mount = (props: Parameters<typeof Page>[0]) => (
  <MemoryRouter>
    <ComparativesViewProvider orgId={ORG}>
      <Page {...props} />
    </ComparativesViewProvider>
  </MemoryRouter>
);

const controls = () => screen.getByTestId("comparatives-controls");
const notice = () => screen.queryByTestId("comparatives-no-prior");
const boxes = () => screen.queryAllByTestId(/^comparatives-col-/) as HTMLInputElement[];
const select = () => screen.getByTestId("comparatives-prior-select") as HTMLSelectElement;
const autoOption = () => within(select()).getAllByRole("option")[0].textContent ?? "";
const picks = () => screen.queryAllByTestId("comparatives-no-prior-pick");

/** No sentence on screen is an untranslated key. */
function noRawKeys(): void {
  const text = (controls().textContent ?? "") + (notice()?.textContent ?? "");
  expect(text).not.toMatch(/statements\.cmp\.|\{\{|\}\}/);
}

async function language(lang: "en" | "ro"): Promise<void> {
  await act(async () => {
    await i18n.changeLanguage(lang);
  });
}

beforeEach(async () => {
  window.localStorage.clear();
  lastChoice = null;
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await i18n.changeLanguage("en");
  // eslint-disable-next-line no-console
  console.log(`GATE-WORK compare-no-prior states=${statesChecked}`);
});

// ── The date AUTO looked for ───────────────────────────────────────────

describe("previousYearEnd — the close a reader means by 'the previous year'", () => {
  it("the same month one year earlier; a month's last day stays the month's last day", () => {
    const cases: [string | null | undefined, string | null][] = [
      ["2024-12-31", "2023-12-31"],
      ["2025-08-31", "2024-08-31"],
      ["2025-02-28", "2024-02-29"], // last day of February → last day of February
      ["2024-02-29", "2023-02-28"],
      ["2025-06-15", "2024-06-15"],
      ["2024-12-31T00:00:00Z", "2023-12-31"],
      [null, null],
      [undefined, null],
      ["", null],
      ["Dec 2024", null],
      ["2024-13-31", null],
      ["2024-02-31", null],
      ["2024-00-10", null],
    ];
    for (const [input, expected] of cases) {
      expect(previousYearEnd(input), String(input)).toBe(expected);
      statesChecked += 1;
    }
  });

  it("comparisonHasNoPrior: ON and nothing resolves — never when the reader turned comparisons off", () => {
    expect(comparisonHasNoPrior(null, null)).toBe(true);
    expect(comparisonHasNoPrior(P25, null)).toBe(true); // a stored choice that was ignored
    expect(comparisonHasNoPrior(null, P24)).toBe(false);
    expect(comparisonHasNoPrior(P24, P24)).toBe(false);
    expect(comparisonHasNoPrior("none", null)).toBe(false);
    statesChecked += 5;
  });

  it("noPriorStateOf: the missing close, and the EARLIER periods nearest first — never a later one", () => {
    const periods = companyOf([month(6), month(5), month(4), month(3), month(2), month(1)]).periods;
    const on = (m: number) =>
      noPriorStateOf({ periods, currentId: month(m).id, currentEnd: month(m).end, stored: null, priorId: null })!;
    expect(on(6).missingEnd).toBe("2024-06-30");
    expect(on(6).earlier.map((p) => p.period_end)).toEqual([
      "2025-05-31", "2025-04-30", "2025-03-31", "2025-02-28", "2025-01-31",
    ]);
    expect(on(3).earlier.map((p) => p.period_end)).toEqual(["2025-02-28", "2025-01-31"]);
    expect(on(1).earlier).toEqual([]);
    // Not a state at all once a prior resolves, or with comparisons off.
    expect(noPriorStateOf({ periods, currentId: month(6).id, stored: null, priorId: month(5).id })).toBeNull();
    expect(noPriorStateOf({ periods, currentId: month(6).id, stored: "none", priorId: null })).toBeNull();
    // The close is read off the list when the caller does not give it.
    expect(noPriorStateOf({ periods, currentId: month(6).id, stored: null, priorId: null })!.currentEnd).toBe("2025-06-30");
    statesChecked += 7;
  });
});

// ── The incident ───────────────────────────────────────────────────────

describe("the incident — the company's earliest year on screen, AUTO selected", () => {
  it("the rule resolves no prior, and does not pick the later year in its place", () => {
    const got = comparisonChoiceOf(
      { currentId: P24, currentEnd: "2024-12-31", currentOrgId: ORG, activeOrgId: ORG, stored: null },
      companyOf(TWO_YEARS),
    );
    expect(got.autoPick).toBeNull();
    expect(got.priorId).toBeNull();
    expect(got.periods.map((p) => p.period_id)).toEqual([P25, P24]);
    statesChecked += 1;
  });

  const WORDS = {
    ro: {
      auto: "Anul precedent (automat) — dec. 2023 lipsește",
      title: "Fără comparație automată.",
      body: "Compania nu are o balanță analizată la dec. 2023, așa că dec. 2024 apare fără comparație.",
      upload: "Încarcă balanța la dec. 2023",
      options: ["Anul precedent (automat) — dec. 2023 lipsește", "Fără comparație", "dec. 2025"],
      disabled: "Nicio perioadă de comparație — coloanele apar după ce alegi una.",
    },
    en: {
      auto: "Previous year (auto) — Dec 2023 missing",
      title: "No automatic comparison.",
      body: "This company has no analysed Dec 2023 trial balance, so Dec 2024 is shown without a comparison.",
      upload: "Upload the Dec 2023 balance",
      options: ["Previous year (auto) — Dec 2023 missing", "No comparison", "Dec 2025"],
      disabled: "No comparison period — the columns appear once one is chosen.",
    },
  } as const;

  for (const lang of ["ro", "en"] as const) {
    it(`${lang}: the picker names the missing balance, the notice says why and what to do, every box is off`, async () => {
      render(mount({ rows: TWO_YEARS, currentId: P24, currentEnd: "2024-12-31" }));
      await language(lang);
      const w = WORDS[lang];

      expect(controls().getAttribute("data-comparison")).toBe("no-prior");
      expect(select().value).toBe("auto");
      expect(autoOption()).toBe(w.auto);
      // The later year stays in the list — one pick away, as before.
      expect(within(select()).getAllByRole("option").map((o) => o.textContent)).toEqual(w.options);

      const n = notice();
      expect(n, "the comparison is on, compares nothing, and says nothing").not.toBeNull();
      expect(n!.getAttribute("role")).toBe("status");
      expect(n!.getAttribute("data-missing")).toBe(monthLabel("2023-12-31", lang));
      expect(n!.textContent).toContain(w.title);
      expect(screen.getByTestId("comparatives-no-prior-body").textContent).toBe(w.body);
      // The notice is not inside the controls row (the page pins that row).
      expect(controls().contains(n)).toBe(false);

      const upload = screen.getByTestId("comparatives-no-prior-upload");
      expect(upload.textContent).toBe(w.upload);
      expect(upload.getAttribute("href")).toBe(`/workspace?period=${P24}`);

      // The only other period is LATER: it is not offered as "compare with".
      expect(picks(), "a later period offered as the comparison").toEqual([]);

      expect(boxes().map((b) => b.getAttribute("data-testid"))).toEqual([
        "comparatives-col-prior",
        "comparatives-col-delta",
        "comparatives-col-deltaPct",
        "comparatives-col-share",
      ]);
      for (const b of boxes()) {
        expect(b.disabled, `${b.dataset.testid} is enabled with nothing compared`).toBe(true);
        expect(b.checked, `${b.dataset.testid} is ticked with no column on screen`).toBe(false);
        expect(b.getAttribute("aria-describedby")).toBe(n!.id);
      }
      const cols = screen.getByTestId("comparatives-columns");
      expect(cols.getAttribute("data-disabled")).toBe("true");
      expect(cols.getAttribute("title")).toBe(w.disabled);
      noRawKeys();

      // AMENDED 2026-10-04 (single-year-share). The above is a tab with no
      // share column of its own. On the P&L and the balance sheet the three
      // COMPARISON boxes are off as above, and the share box stays the
      // reader's own: the period's shares need no comparison.
      cleanup();
      render(mount({ rows: TWO_YEARS, currentId: P24, currentEnd: "2024-12-31", share: { base: "PL", served: true } }));
      const again = notice();
      expect(again).not.toBeNull();
      for (const b of boxes().slice(0, 3)) {
        expect(b.disabled, `${b.dataset.testid} is enabled with nothing compared`).toBe(true);
        expect(b.checked, `${b.dataset.testid} is ticked with no column on screen`).toBe(false);
        expect(b.getAttribute("aria-describedby")).toBe(again!.id);
        expect(b.closest("label")!.getAttribute("title")).toBe(w.disabled);
      }
      const share = screen.getByTestId("comparatives-col-share") as HTMLInputElement;
      expect(share.disabled, "the share box is off although the tab can paint the period's own shares").toBe(false);
      expect(share.checked).toBe(true);
      expect(share.getAttribute("aria-describedby")).toBeNull();
      expect(screen.getByTestId("comparatives-columns").getAttribute("data-disabled")).toBe("false");
      noRawKeys();
      statesChecked += 2;
    });
  }

  it("ro: every month in the sentence is a Romanian month — never 'Jun 2024' in a Romanian sentence", async () => {
    const rows: Row[] = [
      { id: P25, start: "2025-01-01", end: "2026-06-30" },
      { id: P24, start: "2025-01-01", end: "2025-06-30" },
    ];
    render(mount({ rows, currentId: P24, currentEnd: "2025-06-30" }));
    await language("ro");
    expect(autoOption()).toBe("Anul precedent (automat) — iun. 2024 lipsește");
    expect(screen.getByTestId("comparatives-no-prior-body").textContent).toBe(
      "Compania nu are o balanță analizată la iun. 2024, așa că iun. 2025 apare fără comparație.",
    );
    expect(screen.getByTestId("comparatives-no-prior-upload").textContent).toBe("Încarcă balanța la iun. 2024");
    expect((controls().textContent ?? "") + notice()!.textContent).not.toMatch(
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec) \d{4}/,
    );
    statesChecked += 1;
  });

  it("choosing the later year from the list compares with it; back on AUTO the notice returns", () => {
    render(mount({ rows: TWO_YEARS, currentId: P24, currentEnd: "2024-12-31" }));
    fireEvent.change(select(), { target: { value: P25 } });

    expect(lastChoice!.priorId).toBe(P25);
    expect(readComparativesView(ORG).priorPeriodId).toBe(P25);
    expect(notice()).toBeNull();
    expect(controls().getAttribute("data-comparison")).toBe("on");
    for (const b of boxes()) {
      expect(b.disabled).toBe(false);
      expect(b.checked).toBe(true);
      expect(b.getAttribute("aria-describedby")).toBeNull();
    }
    expect(screen.getByTestId("comparatives-columns").getAttribute("title")).toBeNull();

    fireEvent.change(select(), { target: { value: "auto" } });
    expect(lastChoice!.priorId).toBeNull();
    expect(notice()).not.toBeNull();
    for (const b of boxes()) expect(b.disabled && !b.checked).toBe(true);
    statesChecked += 2;
  });

  it("the Overview has no column boxes — and still says there is nothing to compare with", () => {
    render(mount({ rows: TWO_YEARS, currentId: P24, currentEnd: "2024-12-31", columns: false }));
    expect(boxes()).toEqual([]);
    expect(notice()).not.toBeNull();
    expect(screen.getByTestId("comparatives-no-prior-body").textContent).toContain("Dec 2023");
    statesChecked += 1;
  });

  it("'No comparison' is the reader's choice: no notice, no boxes", () => {
    render(mount({ rows: TWO_YEARS, currentId: P24, currentEnd: "2024-12-31" }));
    fireEvent.change(select(), { target: { value: "none" } });
    expect(controls().getAttribute("data-comparison")).toBe("off");
    expect(notice()).toBeNull();
    expect(boxes()).toEqual([]);
    // AMENDED 2026-10-04 (single-year-share): on a tab that can paint the
    // period's own shares, the share box — alone — is still offered.
    cleanup();
    render(mount({ rows: TWO_YEARS, currentId: P24, currentEnd: "2024-12-31", share: { base: "PL", served: true } }));
    expect(notice()).toBeNull();
    expect(boxes().map((b) => [b.getAttribute("data-testid"), b.disabled, b.checked])).toEqual([
      ["comparatives-col-share", false, true],
    ]);
    statesChecked += 2;
  });

  it("the previous year IS uploaded, as a half-year: never 'missing' — 'no period of the same length', and it is one click away", () => {
    const rows: Row[] = [year(P24, 2024), { id: P23, start: "2023-07-01", end: "2023-12-31" }];
    render(mount({ rows, currentId: P24, currentEnd: "2024-12-31" }));
    expect(lastChoice!.priorId, "AUTO took a period of another length").toBeNull();
    expect(notice()).not.toBeNull();
    expect(notice()!.getAttribute("data-missing")).toBe("");
    expect((controls().textContent ?? "") + notice()!.textContent).not.toMatch(/missing/);
    expect(autoOption()).toBe("Previous year (auto)");
    expect(screen.getByTestId("comparatives-no-prior-body").textContent).toBe(
      "This company has no earlier analysed period of the same length, so this period is shown without a comparison.",
    );
    expect(screen.getByTestId("comparatives-no-prior-upload").textContent).toBe("Upload an earlier balance");
    expect(picks().map((b) => b.textContent)).toEqual(["Compare with Dec 2023"]);
    fireEvent.click(picks()[0]);
    expect(lastChoice!.priorId).toBe(P23);
    expect(readComparativesView(ORG).priorPeriodId).toBe(P23);
    expect(notice()).toBeNull();
    // The keyboard reader lands on the picker, which names the period chosen.
    expect(document.activeElement).toBe(select());
    expect(select().value).toBe(P23);
    statesChecked += 1;
  });

  it(`a company uploading monthly: at most ${NO_PRIOR_ALTERNATIVES} earlier months, nearest first — no later month`, () => {
    const rows = [month(6), month(5), month(4), month(3), month(2), month(1)];
    const r = render(mount({ rows, currentId: month(6).id, currentEnd: month(6).end }));
    expect(lastChoice!.priorId).toBeNull();
    expect(NO_PRIOR_ALTERNATIVES).toBe(3);
    expect(picks().map((b) => b.textContent)).toEqual([
      "Compare with May 2025",
      "Compare with Apr 2025",
      "Compare with Mar 2025",
    ]);
    // …and the picker lists every other month.
    expect(within(select()).getAllByRole("option").length).toBe(2 + 5);

    r.rerender(mount({ rows, currentId: month(2).id, currentEnd: month(2).end }));
    expect(picks().map((b) => b.getAttribute("data-period"))).toEqual([month(1).id]);

    r.rerender(mount({ rows, currentId: month(1).id, currentEnd: month(1).end }));
    expect(notice()).not.toBeNull();
    expect(picks(), "a later month offered as the comparison").toEqual([]);
    statesChecked += 3;
  });

  it("a period whose close cannot be read: the notice still stands, naming no month", async () => {
    const rows: Row[] = [year(P25, 2025), { id: P24, start: null, end: "" }];
    render(mount({ rows, currentId: P24, currentEnd: null }));
    await language("ro");
    expect(notice()).not.toBeNull();
    expect(notice()!.getAttribute("data-missing")).toBe("");
    expect(autoOption()).toBe("Anul precedent (automat)");
    expect(screen.getByTestId("comparatives-no-prior-body").textContent).toBe(
      "Compania nu are o perioadă anterioară analizată, de aceeași durată, așa că perioada apare fără comparație.",
    );
    expect(screen.getByTestId("comparatives-no-prior-upload").textContent).toBe("Încarcă o balanță anterioară");
    expect(picks()).toEqual([]);
    for (const b of boxes()) expect(b.disabled && !b.checked).toBe(true);
    noRawKeys();
    statesChecked += 1;
  });
});

// ── With a prior, nothing changed ──────────────────────────────────────

describe("a prior resolves — the controls are the ones the reader had", () => {
  it("the later year on screen: AUTO names the year before, no notice, the boxes work", () => {
    render(mount({ rows: TWO_YEARS, currentId: P25, currentEnd: "2025-12-31" }));
    expect(lastChoice!.priorId).toBe(P24);
    expect(controls().getAttribute("data-comparison")).toBe("on");
    expect(autoOption()).toBe("Previous year (auto) — Dec 2024");
    expect(notice()).toBeNull();
    expect(screen.queryByTestId("comparatives-no-prior-upload")).toBeNull();
    for (const b of boxes()) {
      expect(b.disabled).toBe(false);
      expect(b.checked).toBe(true);
    }
    fireEvent.click(screen.getByTestId("comparatives-col-share"));
    expect(readComparativesView(ORG).columns).toEqual({ prior: true, delta: true, deltaPct: true, share: false });
    expect((screen.getByTestId("comparatives-col-share") as HTMLInputElement).checked).toBe(false);
    statesChecked += 1;
  });

  it("the reader's columns survive the no-prior state: off while nothing is compared, back as stored", () => {
    const at = (currentId: string, currentEnd: string) => mount({ rows: TWO_YEARS, currentId, currentEnd });
    const r = render(at(P25, "2025-12-31"));
    fireEvent.click(screen.getByTestId("comparatives-col-share"));

    r.rerender(at(P24, "2024-12-31"));
    expect(notice()).not.toBeNull();
    for (const b of boxes()) expect(b.disabled && !b.checked).toBe(true);
    // The state wrote nothing over the reader's choice.
    expect(readComparativesView(ORG).columns).toEqual({ prior: true, delta: true, deltaPct: true, share: false });

    r.rerender(at(P25, "2025-12-31"));
    expect(notice()).toBeNull();
    expect(boxes().map((b) => [b.disabled, b.checked])).toEqual([
      [false, true],
      [false, true],
      [false, true],
      [false, false],
    ]);
    statesChecked += 3;
  });
});

// ── The law, over every shape ──────────────────────────────────────────

describe("the law — ON and nothing compared is always said; a comparison is never interrupted", () => {
  const SHAPES: { name: string; rows: Row[] }[] = [
    { name: "two year-ends", rows: TWO_YEARS },
    { name: "three year-ends", rows: [year(P25, 2025), year(P24, 2024), year(P23, 2023)] },
    {
      name: "a year-end and an eleven-month close of the year before",
      rows: [year(P25, 2025), { id: P24, start: "2024-01-01", end: "2024-11-30" }],
    },
    {
      name: "two August year-to-dates",
      rows: [
        { id: P25, start: "2025-01-01", end: "2025-08-31" },
        { id: P24, start: "2024-01-01", end: "2024-08-31" },
      ],
    },
    {
      name: "February closes across a leap year",
      rows: [
        { id: P25, start: null, end: "2025-02-28" },
        { id: P24, start: null, end: "2024-02-29" },
      ],
    },
    {
      name: "a year-end and the year before as a half-year",
      rows: [year(P24, 2024), { id: P23, start: "2023-07-01", end: "2023-12-31" }],
    },
    {
      name: "a year-end and a later half-year",
      rows: [{ id: P25, start: "2025-01-01", end: "2025-06-30" }, year(P24, 2024)],
    },
    { name: "six cumulative months of one year", rows: [month(6), month(5), month(4), month(3), month(2), month(1)] },
  ];
  const STORED: (string | null | "none")[] = [null, "none", P25, P24, P23, "9e2d0000-0000-4000-8000-00000000dead"];

  it("every company shape × period on screen × stored choice", () => {
    let noPrior = 0;
    let withPrior = 0;
    let named = 0;
    let offered = 0;
    for (const shape of SHAPES) {
      for (const cur of shape.rows) {
        for (const stored of STORED) {
          // The reader's stored view: the choice under test, and Δ % unticked —
          // so "the boxes are as stored" is told apart from "all ticked".
          window.localStorage.clear();
          window.localStorage.setItem(
            "cfo:comparatives-view:v2:" + ORG,
            JSON.stringify({ priorPeriodId: stored, columns: { prior: true, delta: true, deltaPct: false, share: true } }),
          );
          const r = render(mount({ rows: shape.rows, currentId: cur.id, currentEnd: cur.end }));
          const where = `${shape.name} · ${cur.end} on screen · stored ${String(stored)}`;
          const state = controls().getAttribute("data-comparison");
          const others = shape.rows.filter((x) => x.id !== cur.id);
          if (stored === "none") {
            expect(state, where).toBe("off");
            expect(notice(), where).toBeNull();
            expect(boxes(), where).toEqual([]);
          } else if (lastChoice!.priorId === null) {
            noPrior += 1;
            expect(state, where).toBe("no-prior");
            expect(notice(), `${where}: nothing compared, nothing said`).not.toBeNull();
            expect(boxes().length, where).toBe(4);
            for (const b of boxes()) expect(b.disabled && !b.checked, `${where}: ${b.dataset.testid}`).toBe(true);
            // AUTO names the balance it looked for — from the FIXTURE's rows,
            // not from what the component says about itself — and never one
            // that is in the list at another length.
            const wanted = previousYearEnd(cur.end)!;
            const uploadedAtAnotherLength = others.some((x) => x.end.slice(0, 7) === wanted.slice(0, 7));
            const missing = notice()!.getAttribute("data-missing") ?? "";
            if (uploadedAtAnotherLength) {
              expect(missing, where).toBe("");
              expect((controls().textContent ?? "") + notice()!.textContent, where).not.toMatch(/missing/);
              expect(autoOption(), where).toBe("Previous year (auto)");
            } else {
              named += 1;
              expect(missing, where).toBe(monthLabel(wanted, "en"));
              expect(autoOption(), where).toBe(`Previous year (auto) — ${monthLabel(wanted, "en")} missing`);
            }
            // One click away: the EARLIER periods, nearest first, at most
            // three — and never a later one.
            const earlier = others
              .filter((x) => x.end < cur.end)
              .sort((a, b) => b.end.localeCompare(a.end))
              .slice(0, 3)
              .map((x) => x.id);
            expect(picks().map((b) => b.getAttribute("data-period")), where).toEqual(earlier);
            offered += earlier.length;
          } else {
            withPrior += 1;
            expect(state, where).toBe("on");
            expect(notice(), `${where}: a notice over a comparison that exists`).toBeNull();
            expect(boxes().map((b) => [b.disabled, b.checked]), where).toEqual([
              [false, true],
              [false, true],
              [false, false],
              [false, true],
            ]);
          }
          noRawKeys();
          statesChecked += 1;
          r.unmount();
        }
      }
    }
    // Not vacuous: every branch was walked.
    expect(noPrior).toBeGreaterThanOrEqual(30);
    expect(withPrior).toBeGreaterThanOrEqual(30);
    expect(named).toBeGreaterThanOrEqual(25);
    expect(offered).toBeGreaterThanOrEqual(15);
  });
});

// ── No document of another pair ────────────────────────────────────────

describe("no comparison is left behind — the document on screen is the one for the pair on screen", () => {
  /** The APP's own query defaults (lib/queryClient.ts: keepPreviousData and
   *  all) — the test client used elsewhere has none of them, which is why no
   *  other gate could see this. Retries off so a refusal settles at once. */
  const appLikeClient = () => {
    const defaults = appQueryClient.getDefaultOptions();
    return new QueryClient({ defaultOptions: { ...defaults, queries: { ...defaults.queries, retry: false } } });
  };

  let query: ReturnType<typeof useComparatives> | null = null;
  function Fetcher({ periodId, priorId }: { periodId: string; priorId: string | null }) {
    query = useComparatives(periodId, priorId, ORG);
    return null;
  }
  const wrap = (qc: QueryClient, periodId: string, priorId: string | null) => (
    <QueryClientProvider client={qc}>
      <Fetcher periodId={periodId} priorId={priorId} />
    </QueryClientProvider>
  );

  const held: { release: (() => void) | null } = { release: null };
  function stubEngine(hold: (cur: string, prior: string) => boolean = () => false) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const m = /\/api\/period\/([^/?]+)\/comparatives\?prior=([^&]+)/.exec(String(input));
        if (!m) return new Response("{}", { status: 404 });
        const [cur, prior] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
        if (hold(cur, prior)) await new Promise<void>((res) => { held.release = res; });
        return new Response(JSON.stringify({ current: { period_id: cur }, prior: { period_id: prior } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  }

  it("the app's client keeps previous results as placeholders — the premise", () => {
    expect(
      appQueryClient.getDefaultOptions().queries?.placeholderData,
      "lib/queryClient.ts no longer keeps previous data",
    ).toBeTypeOf("function");
    statesChecked += 1;
  });

  it("stepping from a compared period to one with no prior: the previous document is gone", async () => {
    stubEngine();
    const qc = appLikeClient();
    const r = render(wrap(qc, P25, P24));
    await waitFor(() => expect(query!.data?.kind).toBe("ok"));
    expect((query!.data as { data: { prior: { period_id: string } } }).data.prior.period_id).toBe(P24);

    // The period stepper: Dec 2024 on screen, AUTO resolves to nothing.
    r.rerender(wrap(qc, P24, null));
    expect(query!.data, "the Dec 2025 comparison is still served under Dec 2024").toBeUndefined();
    expect(query!.isPlaceholderData).toBe(false);
    statesChecked += 1;
  });

  it("changing the prior: until the new pair's own answer arrives there is no document", async () => {
    stubEngine((_cur, prior) => prior === P23);
    const qc = appLikeClient();
    const r = render(wrap(qc, P25, P24));
    await waitFor(() => expect(query!.data?.kind).toBe("ok"));

    r.rerender(wrap(qc, P25, P23));
    expect(query!.data, "the previous prior's document stands in for the new one").toBeUndefined();
    await waitFor(() => expect(held.release).not.toBeNull());
    await act(async () => { held.release?.(); });
    await waitFor(() => expect(query!.data?.kind).toBe("ok"));
    expect((query!.data as { data: { prior: { period_id: string } } }).data.prior.period_id).toBe(P23);
    statesChecked += 1;
  });

  it("where the answer becomes what the page paints: a document of another pair, or with no request, is no document", () => {
    interface Pair {
      current_body: {
        assembled_metrics: Record<string, unknown>;
        statements: { periodLabel: string } & Record<string, unknown>;
        metrics: { name: string; value: number | null }[];
      };
      comparatives: { current: { period_id: string }; prior: { period_id: string } } & Record<string, unknown>;
    }
    const p = JSON.parse(JSON.stringify(pairJson)) as Pair;
    const metricsByName: Record<string, number | null> = {};
    for (const m of p.current_body.metrics) metricsByName[m.name] = typeof m.value === "number" ? m.value : null;
    const surfaces = (periodId: string | null, priorId: string | null, data: unknown) =>
      ratioSurfacesOf({
        assembledMetrics: p.current_body.assembled_metrics,
        statements: p.current_body.statements as never,
        metricsByName,
        currentLabel: p.current_body.statements.periodLabel,
        periodId,
        priorId,
        comparatives: { data: data as never },
      });
    const ok = { kind: "ok", data: p.comparatives };
    const cur = p.comparatives.current.period_id;
    const pri = p.comparatives.prior.period_id;

    // The pair on screen: served.
    expect(surfaces(cur, pri, ok).cmpDoc).not.toBeNull();
    // No request (AUTO found nothing / comparisons off): nothing is painted,
    // whatever result is still in hand.
    expect(surfaces(cur, null, ok).cmpDoc).toBeNull();
    expect(surfaces(cur, null, ok).statementsForExport?.comparatives ?? null).toBeNull();
    // Another period on screen, or another prior asked for: not this document.
    expect(surfaces(P24, pri, ok).cmpDoc).toBeNull();
    expect(surfaces(cur, P23, ok).cmpDoc).toBeNull();
    // A refusal held over is not this pair's refusal either.
    const refused = { kind: "refused", code: "period_not_servable", message: "x" };
    expect(surfaces(cur, pri, refused).cmpRefused).toEqual({ code: "period_not_servable" });
    expect(surfaces(cur, null, refused).cmpRefused).toBeNull();
    statesChecked += 6;
  });
});

// ── The page hands the controls the prior it requests ──────────────────

describe("the dashboard — the controls and the notice read the prior the page requests", () => {
  const page = readFileSync(resolve(process.cwd(), "frontend/pages/cfo/FinancialStatements.tsx"), "utf8");
  const element = (name: string): string => {
    const uses = page.match(new RegExp(`<${name}\\b[\\s\\S]*?/>`, "g")) ?? [];
    expect(uses.length, `the page renders <${name}> once`).toBe(1);
    return uses[0];
  };

  it("one <ComparativesControls> and one <ComparativesNoPriorNote>, fed by the choice the request is made with", () => {
    const ctl = element("ComparativesControls");
    expect(ctl).toMatch(/\bpriorId=\{cmpPriorId\}/);
    expect(ctl).toMatch(/\bautoPick=\{cmpAutoPick\}/);
    expect(ctl).toMatch(/\bperiods=\{cmpPeriods\}/);
    expect(ctl).toMatch(/\bcurrentEnd=\{remotePeriod\.periodEnd\}/);
    const note = element("ComparativesNoPriorNote");
    expect(note).toMatch(/\bpriorId=\{cmpPriorId\}/);
    expect(note).toMatch(/\bperiods=\{cmpPeriods\}/);
    expect(note).toMatch(/\bcurrentEnd=\{remotePeriod\.periodEnd\}/);
    expect(note).toMatch(/\buploadHref=\{/);
    // …and `cmpPriorId` is the rule's answer, the one the request is made with.
    expect(page).toMatch(/\bcmpPriorId\b[^=\n]*=\s*cmpChoice\.priorId\b/);
    expect(page).toMatch(/useComparatives\(\s*remotePeriod\.id,\s*cmpPriorId,\s*cmpCompanyId\s*\)/);
    statesChecked += 1;
  });

  it("the notice is rendered on every tab the controls are, outside the sticky tab bar", () => {
    const ctlAt = page.indexOf("<ComparativesControls");
    const noteAt = page.indexOf("<ComparativesNoPriorNote");
    const guard = (at: number) => page.slice(Math.max(0, at - 420), at);
    for (const tab of ["overview", "pl", "balance_sheet", "cash_flow", "ratios"]) {
      expect(guard(ctlAt), `controls on ${tab}`).toContain(`activeTab === "${tab}"`);
      expect(guard(noteAt), `notice on ${tab}`).toContain(`activeTab === "${tab}"`);
    }
    expect(guard(noteAt)).toContain("cmpPeriods.length > 1");
    // After the controls, and after the sticky bar's closing tags.
    expect(noteAt).toBeGreaterThan(ctlAt);
    const between = page.slice(ctlAt, noteAt);
    expect(between).toMatch(/<\/div>\s*\)\}/);
    statesChecked += 1;
  });

  it("`priorId` is a required prop of both — a caller that omits it does not compile", () => {
    const panel = readFileSync(resolve(process.cwd(), "frontend/components/cfo/ComparativesPanel.tsx"), "utf8");
    expect(panel.match(/\n {2}priorId: string \| null;\n/g)?.length).toBe(2);
    expect(panel).not.toMatch(/priorId\?:/);
    statesChecked += 1;
  });
});

// ── The next step leads somewhere ──────────────────────────────────────

describe("the next step leads somewhere — and what it uploads is then seen", () => {
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
  const app = read("frontend/App.tsx");
  const routed = (path: string) => new RegExp(`<Route\\s+path="${path}"`).test(app);

  it("every upload link of the comparison goes to a path the app routes", () => {
    expect(routed("/workspace"), "the workspace has no route").toBe(true);
    // The premise of the cash-flow card's old link: `/financials` is not routed.
    expect(routed("/financials")).toBe(false);
    const cf = read("frontend/components/cfo/CashFlowStatementView.tsx");
    expect(cf, "the cash-flow card links to a path with no route").not.toMatch(/(?:href|to)="\/financials"/);
    const cta = cf.match(/<(?:Link|a)\b[^>]*data-testid="cf-upload-prior-cta"[^>]*>/g) ?? [];
    expect(cta.length).toBe(2); // in a router, and on its own
    for (const el of cta) expect(el).toMatch(/(?:to|href)=\{uploadHref\}/);
    expect(cf).toMatch(/uploadHref = "\/workspace"/);
    const page = read("frontend/pages/cfo/FinancialStatements.tsx");
    const use = page.match(/<CashFlowStatementView\b[\s\S]*?uploadHref=\{[^}]*\/workspace/);
    expect(use, "the dashboard does not hand the cash-flow view the workspace link").not.toBeNull();
    statesChecked += 1;
  });

  it("a balance uploaded from the workspace refreshes the period lists the comparison reads", () => {
    const host = read("frontend/components/cfo/upload/UploadFlowHost.tsx");
    const done = /if \(done\) \{([\s\S]*?)\n {6}\}/.exec(host)?.[1] ?? "";
    expect(done).toContain('queryKey: ["periods-with-documents"]');
    expect(done).toContain('queryKey: ["org-periods"]');
    // …the family `useCompanyPeriods` — the comparison's list — is keyed under.
    const periods = read("frontend/lib/orgPeriods.ts");
    expect(periods).toMatch(/\["periods-with-documents", "company", orgId\]/);
    statesChecked += 1;
  });
});

// ── Both languages carry every sentence ────────────────────────────────

describe("every sentence exists in English and in Romanian", () => {
  const KEYS: Record<string, string[]> = {
    autoMissing: ["label"],
    columnsDisabled: [],
    noPriorTitle: [],
    noPriorBody: ["prior", "current"],
    noPriorBodyUnnamed: [],
    noPriorUpload: ["prior"],
    noPriorUploadUnnamed: [],
    noPriorCompareWith: ["label"],
  };
  const cmpOf = (bundle: unknown) =>
    (bundle as { statements: { cmp: Record<string, string> } }).statements.cmp;

  it("each key, with its placeholders, in both bundles — and the two differ", () => {
    for (const [key, slots] of Object.entries(KEYS)) {
      const e = cmpOf(en)[key];
      const r = cmpOf(ro)[key];
      expect(typeof e === "string" && e.trim().length > 0, `en statements.cmp.${key}`).toBe(true);
      expect(typeof r === "string" && r.trim().length > 0, `ro statements.cmp.${key}`).toBe(true);
      expect(r, `statements.cmp.${key} is the same string in both languages`).not.toBe(e);
      for (const s of slots) {
        expect(e, `en ${key}`).toContain(`{{${s}}}`);
        expect(r, `ro ${key}`).toContain(`{{${s}}}`);
      }
      statesChecked += 1;
    }
  });
});
