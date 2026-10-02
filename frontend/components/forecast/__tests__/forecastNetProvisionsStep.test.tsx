// THE STEP THE PLAN DOES NOT PROJECT, SAID ON THE PAGE (owner ruling R2,
// 2026-09-28; review of release r-rulings2, 2026-10-01).
//
// Net provisions (6812 + 6814 − 7812 − 7814) sit outside EBITDA but inside
// the actual year's operating, pre-tax and net result, and every plan year
// projects them at 0. The only sentence that said so was in the forecast
// GET's `notes`, which no page paints: on a book with a net release the
// Forecast page printed plan-year-one pre-tax below the actual year's beside
// a rising EBITDA, with nothing naming the step (the calibration book: a
// 6,372,805.17 release).
//
// LAW, over the ENGINE's captured bytes (cockpit_agras_base.json and
// fp1_2_agras_served.json, held to the live routes by
// tests/engine/test_forecast_cockpit.py and test_forecast_serving_boundary.py):
//   · the Forecast appendix prints the year-0-only "Provizioane și ajustări
//     nete" row — year 0 the served figure, every plan year 0 — with the
//     engine's not-projected sentence beside it, in English and in Romanian;
//   · the Forecast page's "not modelled" list and the Scenarios page's lever
//     rail (both from packs/forecast/levers.yaml#unserved) say it in the
//     reader's language — Romanian from the locale bundle by its served code,
//     English as served.
// REDS ON: the row missing or without its sentence, the sentence in the
// wrong language, the unserved sentence printed in English to a Romanian
// reader.
// CANNOT SEE: whether the projection is a good one; the bank export.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { CockpitAppendix } from "@/components/forecast/cockpit/CockpitAppendix";
import { fullMoney } from "@/components/forecast/cockpit/format";
import { readCockpit } from "@/lib/forecastCockpit";
import { servedSentence } from "@/lib/forecastSentences";
import type { ActivePeriod } from "@/lib/activePeriod";

const FIX = resolve(__dirname, "../../../../tests/engine/fixtures/forecast");
const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(FIX, name), "utf-8"));

const PACK_TEXT = {
  ro: "provizioanele și ajustările nete nu se proiectează: 0 în anii de plan; anul de bază le include în rezultatul înainte de impozit și în profitul net",
  en: "net provisions and impairment adjustments are not projected: 0 in every plan year; the actual year carries them in its pre-tax result and net profit",
};

afterAll(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("net provisions — the step from year 0 the plan does not project", () => {
  const cockpit = readCockpit(fixture("cockpit_agras_base.json"))!;
  const row = cockpit.statements.pl.find((r) => r.line === "pl.net_provisions");

  it("the engine serves the row: year 0 its figure, every plan year 0, the sentence in both languages", () => {
    expect(row, "agras carries a net charge, so the row is served").toBeDefined();
    expect(row!.notProjected).toEqual(PACK_TEXT);
    expect(row!.values.length).toBe(cockpit.statements.years.length - 1);
    for (const v of row!.values) expect(v).toMatchObject({ kind: "projected", minor: 0, refusal: null });
    expect(row!.year0, "year 0 is the actual").toMatchObject({ kind: "actual", refusal: null });
    expect(Number(row!.year0!.minor), "a net charge, printed as its effect").toBeLessThan(0);
    const lines = cockpit.statements.pl.map((r) => r.line);
    expect(lines.indexOf("pl.net_provisions")).toBeGreaterThan(lines.indexOf("pl.ebitda"));
    expect(lines.indexOf("pl.net_provisions")).toBeLessThan(lines.indexOf("pl.pretax_result"));
  });

  for (const lang of ["en", "ro"] as const) {
    it(`${lang}: the appendix prints the row with the engine's sentence, and the not-modelled list says it`, async () => {
      await i18n.changeLanguage(lang);
      const { container } = renderWithProviders(
        <CockpitAppendix
          cockpit={cockpit}
          period={{ statements: null } as unknown as ActivePeriod}
          locale={lang === "ro" ? "ro-RO" : "en-US"}
          lang={lang}
          format={fullMoney(cockpit.currency, lang === "ro" ? "ro-RO" : "en-US")}
          projectedLabel="projected"
        />,
      );
      const tr = container.querySelector<HTMLElement>('[data-testid="forecast-row-pl.net_provisions"]');
      expect(tr, "the row is on the page").not.toBeNull();
      expect(tr!.textContent).toContain(lang === "ro" ? "Provizioane și ajustări nete" : "Net provisions and impairment adjustments");
      const note = container.querySelector('[data-testid="forecast-row-not-projected-pl.net_provisions"]');
      expect(note?.textContent).toBe(PACK_TEXT[lang]);
      const notModelled = container.querySelector('[data-not-modelled="net_provisions"]');
      expect(notModelled, "the not-modelled list names it").not.toBeNull();
      expect(notModelled!.textContent).toBe(i18n.getFixedT(lang)("forecast.served.net_provisions"));
      if (lang === "ro") expect(notModelled!.textContent).not.toMatch(/not projected|plan year/);
      cleanup();
    });
  }

  it("the Scenarios lever rail's unserved sentence: Romanian by its served code, English as served", () => {
    const served = fixture("fp1_2_agras_served.json") as {
      client: { unserved: { key: string; sentence: { code: string; text: string } }[] };
    };
    const entry = served.client.unserved.find((u) => u.key === "net_provisions");
    expect(entry, "the forecast GET serves it").toBeDefined();
    expect(servedSentence(i18n.getFixedT("en"), "en", entry!.sentence.code, entry!.sentence.text)).toBe(entry!.sentence.text);
    const ro = servedSentence(i18n.getFixedT("ro"), "ro", entry!.sentence.code, entry!.sentence.text);
    expect(ro).toBe(i18n.getFixedT("ro")("forecast.served.net_provisions"));
    expect(ro).not.toBe(entry!.sentence.text);
    expect(ro).toMatch(/provizioanele și ajustările nete/);
  });
});
