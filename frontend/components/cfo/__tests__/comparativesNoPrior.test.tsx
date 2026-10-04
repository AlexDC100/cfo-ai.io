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
//   · the picker's AUTO option names the balance it looked for, as not
//     uploaded;
//   · a notice says, in the reader's language, which balance is missing and
//     which period is therefore shown alone, and offers the next step — where
//     to upload it, and each other period of the company one click away;
//   · every column box is OFF (disabled, unticked): no column is on screen;
//   · AUTO never picks another period in its place, and the reader's stored
//     columns are not overwritten by the state.
// And whenever a prior DOES resolve: no notice, no disabled box.
//
// Fails on: the notice not rendered (the incident), a box left enabled or
// ticked with nothing compared, AUTO's label not naming the missing balance,
// a missing Romanian or English sentence (a raw key on screen), the page not
// handing the controls the prior it actually requests.
//
// What it cannot see: whether the engine's document, once a prior exists,
// fills the columns (comparatives.test.ts, plCompareSubtotals.test.tsx) —
// and a company with ONE period, where the page renders no controls at all.
// Plant log: docs/engine_book/gates.md, "compare-no-prior".
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => null,
  currentOrgId: async () => null,
}));

const { ComparativesControls } = await import("@/components/cfo/ComparativesPanel");
const { comparisonChoiceOf, comparisonHasNoPrior, previousYearEnd } = await import("@/lib/comparatives");
const { ComparativesViewProvider, useComparativesView, readComparativesView } = await import(
  "@/stores/comparativesView"
);

// ── A company, as the engine lists its periods (no real id, no real name) ──
const ORG = "0c0a0000-0000-4000-8000-00000000c0a1";
const P25 = "9e2d0000-0000-4000-8000-000000002025";
const P24 = "9e2d0000-0000-4000-8000-000000002024";
const P23 = "9e2d0000-0000-4000-8000-000000002023";

interface Row {
  id: string;
  start: string | null;
  end: string;
}
const year = (id: string, y: number): Row => ({ id, start: `${y}-01-01`, end: `${y}-12-31` });

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

let statesChecked = 0;
let lastChoice: ReturnType<typeof comparisonChoiceOf> | null = null;

/** What the dashboard composes: the reader's stored choice → the one rule
 *  (`comparisonChoiceOf`) → the controls, with the prior the page requests. */
function Page({
  rows,
  currentId,
  currentEnd,
  columns = true,
}: {
  rows: Row[];
  currentId: string;
  currentEnd: string | null;
  columns?: boolean;
}) {
  const view = useComparativesView();
  const choice = comparisonChoiceOf(
    { currentId, currentEnd, currentOrgId: ORG, activeOrgId: ORG, stored: view.view.priorPeriodId },
    companyOf(rows),
  );
  lastChoice = choice;
  return (
    <ComparativesControls
      periods={choice.periods}
      currentId={currentId}
      currentEnd={currentEnd}
      autoPick={choice.autoPick}
      priorId={choice.priorId}
      currency="RON"
      columns={columns}
      uploadHref={`/workspace?period=${currentId}`}
    />
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

/** No sentence on screen is an untranslated key. */
function noRawKeys(): void {
  expect(controls().textContent ?? "").not.toMatch(/statements\.cmp\.|\{\{|\}\}/);
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
      auto: "Anul precedent (automat) — Dec 2023, neîncărcat",
      title: "Încă nu ai cu ce compara.",
      body: "Balanța la Dec 2023 nu este încărcată pentru această companie, așa că Dec 2024 apare fără comparație.",
      upload: "Încarcă balanța la Dec 2023",
      pick: "Compară cu Dec 2025",
      disabled: "Nicio perioadă de comparație — coloanele apar după ce alegi una.",
    },
    en: {
      auto: "Previous year (auto) — Dec 2023, not uploaded",
      title: "Nothing to compare with yet.",
      body: "No Dec 2023 trial balance is uploaded for this company, so Dec 2024 is shown without a comparison.",
      upload: "Upload the Dec 2023 balance",
      pick: "Compare with Dec 2025",
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

      const n = notice();
      expect(n, "the comparison is on, compares nothing, and says nothing").not.toBeNull();
      expect(n!.getAttribute("role")).toBe("status");
      expect(n!.getAttribute("data-missing")).toBe("Dec 2023");
      expect(n!.textContent).toContain(w.title);
      expect(screen.getByTestId("comparatives-no-prior-body").textContent).toBe(w.body);

      const upload = screen.getByTestId("comparatives-no-prior-upload");
      expect(upload.textContent).toBe(w.upload);
      expect(upload.getAttribute("href")).toBe(`/workspace?period=${P24}`);

      const picks = screen.getAllByTestId("comparatives-no-prior-pick");
      expect(picks.map((b) => b.textContent)).toEqual([w.pick]);
      expect(picks[0].getAttribute("data-period")).toBe(P25);

      expect(boxes().map((b) => b.getAttribute("data-testid"))).toEqual([
        "comparatives-col-prior",
        "comparatives-col-delta",
        "comparatives-col-deltaPct",
        "comparatives-col-share",
      ]);
      for (const b of boxes()) {
        expect(b.disabled, `${b.dataset.testid} is enabled with nothing compared`).toBe(true);
        expect(b.checked, `${b.dataset.testid} is ticked with no column on screen`).toBe(false);
      }
      const cols = screen.getByTestId("comparatives-columns");
      expect(cols.getAttribute("data-disabled")).toBe("true");
      expect(cols.getAttribute("title")).toBe(w.disabled);
      noRawKeys();
      statesChecked += 1;
    });
  }

  it("one click on the offered period compares with it; back on AUTO the notice returns", async () => {
    render(mount({ rows: TWO_YEARS, currentId: P24, currentEnd: "2024-12-31" }));
    fireEvent.click(screen.getByTestId("comparatives-no-prior-pick"));

    expect(lastChoice!.priorId).toBe(P25);
    expect(readComparativesView(ORG).priorPeriodId).toBe(P25);
    expect(notice()).toBeNull();
    expect(controls().getAttribute("data-comparison")).toBe("on");
    expect(select().value).toBe(P25);
    for (const b of boxes()) {
      expect(b.disabled).toBe(false);
      expect(b.checked).toBe(true);
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
    statesChecked += 1;
  });

  it("a period whose close cannot be read: the notice still stands, naming no month", async () => {
    const rows: Row[] = [year(P25, 2025), { id: P24, start: null, end: "" }];
    render(mount({ rows, currentId: P24, currentEnd: null }));
    await language("ro");
    expect(notice()).not.toBeNull();
    expect(notice()!.getAttribute("data-missing")).toBe("");
    expect(autoOption()).toBe("Anul precedent (automat)");
    expect(screen.getByTestId("comparatives-no-prior-body").textContent).toBe(
      "Nicio perioadă anterioară de aceeași lungime nu este încărcată pentru această companie, așa că perioada apare fără comparație.",
    );
    expect(screen.getByTestId("comparatives-no-prior-upload").textContent).toBe("Încarcă balanța anului precedent");
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
      name: "a year-end and a later half-year",
      rows: [{ id: P25, start: "2025-01-01", end: "2025-06-30" }, year(P24, 2024)],
    },
  ];
  const STORED: (string | null | "none")[] = [null, "none", P25, P24, P23, "9e2d0000-0000-4000-8000-00000000dead"];

  it("every company shape × period on screen × stored choice", () => {
    let noPrior = 0;
    let withPrior = 0;
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
            // AUTO names the balance it looked for — never another period.
            const missing = notice()!.getAttribute("data-missing");
            expect(missing, where).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
            expect(autoOption(), where).toBe(`Previous year (auto) — ${missing}, not uploaded`);
            // Every other period of the company is one click away.
            expect(
              screen.getAllByTestId("comparatives-no-prior-pick").map((b) => b.getAttribute("data-period")),
              where,
            ).toEqual(shape.rows.filter((x) => x.id !== cur.id).map((x) => x.id));
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
    // Not vacuous: both branches were walked.
    expect(noPrior).toBeGreaterThanOrEqual(10);
    expect(withPrior).toBeGreaterThanOrEqual(30);
  });
});

// ── The page hands the controls the prior it requests ──────────────────

describe("the dashboard — the controls read the prior the page requests", () => {
  const page = readFileSync(resolve(process.cwd(), "frontend/pages/cfo/FinancialStatements.tsx"), "utf8");

  it("one <ComparativesControls>, fed by the same choice the comparison request is made with", () => {
    const uses = page.match(/<ComparativesControls\b[\s\S]*?\/>/g) ?? [];
    expect(uses.length, "the page renders the controls once").toBe(1);
    const el = uses[0];
    expect(el).toMatch(/\bpriorId=\{cmpPriorId\}/);
    expect(el).toMatch(/\bautoPick=\{cmpAutoPick\}/);
    expect(el).toMatch(/\bcurrentEnd=\{remotePeriod\.periodEnd\}/);
    expect(el).toMatch(/\buploadHref=\{/);
    // …and `cmpPriorId` is the rule's answer, the one the request is made with.
    expect(page).toMatch(/const cmpPriorId: string \| null = cmpChoice\.priorId;/);
    expect(page).toMatch(/useComparatives\(remotePeriod\.id, cmpPriorId, cmpCompanyId\)/);
    statesChecked += 1;
  });

  it("nothing else in the app renders the controls without the prior", () => {
    const panel = readFileSync(resolve(process.cwd(), "frontend/components/cfo/ComparativesPanel.tsx"), "utf8");
    // `priorId` is a REQUIRED prop: a caller that does not pass it does not compile.
    expect(panel).toMatch(/\n {2}priorId: string \| null;\n/);
    expect(panel).not.toMatch(/priorId\?:/);
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
