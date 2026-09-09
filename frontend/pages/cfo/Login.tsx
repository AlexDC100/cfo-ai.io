// /login — standalone sign-in page.
//
// Layout: dark canvas matching the landing hero's background, the landing
// page's own tab bar (MarketingHeader), centered AuthCard.
//
// Inside the native shell (mobile/) the MarketingHeader is not rendered:
// its burger opens the MARKETING nav (pricing, legal, "Get started"), which
// is dead weight on the app's auth gate — and it reads as the app's own
// navigation while there is no session to navigate. Same rule the app shell
// already applies to TopHeader (see AppShell's `inNativeShell`). Inert in a
// normal browser.

import { useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { AuthCard } from "@/components/cfo/AuthCard";
import { MarketingHeader } from "./Landing";
import { NATIVE_ACTION_EVENT, isNativeShell, postToNativeShell } from "@/lib/nativeShell";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  // Optional return path (e.g. the landing page sends ?next=/ so the user
  // comes back to it after signing in). Internal paths only — a value not
  // starting with a single "/" is ignored to rule out open redirects.
  const rawNext = searchParams.get("next");
  const next = rawNext && /^\/(?!\/)/.test(rawNext) ? rawNext : "/dashboard";
  // Landing's "Get started" CTAs link here with ?mode=sign_up so the card
  // opens straight to account creation instead of sign-in.
  const initialMode = searchParams.get("mode") === "sign_up" ? "sign_up" : "sign_in";
  const inNativeShell = isNativeShell();

  // Back to the page the visitor was browsing (2026-09-04 per operator) —
  // guest mode sends people here mid-session. History-back when this tab
  // has somewhere to go back to; a cold open (shell reload straight into
  // /login) falls back to the sanitized `next` target instead of a dead end.
  const goBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate(next);
  }, [navigate, next]);

  // Inside the native shell the page's own back button is replaced by the
  // shell's floating glass button in BACK mode (2026-09-08 per operator) —
  // the same disc that is the burger everywhere else, so the auth gate has
  // exactly one navigation affordance and it sits where the burger does.
  // Off again on unmount so the button doesn't outlive the page.
  useEffect(() => {
    if (!inNativeShell) return undefined;
    postToNativeShell({ source: "cfo-ai", type: "chrome", burger: false, back: true });
    function onAction(e: Event) {
      const action = (e as CustomEvent<{ action?: string }>).detail?.action;
      if (action === "back") goBack();
    }
    window.addEventListener(NATIVE_ACTION_EVENT, onAction as EventListener);
    return () => {
      window.removeEventListener(NATIVE_ACTION_EVENT, onAction as EventListener);
      postToNativeShell({ source: "cfo-ai", type: "chrome", burger: false, back: false });
    };
  }, [inNativeShell, goBack]);

  return (
    <div
      className="min-h-screen text-ink flex flex-col"
      style={
        // In the shell the page is transparent: the shell paints the static
        // canvas + spotlight behind the WebView (the same background every
        // tab has), and painting a second one here doubled it up.
        inNativeShell
          ? { paddingTop: "env(safe-area-inset-top)" }
          : {
              background:
                "radial-gradient(ellipse 70% 60% at 50% 0%, hsl(var(--brand) / 0.10), transparent 60%), hsl(var(--bg))",
            }
      }
    >
      {!inNativeShell && <MarketingHeader />}

      <main className="flex-1 flex items-center justify-center px-5 py-10 sm:py-16">
        <div className="w-full max-w-[440px]">
          {!inNativeShell && (
          <button
            type="button"
            data-testid="login-back"
            onClick={goBack}
            className="mb-4 inline-flex items-center gap-1.5 min-h-[44px] sm:min-h-0 sm:h-9 -ml-2 px-2 rounded-sm text-[13px] text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft size={15} strokeWidth={1.75} className="shrink-0" />
            {t("common.back")}
          </button>
          )}
          <AuthCard
            initialMode={initialMode}
            tabsHidden={false}
            subtitle={initialMode === "sign_up" ? t("authX.subtitle_sign_up") : t("authX.subtitle_sign_in_page")}
            onAuthenticated={() => navigate(next)}
          />
        </div>
      </main>
    </div>
  );
}
