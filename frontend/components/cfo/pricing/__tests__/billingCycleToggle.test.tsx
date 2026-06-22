// BillingCycleToggle — proves Monthly is selectable and Annual stays
// disabled with a "Coming soon" badge until `annualEnabled` flips.
// Spec §5: "If annual pricing is not implemented: show monthly only OR
// show annual as Coming soon. Do not make annual clickable if backend
// is not wired."

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { BillingCycleToggle } from "../BillingCycleToggle";

describe("BillingCycleToggle", () => {
  it("renders Monthly active and Annual as Coming soon by default", () => {
    render(<BillingCycleToggle value="monthly" onChange={vi.fn()} />);

    const monthly = screen.getByTestId("billing-cycle-monthly");
    expect(monthly.getAttribute("data-active")).toBe("true");
    expect(monthly.hasAttribute("disabled")).toBe(false);

    const annual = screen.getByTestId("billing-cycle-annual");
    expect(annual.getAttribute("disabled")).not.toBeNull();
    expect(annual.getAttribute("aria-disabled")).toBe("true");

    expect(screen.getByTestId("billing-cycle-annual-coming-soon")).toBeTruthy();
  });

  it("does NOT call onChange when Annual is clicked while disabled", () => {
    const onChange = vi.fn();
    render(<BillingCycleToggle value="monthly" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("billing-cycle-annual"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls onChange when Monthly is clicked", () => {
    const onChange = vi.fn();
    render(<BillingCycleToggle value="annual" onChange={onChange} annualEnabled />);
    fireEvent.click(screen.getByTestId("billing-cycle-monthly"));
    expect(onChange).toHaveBeenCalledWith("monthly");
  });

  it("makes Annual clickable when annualEnabled=true", () => {
    const onChange = vi.fn();
    render(<BillingCycleToggle value="monthly" onChange={onChange} annualEnabled />);
    expect(screen.queryByTestId("billing-cycle-annual-coming-soon")).toBeNull();
    fireEvent.click(screen.getByTestId("billing-cycle-annual"));
    expect(onChange).toHaveBeenCalledWith("annual");
  });
});
