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
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/i18n";

const stepper = vi.hoisted(() => ({ selectedEnd: null as string | null }));
const workspace = vi.hoisted(() => ({ name: "Agras SRL" }));
const redesign = vi.hoisted(() => ({ on: false }));

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
vi.mock("@/lib/previewFeatures", () => ({ useWorkspaceV2: () => redesign.on }));

import { useCapsuleLabel } from "../ContextObject";
import { currentMonthEnd, formatPeriodMonth } from "@/lib/orgPeriods";

/** The hook reads the route: rendered under a router, at `route`. */
function at(route: string) {
  return ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
}
const renderLabel = (route = "/dashboard") => renderHook(() => useCapsuleLabel(), { wrapper: at(route) });

afterEach(() => {
  stepper.selectedEnd = null;
  workspace.name = "Agras SRL";
  redesign.on = false;
});

describe("the header capsule never names a month it cannot resolve", () => {
  it("no resolvable month (list loading, or no analysed year): the company alone, never today's month", () => {
    const { result } = renderLabel();
    const today = formatPeriodMonth(currentMonthEnd(), "en-GB") as string;
    expect(result.current).toBe("Agras SRL");
    expect(result.current).not.toContain(today);
    expect(result.current).not.toContain("·");
  });

  it("a resolved month is printed beside the company", () => {
    stepper.selectedEnd = "2025-12-31";
    const { result } = renderLabel();
    expect(result.current).toBe("Agras SRL · Dec 2025");
  });

  it("no name yet (first paint): the resolved month alone, or nothing", () => {
    workspace.name = "";
    expect(renderLabel().result.current).toBe("");
    stepper.selectedEnd = "2025-12-31";
    expect(renderLabel().result.current).toBe("Dec 2025");
  });
});

describe("the header describes the screen: Home is 'Your companies', not the last active company", () => {
  it("on /workspace with the redesign on, the capsule names the screen", () => {
    redesign.on = true;
    stepper.selectedEnd = "2025-12-31";
    expect(renderLabel("/workspace").result.current).toBe("Your companies");
  });

  it("a company page and the dashboard keep naming the company", () => {
    redesign.on = true;
    expect(renderLabel("/workspace/agras").result.current).toBe("Agras SRL");
    stepper.selectedEnd = "2025-12-31";
    expect(renderLabel("/dashboard?period=x").result.current).toBe("Agras SRL · Dec 2025");
  });

  it("with the redesign off, /workspace is the old Workspace tab: the company, as before", () => {
    expect(renderLabel("/workspace").result.current).toBe("Agras SRL");
  });
});
