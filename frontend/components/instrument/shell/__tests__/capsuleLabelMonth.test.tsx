// The header capsule names the company on screen and, beside it, only a
// month it can RESOLVE (2026-09-21).
//
// It used to fall back to today's month whenever no month resolved — safe
// while every workspace carried a permanent, empty current-month period. G4
// deleted that period's creator (no period without an analysed file), so the
// fallback printed "Agras SRL · Sept 2026" over a company whose only year is
// 2025: for the ~2 s a freshly loaded company page waits for its period list
// (seen in the workspace_v2 screenshots), and for good on a company with no
// analysed year.
//
// Reds on: any label that carries a month the stepper did not resolve; a
// resolved month left out; the company name missing.
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const stepper = vi.hoisted(() => ({ selectedEnd: null as string | null }));
const workspace = vi.hoisted(() => ({ name: "Agras SRL" }));

vi.mock("@/lib/usePeriodStepper", () => ({
  usePeriodStepper: () => ({
    periods: [],
    selectedEnd: stepper.selectedEnd,
    selectedMonth: null,
    selectedYear: null,
    prevTarget: null,
    nextTarget: null,
    showStepper: false,
    goToPeriod: () => {},
  }),
}));
vi.mock("@/lib/workspaceName", () => ({ useWorkspaceName: () => workspace.name }));
vi.mock("@/lib/locale", () => ({ useActiveLocale: () => "en-GB" }));

import { useCapsuleLabel } from "../ContextObject";
import { currentMonthEnd, formatPeriodMonth } from "@/lib/orgPeriods";

afterEach(() => {
  stepper.selectedEnd = null;
  workspace.name = "Agras SRL";
});

describe("the header capsule never names a month it cannot resolve", () => {
  it("no resolvable month (list loading, or no analysed year): the company alone, never today's month", () => {
    const { result } = renderHook(() => useCapsuleLabel());
    const today = formatPeriodMonth(currentMonthEnd(), "en-GB") as string;
    expect(result.current).toBe("Agras SRL");
    expect(result.current).not.toContain(today);
    expect(result.current).not.toContain("·");
  });

  it("a resolved month is printed beside the company", () => {
    stepper.selectedEnd = "2025-12-31";
    const { result } = renderHook(() => useCapsuleLabel());
    expect(result.current).toBe("Agras SRL · Dec 2025");
  });

  it("no name yet (first paint): the resolved month alone, or nothing", () => {
    workspace.name = "";
    expect(renderHook(() => useCapsuleLabel()).result.current).toBe("");
    stepper.selectedEnd = "2025-12-31";
    expect(renderHook(() => useCapsuleLabel()).result.current).toBe("Dec 2025");
  });
});
