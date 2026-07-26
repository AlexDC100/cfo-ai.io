// Currency toggle — the RON / EUR / USD segmented control in TopHeader.
//
// Operator-reported 2026-07-26: "make the RON EUR USD buttons work". This
// pins the two halves of "working": the click has to change the store, AND
// the change has to reach the money surfaces that consume it.

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";

import { CurrencyToggle } from "../CurrencyToggle";
import { CurrencyProvider, useCurrency } from "@/stores/currency";
import { Money } from "@/components/ui/Money";

function Harness() {
  return (
    <CurrencyProvider>
      <CurrencyToggle />
      <Money value={1000} fromCurrency="RON" compact={false} />
    </CurrencyProvider>
  );
}

function DisplayProbe() {
  const { display } = useCurrency();
  return <span data-testid="probe">{display}</span>;
}

describe("CurrencyToggle", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("switches the active segment when a currency is clicked", () => {
    render(
      <CurrencyProvider>
        <CurrencyToggle />
        <DisplayProbe />
      </CurrencyProvider>,
    );

    expect(screen.getByTestId("probe").textContent).toBe("RON");

    fireEvent.click(screen.getByTestId("currency-toggle-eur"));
    expect(screen.getByTestId("probe").textContent).toBe("EUR");
    expect(screen.getByTestId("currency-toggle-eur")).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByTestId("currency-toggle-usd"));
    expect(screen.getByTestId("probe").textContent).toBe("USD");
  });

  it("re-renders money surfaces in the chosen currency", () => {
    render(<Harness />);

    // Fallback rates: EUR 1.0 / RON 4.97 / USD 1.08 (lib/rates.ts).
    // 1000 RON → ~201.21 EUR → ~217.30 USD.
    expect(document.body.textContent).toMatch(/1\.000,00|1,000\.00/);

    fireEvent.click(screen.getByTestId("currency-toggle-eur"));
    expect(document.body.textContent).toMatch(/201/);

    fireEvent.click(screen.getByTestId("currency-toggle-usd"));
    expect(document.body.textContent).toMatch(/217/);
  });

  it("persists the choice so a remount keeps it", () => {
    const { unmount } = render(
      <CurrencyProvider>
        <CurrencyToggle />
        <DisplayProbe />
      </CurrencyProvider>,
    );
    fireEvent.click(screen.getByTestId("currency-toggle-eur"));
    unmount();

    render(
      <CurrencyProvider>
        <CurrencyToggle />
        <DisplayProbe />
      </CurrencyProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("EUR");
  });
});
