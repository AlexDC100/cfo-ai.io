// The ONE sign-in surface inside the native shell (2026-09-09 per operator):
// the onboarding's last slide transitions into it, and /login + /signup
// render it instead of their browser layouts. Full-screen, edge to edge,
// the whole page scrolls (keyboard-friendly) and content fades out under
// the top edge; the lockup + a bare AuthCard, with an in-page Back.

import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AuthCard } from "@/components/cfo/AuthCard";
import { postToNativeShell } from "@/lib/nativeShell";

const TOP_INSET = "env(safe-area-inset-top)";

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-label="CFO AI">
      <path className="ob-fill-accent" d="M 30 4 L 4 20 L 4 44 L 30 60 L 30 50 L 14 41 L 14 23 L 30 14 Z" />
      <path className="ob-fill-ink" d="M 38 14 L 60 60 L 48 60 L 38 38 Z" />
      <rect className="ob-fill-ink" x="34" y="34" width="14" height="3" />
    </svg>
  );
}

export function Brand({ innerRef }: { innerRef?: RefObject<HTMLDivElement> }) {
  return (
    <div ref={innerRef} className="flex shrink-0 items-center justify-center gap-2" data-testid="onboarding-brand">
      <Mark size={42} />
      <span className="font-sans text-[34px] font-bold tracking-[-.025em]">
        CFO <span className="ob-accent">AI</span>
      </span>
    </div>
  );
}

/** Fills its parent (a flex column). `brandRef` lets the onboarding FLIP
 *  the lockup from the slide into this layout. */
export function AuthPanel({
  initialMode,
  onBack,
  onAuthenticated,
  brandRef,
}: {
  initialMode: "sign_in" | "sign_up";
  onBack: () => void;
  onAuthenticated: () => void;
  brandRef?: RefObject<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  // Once the page has scrolled, Back sits on a themed pill with a shadow
  // so it stays legible over the content passing under it (2026-09-09).
  const [scrolled, setScrolled] = useState(false);
  // Back steps out of "create account" into "sign in" first, then leaves
  // the screen (2026-09-09 per operator).
  const [mode, setMode] = useState<"sign_in" | "sign_up">(initialMode);
  const back = () => {
    if (mode === "sign_up") setMode("sign_in");
    else onBack();
  };
  return (
    <div className="relative flex-1 min-h-0" data-testid="onboarding-auth" data-mode={mode}>
      {/* The scroller spans the full width (no side padding) so the
          scrollbar hugs the screen edge instead of the fields; the inner
          column carries the horizontal inset. */}
      <div
        className="h-full overflow-y-auto overscroll-contain"
        data-testid="auth-scroller"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 6)}
        style={{ paddingTop: `calc(${TOP_INSET} + 76px)`, paddingBottom: "calc(env(safe-area-inset-bottom) + 24px)" }}
      >
        <div className="px-[26px]">
        <Brand innerRef={brandRef} />
        <div className="ob-a-fade mt-5 flex justify-center" style={{ animationDelay: ".2s" }}>
          <AuthCard
            bare
            tabsHidden
            oauthPlacement="below"
            initialMode={initialMode}
            mode={mode}
            onModeChange={setMode}
            subtitle={mode === "sign_up" ? t("authX.subtitle_sign_up_page") : t("authX.subtitle_sign_in_page")}
            onAuthenticated={onAuthenticated}
          />
        </div>
        </div>
      </div>
      {/* Content scrolls under the top edge and fades out beneath the Back. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: `calc(${TOP_INSET} + 72px)`,
          background: "linear-gradient(to bottom, hsl(var(--bg)) 0%, hsl(var(--bg)) 45%, hsl(var(--bg) / 0) 100%)",
        }}
      />
      {/* Same text position as the slides' Back (26px in, 28px down):
          the pill's padding is offset out of left/top so only the
          background appears on scroll — the text never moves. */}
      <button
        type="button"
        onClick={back}
        data-scrolled={scrolled ? "true" : "false"}
        className={`ob-mute absolute left-[14px] rounded-full border px-3 py-2 font-mono text-[11px] uppercase tracking-[.06em] transition-[background-color,box-shadow,border-color] duration-200 ${
          scrolled ? "border-rule bg-surface text-ink shadow-md" : "border-transparent"
        }`}
        style={{ top: `calc(${TOP_INSET} + 20px)` }}
        data-testid="onboarding-back"
      >
        ← {t("firstRun.btnBack")}
      </button>
    </div>
  );
}

/** Route-level screen: what /login and /signup show inside the shell. */
export function MobileAuthScreen({ initialMode, next }: { initialMode: "sign_in" | "sign_up"; next: string }) {
  const navigate = useNavigate();
  // No native chrome here — the screen carries its own Back.
  useEffect(() => {
    postToNativeShell({ source: "cfo-ai", type: "chrome", burger: false, back: false });
  }, []);
  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/dashboard");
  };
  return (
    <div className="ob-screen ob-flush font-sans" data-testid="mobile-auth-screen">
      <AuthPanel initialMode={initialMode} onBack={goBack} onAuthenticated={() => navigate(next)} />
    </div>
  );
}
