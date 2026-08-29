// AuthCallback — the destination Supabase redirects to after a user clicks
// the confirmation link in their signup / password-reset / magic-link email.
//
// Why this page exists:
//
//   The Supabase email template inserts a link of the form
//     {{ .SiteURL }}/auth/callback#access_token=...&refresh_token=...&type=signup
//   (implicit flow — Supabase JS default in this project).
//
//   When supabase-js v2 boots with `detectSessionInUrl: true` (default), it
//   parses that fragment at createClient() time, exchanges it for a session,
//   and fires onAuthStateChange("SIGNED_IN", session). We just need a route
//   that *exists* at /auth/callback so the redirect lands somewhere visible,
//   wait for the SDK to do its work, then forward the user.
//
//   Before this page existed, `emailRedirectTo` was set to the site root,
//   which sent users back to the landing page with a long token-laden URL
//   fragment. The AuthProvider would silently pick up the session — but the
//   user saw the landing page (logged out marketing copy), not their first-
//   run experience. Half the time they bounced thinking nothing happened.
//
// Robustness considerations:
//
//   · Subscribe to onAuthStateChange AND call getSession() — whichever fires
//     first wins. This handles both "SDK has already exchanged" (rare) and
//     "SDK is mid-exchange" (common) without a race.
//   · 5s timeout — if no session materializes, the link expired or was
//     already used. Show an actionable error, not a spinner forever.
//   · Surface Supabase's own error_description from the URL (it appends
//     ?error=...&error_description=... when the link itself is malformed).
//   · Clean the hash from the URL once the session lands so a refresh
//     doesn't try to re-exchange the now-consumed token.
//   · Hash-based recovery type (?type=recovery) routes to a future
//     /auth/reset-password page; for signup it goes to /onboarding.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2, AlertTriangle, Mail } from "lucide-react";
import { getSupabase, supabaseEnabled } from "@/lib/supabase";

type Status = "loading" | "success" | "error";

export default function AuthCallback() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Verifying… · CFO AI";
  }, []);

  useEffect(() => {
    if (!supabaseEnabled) {
      setStatus("error");
      setErrorMsg(
        t(
          "authCallback.notConfigured",
          "Authentication isn't configured on this build.",
        ),
      );
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      setStatus("error");
      setErrorMsg(
        t(
          "authCallback.notConfigured",
          "Authentication isn't configured on this build.",
        ),
      );
      return;
    }

    // 1) Surface any Supabase-provided error before we wait. The link itself
    //    may have failed (expired, already used, bad signature) — Supabase
    //    encodes that as ?error_code=...&error_description=... or in the
    //    fragment. Decode and show it directly so the user knows whether
    //    to retry or contact support.
    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(
      window.location.hash.replace(/^#/, ""),
    );
    const errDesc =
      searchParams.get("error_description") ??
      hashParams.get("error_description");
    if (errDesc) {
      setStatus("error");
      setErrorMsg(decodeURIComponent(errDesc.replace(/\+/g, " ")));
      return;
    }

    // Track which next-step path applies. `type` is set by Supabase on the
    // hash for password recovery vs signup confirmation.
    const flowType = hashParams.get("type") ?? searchParams.get("type");

    let cancelled = false;
    let redirectTimer: number | null = null;

    const goSuccess = () => {
      if (cancelled) return;
      setStatus("success");
      // Strip the token fragment so a refresh doesn't try to re-consume it.
      if (window.location.hash) {
        window.history.replaceState({}, "", window.location.pathname);
      }
      // Small delay so the success state is visible (otherwise it flashes by).
      redirectTimer = window.setTimeout(() => {
        if (cancelled) return;
        // Recovery flow lands the user on a reset-password page; for now we
        // route to /login with a hint until that page ships. Everything else
        // (signup confirm, magic link, email change) goes through /onboarding
        // — THE DIAL's one-time role question. First-timers see it once;
        // everyone else is forwarded straight to the /workspace setup wizard
        // by the page's already-asked branch, so non-signup flows behave
        // exactly as they did when this navigated to /workspace directly.
        if (flowType === "recovery") {
          navigate("/login?reset=1", { replace: true });
        } else {
          navigate("/onboarding", { replace: true });
        }
      }, 700);
    };

    // 2) Subscribe BEFORE probing getSession — covers the case where the SDK
    //    finishes exchanging the fragment a few ms after this effect mounts.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (
        session &&
        (event === "SIGNED_IN" ||
          event === "INITIAL_SESSION" ||
          event === "TOKEN_REFRESHED")
      ) {
        goSuccess();
      }
    });

    // 3) Probe immediately in case createClient already did the exchange
    //    before this component mounted.
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) goSuccess();
    });

    // 4) Hard timeout — 5s is more than enough for the SDK to do its work.
    //    If we still don't have a session after that, the link is dead.
    const timeoutHandle = window.setTimeout(() => {
      if (cancelled) return;
      // setStatus uses functional form so we don't capture stale state.
      setStatus((current) => {
        if (current !== "loading") return current;
        setErrorMsg(
          t(
            "authCallback.expired",
            "We couldn't complete sign-in. The verification link may have expired or already been used.",
          ),
        );
        return "error";
      });
    }, 5000);

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      if (redirectTimer) window.clearTimeout(redirectTimer);
      window.clearTimeout(timeoutHandle);
    };
  }, [navigate, t]);

  return (
    <div className="min-h-screen bg-bg text-ink flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-[440px] rounded-3xl border border-rule bg-surface/80 backdrop-blur-xl p-7 sm:p-8 shadow-[0_32px_80px_-20px_rgba(0,0,0,0.5)]">
        {status === "loading" && (
          <div className="flex flex-col items-center text-center">
            <div className="h-12 w-12 rounded-full bg-brand/10 text-brand flex items-center justify-center mb-4">
              <Loader2 size={22} strokeWidth={1.75} className="animate-spin" />
            </div>
            <h1 className="font-serif text-[24px] text-ink leading-tight">
              {t("authCallback.verifying", "Verifying your email…")}
            </h1>
            <p className="text-[13px] text-ink-soft mt-2 leading-relaxed">
              {t(
                "authCallback.verifyingSub",
                "Hold on a second — we're finishing your sign-in.",
              )}
            </p>
          </div>
        )}

        {status === "success" && (
          <div className="flex flex-col items-center text-center">
            <div className="h-12 w-12 rounded-full bg-brand/10 text-brand flex items-center justify-center mb-4">
              <CheckCircle2 size={22} strokeWidth={1.75} />
            </div>
            <h1 className="font-serif text-[24px] text-ink leading-tight">
              {t("authCallback.success", "You're signed in.")}
            </h1>
            <p className="text-[13px] text-ink-soft mt-2 leading-relaxed">
              {t(
                "authCallback.successSub",
                "Taking you to your workspace now…",
              )}
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center text-center">
            <div className="h-12 w-12 rounded-full bg-alert/10 text-alert flex items-center justify-center mb-4">
              <AlertTriangle size={22} strokeWidth={1.75} />
            </div>
            <h1 className="font-serif text-[24px] text-ink leading-tight">
              {t("authCallback.errorTitle", "We hit a snag")}
            </h1>
            <p className="text-[13px] text-ink-soft mt-2 leading-relaxed">
              {errorMsg ??
                t(
                  "authCallback.errorGeneric",
                  "Something went wrong while signing you in.",
                )}
            </p>
            <div className="mt-5 flex flex-col gap-2 w-full">
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-full bg-brand text-primary-foreground text-[14px] font-medium hover:bg-brand/90 transition-colors"
              >
                <Mail size={14} strokeWidth={2} />
                {t("authCallback.retrySignup", "Request a new link")}
              </Link>
              <Link
                to="/login"
                className="inline-flex items-center justify-center h-10 px-5 rounded-lg border border-rule text-[13px] text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
              >
                {t("authCallback.backToSignin", "Back to sign in")}
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
