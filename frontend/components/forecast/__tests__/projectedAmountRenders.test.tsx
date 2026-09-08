// B3, CONFIRMED AT THE DOM (TC-7) — what a projected figure ACTUALLY paints.
//
// The type barrier proves a projection cannot reach an actuals primitive. The
// static gate proves the sanctioned primitive still carries its mark. Neither
// proves what a reader sees, and "the class is applied" is not the same claim
// as "the mark is in the document beside the number". This renders it.
//
// ── WHAT IT REDS ON, AFTER THE REPAIR (TC-11) ───────────────────────────
//
//   · a projected figure painting its number without the projected mark in
//     the same element subtree;
//   · the marker's period, basis and base period not reaching the DOM, so a
//     wave-2 export or an e2e spec has nothing to assert on;
//   · a REFUSAL painting a number — a projection that does not carry a line
//     must render an em dash and a reason, never a zero;
//   · a projected figure with an empty basis painting anything numeric;
//   · the engine's OWN SERVED BYTES painting an em dash. That is not a
//     hypothetical: measured before this repair, `readProjection(gateway
//     .as_dict())` refused all 15 figures with `no_assumptions_behind_it`,
//     so every projected figure on every surface would have rendered "—"
//     while the engine held the number and considered it served. Nothing
//     rendered the served shape, because nothing read it;
//   · a driver's VALUE not reaching the basis affordance — the wire form
//     used to drop the `values` schedule, so a reader who opened the
//     assumptions saw a driver name and no number beside it.
//
// ── WHAT IT CANNOT SEE (TC-11) ──────────────────────────────────────────
//
//   · whether the mark is legible, or placed where a reader looks. That is a
//     design question for a live spec, not a DOM assertion.
//   · what the PDF and XLSX renderers do — wave 2. They consume the same
//     marker object, which is the reason the distinction is carried by data.
//   · the REAL projection's figures. These render the stand-in payload's 15
//     (and the served form of those same 15), because the real producer
//     states no per-figure attribution yet and so serves nothing — see
//     `test_the_adapter_never_invents_attribution`. When it does, this file
//     needs a case over the adapter's output; nothing here would red first.

import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ProjectedAmount } from "../ProjectedAmount";
import {
  isProjectedFigure,
  readProjection,
  type ProjectedFigure,
  type ProjectionRefusal,
} from "@/lib/forecastFacts";

const FP1 = resolve(
  __dirname,
  "../../../../tests/engine/fixtures/forecast/fp1_agras.json",
);

const view = () => {
  const v = readProjection(JSON.parse(readFileSync(FP1, "utf8")));
  if (!v) throw new Error("fixture did not read as a projection");
  return v;
};

const plain = (value: number) => value.toFixed(2);

describe("<ProjectedAmount>", () => {
  it("paints the number and the projected mark together", () => {
    const figure = view().figure("revenue", "FY+1");
    expect(isProjectedFigure(figure)).toBe(true);
    const { container } = render(
      <ProjectedAmount
        figure={figure}
        basePeriodLabel="Imported period"
        format={plain}
        projectedLabel="projected"
      />,
    );
    // 118,576,819.64 grown 8% — the same figure the engine gate measures.
    expect(screen.getByText("128062965.21")).toBeTruthy();

    const root = container.querySelector('[data-projected="true"]');
    expect(root).toBeTruthy();
    const value = root!.querySelector('[data-projected-value="true"]');
    const mark = root!.querySelector('[data-projected-mark="true"]');
    expect(value).toBeTruthy();
    expect(mark).toBeTruthy();
    expect(mark!.textContent).toBe("projected");
    // The mark is INSIDE the same element as the value, so no layout,
    // stylesheet or export path can carry one without the other.
    expect(root!.contains(value!)).toBe(true);
    expect(root!.contains(mark!)).toBe(true);
  });

  it("puts the marker's period, basis and base period into the DOM", () => {
    const { container } = render(
      <ProjectedAmount
        figure={view().figure("ebitda", "FY+2")}
        basePeriodLabel="Imported period"
        format={plain}
      />,
    );
    const root = container.querySelector('[data-projected="true"]')!;
    expect(root.getAttribute("data-projected-period")).toBe("FY+2");
    expect(root.getAttribute("data-projected-base-period")).toBe(
      "Imported period",
    );
    expect(root.getAttribute("data-projected-basis")).toBe(
      "revenue_growth,ebitda_margin",
    );
  });

  it("renders a refusal as an em dash with its code, never as a zero", () => {
    const refusal = view().figure("goodwill", "FY+1") as ProjectionRefusal;
    const { container } = render(
      <ProjectedAmount
        figure={refusal}
        basePeriodLabel="Imported period"
        format={plain}
      />,
    );
    const node = container.querySelector('[data-projected="refused"]')!;
    expect(node.textContent).toBe("—");
    expect(node.getAttribute("data-projected-code")).toBe("not_projected");
    expect(container.textContent).not.toContain("0");
  });

  it("refuses to paint a hand-built figure whose basis is empty", () => {
    // `readProjection` cannot produce this — it returns a refusal — but the
    // interface is public, and a projected number with nothing behind it must
    // never reach a reader whatever built it.
    const handBuilt = {
      ...(view().figure("revenue", "FY+1") as ProjectedFigure),
      basis: [],
    } as ProjectedFigure;
    const { container } = render(
      <ProjectedAmount
        figure={handBuilt}
        basePeriodLabel="Imported period"
        format={plain}
      />,
    );
    expect(container.textContent).toBe("—");
    expect(
      container
        .querySelector("[data-projected]")!
        .getAttribute("data-projected-code"),
    ).toBe("no_assumptions_behind_it");
  });

  it("the basis affordance receives the drivers, their values and their bases", () => {
    render(
      <ProjectedAmount
        figure={view().figure("revenue", "FY+3")}
        basePeriodLabel="Imported period"
        format={plain}
        renderBasis={(marker) => (
          <span data-testid="basis">
            {marker.basis
              .map((a) => `${a.id}=${a.value} (${a.basis.slice(0, 8)})`)
              .join("|")}
          </span>
        )}
      />,
    );
    const basis = screen.getByTestId("basis").textContent ?? "";
    expect(basis).toContain("revenue_growth=0.05");
    expect(basis).toContain("Held fla");
  });
});

// ─── W1, AT THE DOM: the em-dash that would have shipped ────────────────
//
// Every test above reads the INPUT payload the engine is HANDED. A browser
// receives the WIRE form — `ProjectionGateway.as_dict()` — and until this
// repair those were different shapes and this component could not paint the
// second one.
//
// MEASURED on the engine's own served bytes, before the repair:
//   readProjection(gateway.as_dict()).figures()
//     -> 15 figures, 0 served, 15 refused, all `no_assumptions_behind_it`
//   and the branch at ProjectedAmount.tsx:86 paints each of those as "—".
//
// So this is the assertion the wave was missing: not "the marker reaches the
// DOM" but "a NUMBER reaches the DOM at all, from the bytes that actually
// arrive". It is written against the committed served fixture, which the
// Python suite pins to the gateway's real output, so it cannot drift into
// testing a hand-kept shape.

const FP1_SERVED = resolve(
  __dirname,
  "../../../../tests/engine/fixtures/forecast/fp1_agras_served.json",
);

describe("<ProjectedAmount> over the bytes the engine actually serves", () => {
  const servedView = () => {
    const v = readProjection(JSON.parse(readFileSync(FP1_SERVED, "utf8")));
    if (!v) throw new Error("the served fixture did not read as a projection");
    return v;
  };

  it("paints the NUMBER, not an em dash", () => {
    const figure = servedView().figure("revenue", "FY+1");
    expect(
      isProjectedFigure(figure),
      `the engine's own served bytes came back REFUSED — ` +
        `${JSON.stringify(figure)} — so this figure paints an em dash while ` +
        `the engine holds the number and considers it served`,
    ).toBe(true);
    const { container } = render(
      <ProjectedAmount
        figure={figure}
        basePeriodLabel="Imported period"
        format={plain}
      />,
    );
    const value = container.querySelector("[data-projected-value]");
    expect(value?.textContent).toBe("128062965.21");
    expect(container.textContent).not.toContain("—");
    expect(
      container.querySelector('[data-projected="refused"]'),
    ).toBeNull();
    expect(
      container.querySelector("[data-projected-mark]")?.textContent,
    ).toBe("projected");
  });

  it("every served figure paints a number and none refuses", () => {
    const painted: string[] = [];
    for (const figure of servedView().figures()) {
      const { container } = render(
        <ProjectedAmount
          figure={figure as ProjectedFigure | ProjectionRefusal}
          basePeriodLabel="Imported period"
          format={plain}
        />,
      );
      const refused = container.querySelector('[data-projected="refused"]');
      expect(
        refused && refused.getAttribute("data-projected-code"),
        "a figure the engine served painted an em dash instead of its number",
      ).toBeNull();
      const value = container.querySelector("[data-projected-value]");
      expect(value, "no number reached the DOM for a served figure").not
        .toBeNull();
      painted.push(value!.textContent ?? "");
    }
    expect(painted.length).toBe(15);
    // A real number, sign included — the stand-in's `total_liabilities` runs
    // negative once retained EBITDA exceeds the asset base, and a gate that
    // demanded a leading digit would red on a correct projection.
    const notNumeric = painted.filter((t) => !Number.isFinite(Number(t)));
    expect(notNumeric).toEqual([]);
  });

  it("the driver VALUE reaches the reader, not a blank", () => {
    // The other half of W1: the wire form used to drop the `values` schedule,
    // so a reader who opened the assumptions saw the driver's name and no
    // number beside it — ABSENT, when the payload stated 0.08.
    const figure = servedView().figure("revenue", "FY+1");
    if (!isProjectedFigure(figure)) {
      throw new Error(
        `the served bytes refused revenue/FY+1: ${JSON.stringify(figure)}`,
      );
    }
    render(
      <ProjectedAmount
        figure={figure}
        basePeriodLabel="Imported period"
        format={plain}
        renderBasis={(marker) => (
          <span data-testid="basis">
            {marker.basis
              .map((a) => `${a.id}=${a.value === null ? "not stated" : a.value}`)
              .join(", ")}
          </span>
        )}
      />,
    );
    expect(screen.getByTestId("basis").textContent).toBe(
      "revenue_growth=0.08",
    );
  });
});
