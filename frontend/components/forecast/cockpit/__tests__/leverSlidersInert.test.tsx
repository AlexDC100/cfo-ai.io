// @vitest-environment jsdom
/**
 * A lever the book cannot feel says so ONCE. The engine serves both a basis
 * and, for a lever whose move reaches nothing, an `inert` sentence; on the
 * EUR/RON lever with no imported share stated the two are the same words
 * (the walk of 2026-09-26 showed the sentence printed twice under the
 * slider, once grey and once amber). The card prints the sentence once —
 * in the caution tone, so the reason still reads as a warning — and prints
 * a DIFFERENT inert sentence beneath the basis as before.
 *
 * RED ON: the same sentence rendered twice inside one lever card; a
 * differing inert sentence dropped; the inert flag lost from the card.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import "@/i18n";
import { LeverSliders } from "../LeverSliders";
import type { CockpitLever } from "@/lib/forecastCockpit";

const SAME = {
  ro: "balanța nu separă achizițiile din import de cele interne; până declari ponderea importată, cursul nu mută nimic",
  en: "a trial balance does not split purchases by currency; until the imported share is stated, the rate moves nothing",
};

function lever(id: string, inert: CockpitLever["inert"], basis = SAME): CockpitLever {
  return {
    id,
    group: "more",
    unit: "pct",
    shape: "scalar",
    label: { ro: "Curs EUR/RON", en: "EUR/RON" },
    decimals: 3,
    scale: 1000,
    min: -200,
    max: 300,
    step: 5,
    value: "0",
    path: false,
    display: { ro: "0,0%", en: "0.0%" },
    origin: "default",
    isDefault: true,
    basis,
    measured: false,
    inert,
    locked: null,
  };
}

const noop = () => undefined;

function renderOne(l: CockpitLever, lang: string) {
  return render(
    <LeverSliders
      levers={[{ ...lever("x", null, { ro: "b", en: "b" }), group: "primary" }, l]}
      positions={{}}
      locale={lang === "ro" ? "ro-RO" : "en-GB"}
      lang={lang}
      onMove={noop}
      onReset={noop}
      onResetAll={noop}
      refusedId={null}
    />,
  );
}

describe("LeverSliders — an inert reason equal to the basis is said once", () => {
  afterEach(cleanup);

  for (const lang of ["ro", "en"] as const) {
    it(`prints the shared sentence once, in the caution tone (${lang})`, () => {
      renderOne(lever("eur_ron", SAME), lang);
      fireEvent.click(screen.getByTestId("cockpit-levers-more"));
      const card = screen.getByTestId("cockpit-lever-eur_ron");
      const text = card.textContent ?? "";
      const sentence = SAME[lang];
      expect(text.split(sentence).length - 1).toBe(1);
      expect(within(card).queryByTestId("cockpit-lever-eur_ron-inert")).toBeNull();
      expect(within(card).getByTestId("cockpit-lever-eur_ron-basis").className).toContain("text-caution");
      expect(card.getAttribute("data-inert")).toBe("true");
    });
  }

  it("keeps a different inert sentence beneath the basis", () => {
    const other = { ro: "nu are efect până nu setezi ponderea", en: "has no effect until you set the share" };
    renderOne(lever("eur_ron", other), "en");
    fireEvent.click(screen.getByTestId("cockpit-levers-more"));
    const card = screen.getByTestId("cockpit-lever-eur_ron");
    expect(within(card).getByTestId("cockpit-lever-eur_ron-basis").textContent).toBe(SAME.en);
    expect(within(card).getByTestId("cockpit-lever-eur_ron-inert").textContent).toBe(other.en);
    expect(within(card).getByTestId("cockpit-lever-eur_ron-basis").className).not.toContain("text-caution");
  });

  it("prints no inert line and no caution tone when the engine serves none", () => {
    renderOne(lever("eur_ron", null), "en");
    fireEvent.click(screen.getByTestId("cockpit-levers-more"));
    const card = screen.getByTestId("cockpit-lever-eur_ron");
    expect(within(card).queryByTestId("cockpit-lever-eur_ron-inert")).toBeNull();
    expect(card.getAttribute("data-inert")).toBe("false");
  });
});
