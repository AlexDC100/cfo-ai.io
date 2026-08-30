// PM-UI document rendering — against REAL bytes.
//
// The fixture is the verbatim body of
// `GET /api/public/markets/company/us/AAPL` from this repo's own spine
// store (Apple's SEC companyfacts document, pm1 envelope). Rendering
// against a hand-written mock would prove only that the mock matches the
// component; the whole reason this wave has real SEC bytes committed is
// that hand-written doubles have hidden total outages here before.
//
// Fixture refresh:
//   .venv/bin/python -c "..."  → see the wave report; the body is the
//   route's response verbatim, pretty-printed with sorted keys.

import { render as rtlRender, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { MarketCompanyDocumentView, figureMajor } from "../MarketSurface";
import type { MarketCompanyDocument } from "@/lib/marketApi";
import fixture from "./fixtures/us_AAPL_pm1.json";

const doc = fixture as unknown as MarketCompanyDocument;

// App.tsx wraps the whole tree in TooltipProvider; mirror that here so
// the provenance affordance renders exactly as it does in the app.
const render = (ui: React.ReactElement) =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

describe("minor units — the scale is read, never guessed", () => {
  it("converts a named minor unit", () => {
    expect(
      figureMajor({ value_minor: 123456, currency: "USD", minor_unit: "cent" }),
    ).toBe(1234.56);
  });

  it("falls back to the ISO exponent of the document's own currency", () => {
    expect(figureMajor({ value_minor: 123456, currency: "RON" })).toBe(1234.56);
  });

  it("refuses a currency it has no exponent for, rather than assuming 100", () => {
    // A zero-decimal currency divided by 100 is wrong by 100x and looks
    // completely plausible on screen. Refusing is the only safe default.
    expect(figureMajor({ value_minor: 5000, currency: "JPY" })).toBeNull();
    expect(figureMajor({ value_minor: 5000, minor_unit: "fils" })).toBeNull();
  });

  it("refuses a non-integer minor value", () => {
    expect(figureMajor({ value_minor: 12.5, currency: "USD" })).toBeNull();
  });
});

describe("a real pm1 document renders from the document alone", () => {
  it("names the entity from the payload, not from the ticker we asked for", () => {
    render(<MarketCompanyDocumentView result={{ ok: true, document: doc }} />);
    expect(screen.getByText("Apple Inc.")).toBeInTheDocument();
  });

  it("carries the market and currency chips", () => {
    render(<MarketCompanyDocumentView result={{ ok: true, document: doc }} />);
    expect(screen.getByText("US")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
  });

  it("renders every figure the envelope carries", () => {
    render(<MarketCompanyDocumentView result={{ ok: true, document: doc }} />);
    for (const key of Object.keys(doc.envelope.figures ?? {})) {
      const label = key
        .split("_")
        .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
        .join(" ");
      expect(screen.getByText(label), key).toBeInTheDocument();
    }
  });

  it("gives every sourced figure the provenance affordance, and only those", () => {
    const { container } = render(
      <MarketCompanyDocumentView result={{ ok: true, document: doc }} />,
    );
    const figures = doc.envelope.figures ?? {};
    const sourced = Object.values(figures).filter((f) => !!f.provenance).length;
    expect(sourced).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-provenance="true"]').length).toBe(sourced);
  });

  it("shows no price line when the document carries no price block", () => {
    // US price_source is a licensed provider slot with no key today, so
    // the envelope has no `price`. Borrowing a quote from anywhere else
    // would attach an unlicensed number to a licensed surface.
    expect(doc.envelope.price).toBeUndefined();
    render(<MarketCompanyDocumentView result={{ ok: true, document: doc }} />);
    expect(screen.queryByText(/^Price$/i)).toBeNull();
  });

  it("never glues a magnitude letter onto the currency code", () => {
    // r2 shipped "416.16 BUSD" — a magnitude-scaled figure carrying an
    // inline symbol. BUSD is not a currency. The block declares the
    // currency once instead, in its own caption.
    const { container } = render(
      <MarketCompanyDocumentView result={{ ok: true, document: doc }} />,
    );
    // No word boundaries here on purpose: textContent concatenates
    // adjacent chips ("US" + "USD" -> "USUSD"), so a \b-anchored match
    // would fail on the rendering that is actually correct.
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[KMBT](USD|EUR|GBP|RON|CNY|AED)/);
    // …and the currency is still stated, as its own chip.
    expect(screen.getByText("USD")).toBeInTheDocument();
  });

  it("shows the serving tier's source line verbatim", () => {
    const line = doc.presentation?.source_line;
    expect(line).toBeTruthy();
    render(<MarketCompanyDocumentView result={{ ok: true, document: doc }} />);
    expect(screen.getByText(line!)).toBeInTheDocument();
  });
});
