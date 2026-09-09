// The auth gate's marketing header must not render inside the native shell
// (mobile/). Its burger opens the MARKETING nav, which on the app's login
// screen reads as the app's own navigation and leads nowhere useful.
//
// `isNativeShell()` keys off window.ReactNativeWebView, which react-native-
// webview injects into every page the shell hosts — so the two cases below
// are exactly "in the app" vs "in a browser".

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Landing is a very large module and MarketingHeader dumps the whole site
// CSS + header markup; stub it down to a probe. AuthCard needs Supabase and
// auth context we don't exercise here.
vi.mock("../Landing", () => ({
  MarketingHeader: () => <div data-testid="marketing-header" />,
}));
vi.mock("@/components/cfo/AuthCard", () => ({
  AuthCard: () => <div data-testid="auth-card" />,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import Login from "../Login";

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Login />
    </MemoryRouter>,
  );
}

afterEach(() => {
  delete (window as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

describe("/login marketing header", () => {
  it("renders in a normal browser", () => {
    renderLogin();
    expect(screen.getByTestId("marketing-header")).toBeInTheDocument();
    expect(screen.getByTestId("auth-card")).toBeInTheDocument();
  });

  it("is hidden inside the native shell", () => {
    (window as { ReactNativeWebView?: unknown }).ReactNativeWebView = {
      postMessage: () => {},
    };
    renderLogin();
    expect(screen.queryByTestId("marketing-header")).toBeNull();
    // The card itself must survive — hiding chrome must not hide the gate.
    expect(screen.getByTestId("auth-card")).toBeInTheDocument();
  });
});
