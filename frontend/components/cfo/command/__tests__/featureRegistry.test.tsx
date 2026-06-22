// Phase 9 unit tests for the feature-registry-driven Row primitive.
//
// What we're guarding against:
//   · A row with featureKey="erp_connector" must render as Coming soon
//     (badge present, onClick suppressed).
//   · A row whose feature resolves to `hidden` must render NOTHING.
//   · A row whose feature is `active` must be clickable.
//
// We mock the registry via `__setFeaturesForTest` so these tests run
// without a backend.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Sparkles } from "lucide-react";

import { Row } from "../Row";
import {
  __setFeaturesForTest,
  __clearFeaturesForTest,
} from "@/lib/features";

beforeEach(() => {
  cleanup();
  __clearFeaturesForTest();
});

describe("Row + feature registry gating", () => {
  it("renders an active row as clickable with a chevron", () => {
    __setFeaturesForTest({
      ask_cfo_ai: { status: "active", label: "Ask CFO AI", description: "" },
    });
    const onClick = vi.fn();
    render(
      <Row
        icon={Sparkles}
        title="Open chat"
        featureKey="ask_cfo_ai"
        onClick={onClick}
      />,
    );
    const btn = screen.getByRole("button", { name: /open chat/i });
    expect(btn.getAttribute("data-status")).toBe("active");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders coming_soon rows with the badge and suppresses onClick", () => {
    __setFeaturesForTest({
      erp_connector: { status: "coming_soon", label: "ERP", description: "" },
    });
    const onClick = vi.fn();
    render(
      <Row
        icon={Sparkles}
        title="ERP connector"
        featureKey="erp_connector"
        onClick={onClick}
      />,
    );
    const btn = screen.getByRole("button", { name: /erp connector/i });
    expect(btn.getAttribute("data-status")).toBe("coming_soon");
    // The badge is present
    expect(screen.getByTestId("coming-soon-badge")).toBeTruthy();
    // Click is wired to undefined for coming_soon rows.
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders NOTHING when the feature status is hidden", () => {
    __setFeaturesForTest({
      decisions: { status: "hidden", label: "Decisions", description: "" },
    });
    const { container } = render(
      <Row icon={Sparkles} title="Decisions" featureKey="decisions" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders NOTHING when forceStatus is hidden, regardless of registry", () => {
    __setFeaturesForTest({
      ask_cfo_ai: { status: "active", label: "Ask CFO AI", description: "" },
    });
    const { container } = render(
      <Row
        icon={Sparkles}
        title="Open chat"
        featureKey="ask_cfo_ai"
        forceStatus="hidden"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("defaults to active when no featureKey or forceStatus is provided", () => {
    const onClick = vi.fn();
    render(<Row icon={Sparkles} title="Custom row" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /custom row/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
