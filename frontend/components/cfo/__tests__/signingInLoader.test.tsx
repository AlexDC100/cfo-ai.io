// "Signing you in…" is never an endless spinner.
//
// Reading the session takes supabase-js's auth Web Lock, which every tab of
// the origin shares. On 2026-09-26 one looping tab queued 35,066 requests on
// it, and every other CFO AI tab sat on "Signing you in…" with nothing to
// tell a stuck lock from a slow network. After SIGNING_IN_HINT_AFTER_MS the
// loader says what to do and offers the reload, in the reader's language.
//
// Fails on: no hint after 12 s; a hint before it; no reload action; English
// words on a Romanian screen.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";

const auth = vi.hoisted(() => ({ status: "loading" as string }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ status: auth.status, isAuthenticated: auth.status === "signed_in" }),
}));
vi.mock("@/lib/org", () => ({
  useActiveOrg: () => ({ orgs: [], archived: [], loading: false, loadError: false }),
}));

const { AuthGuard, SIGNING_IN_HINT_AFTER_MS } = await import("@/components/cfo/AuthGuard");

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={["/workspace/x"]}>
      <AuthGuard>
        <div data-testid="page" />
      </AuthGuard>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  auth.status = "loading";
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await i18n.changeLanguage("en");
});

describe("the sign-in loader explains itself after 12 s", () => {
  it("says 'Signing you in…', then the hint and a reload button — not before", () => {
    renderGuard();
    expect(screen.getByTestId("app-loader").textContent).toContain("Signing you in…");
    act(() => {
      vi.advanceTimersByTime(SIGNING_IN_HINT_AFTER_MS - 1);
    });
    expect(screen.queryByTestId("signing-in-stuck")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const hint = screen.getByTestId("signing-in-stuck");
    expect(hint.textContent).toContain("Still signing you in — close other CFO AI tabs or reload.");
    expect(SIGNING_IN_HINT_AFTER_MS).toBe(12_000);

    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, reload } });
    try {
      fireEvent.click(screen.getByTestId("signing-in-reload"));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("page")).toBeNull();
  });

  it("speaks Romanian to a Romanian reader", async () => {
    await act(async () => {
      await i18n.changeLanguage("ro");
    });
    renderGuard();
    expect(screen.getByTestId("app-loader").textContent).toContain("Te conectăm…");
    act(() => {
      vi.advanceTimersByTime(SIGNING_IN_HINT_AFTER_MS);
    });
    expect(screen.getByTestId("signing-in-stuck").textContent).toContain(
      "Încă te conectăm — închide celelalte file CFO AI sau reîncarcă pagina.",
    );
    expect(screen.getByTestId("signing-in-reload").textContent).toContain("Reîncarcă");
  });

  it("a session that lands renders the page, and no hint is left behind", () => {
    const r = renderGuard();
    auth.status = "signed_in";
    r.rerender(
      <MemoryRouter initialEntries={["/workspace/x"]}>
        <AuthGuard>
          <div data-testid="page" />
        </AuthGuard>
      </MemoryRouter>,
    );
    act(() => {
      vi.advanceTimersByTime(SIGNING_IN_HINT_AFTER_MS * 2);
    });
    expect(screen.getByTestId("page")).toBeTruthy();
    expect(screen.queryByTestId("signing-in-stuck")).toBeNull();
  });
});
