// AuthCard — premium dark glass card used in three places:
//   · Landing hero (right column)
//   · /login standalone page (centered)
//   · /signup standalone page (centered)
//
// The card owns its own form state + Supabase calls so it can be dropped in
// without prop plumbing. On success it navigates to /today via react-router.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth";
import { supabaseEnabled } from "@/lib/supabase";
import { markNewsletterOptInPending } from "@/lib/newsletterOptIn";
import { TermsDialog } from "./TermsDialog";
import { Check, Loader2, Mail, Sparkle, Sparkles } from "lucide-react";
import {
  getPlan,
  formatPriceLabel,
  type BillingCycle,
} from "@/lib/plans";
import {
  setSelectedPlanLocal,
  useSubscription,
} from "@/lib/billing";

type Mode = "sign_in" | "sign_up";

// Client-side-only heuristic — Supabase still enforces its own minimum
// server-side. This is purely a "how strong does this look" nudge. The
// checklist and the strength score are derived from the SAME signals so
// the two never disagree (e.g. "Strong" while a checkbox is still unmet).
interface PasswordCheck { label: string; met: boolean }

type Translate = (key: string, options?: Record<string, unknown>) => string;

function getPasswordChecks(pw: string, t: Translate): PasswordCheck[] {
  return [
    { label: t("authX.pw_check_length"), met: pw.length >= 10 },
    { label: t("authX.pw_check_case"), met: /[a-z]/.test(pw) && /[A-Z]/.test(pw) },
    { label: t("authX.pw_check_number"), met: /\d/.test(pw) },
    { label: t("authX.pw_check_symbol"), met: /[^A-Za-z0-9]/.test(pw) },
  ];
}

function getPasswordStrength(pw: string, t: Translate): { level: 0 | 1 | 2 | 3 | 4; label: string; color: string } {
  if (!pw) return { level: 0, label: "", color: "" };
  // Met-count above, plus one point just for clearing Supabase's own
  // 6-char floor, so a 6-9 char password with every other box checked
  // doesn't max out the bar before it's actually hit 10 characters.
  const metCount = getPasswordChecks(pw, t).filter((c) => c.met).length;
  const score = metCount + (pw.length >= 6 ? 1 : 0);
  if (score <= 1) return { level: 1, label: t("authX.pw_weak"), color: "bg-alert" };
  if (score === 2) return { level: 2, label: t("authX.pw_fair"), color: "bg-amber-500" };
  if (score === 3) return { level: 3, label: t("authX.pw_good"), color: "bg-brand/70" };
  return { level: 4, label: t("authX.pw_strong"), color: "bg-brand" };
}

interface Props {
  /** Initial tab. Tabs are visible by default; pass `tabsHidden` for the
      dedicated /login or /signup page where only one mode applies. */
  initialMode?: Mode;
  tabsHidden?: boolean;
  /** Subtitle override — e.g. landing card vs standalone page may want
      different copy. */
  subtitle?: string;
  /** Callback fired after a successful sign-in or sign-up that returned a
      session immediately. Default: navigate("/dashboard"). */
  onAuthenticated?: () => void;
}

export function AuthCard({
  initialMode = "sign_in",
  tabsHidden = false,
  subtitle,
  onAuthenticated,
}: Props) {
  // ─── Hooks (all unconditional, fixed order) ────────────────────────────
  // useAuth + useNavigate + useSearchParams must run on every render or React
  // throws "change in the order of Hooks". Keep them tight at the top.
  const { signIn, signUp, signInWithOAuth, status } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();

  // useSubscription internally calls useLocalSubscription via
  // useSyncExternalStore. We previously called useLocalSubscription twice
  // (here AND inside useSubscription) — that triggered React's hook-order
  // detector when one path memoized differently from the other. Single call
  // here, derive `local` and `remote` separately from the same hook.
  const { subscription, setPlan } = useSubscription();

  // All useState calls grouped; nothing conditional above them.
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);
  // Resend cooldown — Supabase rate-limits OTP / signup resends server-side
  // (default 1/min, configurable in Auth → Rate limits). Without a client-
  // side guard, an impatient user mashing the button gets 429s and a confusing
  // "rate limit exceeded" toast. The countdown also doubles as a clear "we
  // sent it — give it a moment" UX cue.
  const [resendCooldownSec, setResendCooldownSec] = useState(0);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  // Signup consent. `acceptedTerms` gates submission; `wantsNewsletter` is
  // optional and acted on only after the account actually exists.
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [wantsNewsletter, setWantsNewsletter] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);

  // Derived view-model — pure useMemo, deterministic.
  const displayName = useMemo(
    () => `${firstName.trim()} ${lastName.trim()}`.trim(),
    [firstName, lastName],
  );
  const passwordStrength = useMemo(() => getPasswordStrength(password, t), [password, t]);
  const passwordChecks = useMemo(() => getPasswordChecks(password, t), [password, t]);
  const selectedPlan = useMemo(
    () => (subscription ? getPlan(subscription.planId) : null),
    [subscription],
  );

  // ?plan=professional&cycle=yearly on the URL takes precedence over any
  // previously persisted selection. Stored locally so the chip survives
  // refreshes and so AuthCard can promote it to the DB after sign-up.
  useEffect(() => {
    const planFromUrl = searchParams.get("plan");
    const cycleFromUrl = searchParams.get("cycle") as BillingCycle | null;
    if (planFromUrl && getPlan(planFromUrl)) {
      setSelectedPlanLocal(
        planFromUrl as never,
        cycleFromUrl === "yearly" ? "yearly" : "monthly",
      );
    }
  }, [searchParams]);

  // Already signed in? Send them through the post-auth router. Pre-bound so
  // it doesn't fire while the AuthCard is on /login waiting for input.
  useEffect(() => {
    if (status === "signed_in") {
      void postAuthNavigate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Resend cooldown tick. Decrements once per second until 0 — keeps the
  // button disabled and the countdown label fresh without re-rendering the
  // whole card. setInterval is fine here because the resend cooldown is
  // short (60s) and bound to the confirmEmail UI mount.
  useEffect(() => {
    if (resendCooldownSec <= 0) return;
    const id = window.setInterval(() => {
      setResendCooldownSec((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendCooldownSec]);

  // When the "Check your email" panel first mounts (right after a successful
  // signUp that returned needsConfirmation), seed the 60s cooldown so the
  // user can't immediately mash Resend and trip Supabase's server-side rate
  // limit. We also show a small "we sent it" confirmation chip.
  useEffect(() => {
    if (confirmEmail) {
      setResendCooldownSec(60);
      setResendInfo(null);
    }
  }, [confirmEmail]);

  /**
   * Post-auth router. Decides where to send the user once Supabase confirms
   * a session is live. Three cases:
   *   1. Pre-selected plan in local storage → commit to subscriptions row,
   *      then go to /today.
   *   2. Already has an active or trial subscription → /today (the trigger
   *      always seeds a trial, so first-time signups land here too — but
   *      we still route them through /pricing for an explicit choice).
   *   3. No plan choice yet → /pricing so they pick one.
   */
  async function postAuthNavigate() {
    // ?next=/some/path takes precedence over everything else — that's the
    // path the user was trying to reach when AuthGuard bounced them here.
    const next = searchParams.get("next");
    const target = next
      ? () => navigate(next)
      : onAuthenticated ?? (() => navigate("/dashboard"));

    // Commit a pre-picked plan if there was one (e.g. came from /pricing
    // → /signup?plan=professional). After this the local row is gone and
    // the DB row drives the rest of the app.
    if (subscription?.isLocal && subscription.planId) {
      const cycle: BillingCycle = subscription.billingCycle ?? "monthly";
      await setPlan(subscription.planId, cycle);
      target();
      return;
    }
    // Brand-new signup with no preselection AND no explicit next — push them
    // to the /workspace setup wizard (name + industry pick). The AuthGuard
    // keeps bouncing them back there until the industry is set, even if
    // they try to jump to /dashboard manually.
    if (mode === "sign_up" && !next) {
      navigate("/workspace");
      return;
    }
    target();
  }

  function authedRedirect() {
    void postAuthNavigate();
  }

  // Issue #7 (2026-06-16) — OAuth sign-in handler.
  //
  // Calls supabase.auth.signInWithOAuth via the extended useAuth interface.
  // On success the browser redirects to the provider; control comes back to
  // /auth/callback which the existing email-confirmation flow already handles.
  //
  // On error, the most common failure mode is "Unsupported provider" — the
  // operator hasn't enabled Google/Apple in Supabase Dashboard yet. Surface a
  // human-friendly message rather than the raw error string.
  async function handleOAuth(provider: "google" | "apple") {
    setError(null);
    setBusy(true);
    try {
      const { error } = await signInWithOAuth(provider);
      if (error) {
        // Detect the "provider not configured" case via Supabase's error
        // shape: status 400 + message containing "provider" or "validation".
        // Show a friendlier message that doesn't leak the raw API string.
        const msg = (error.message ?? "").toLowerCase();
        const isProviderUnavailable =
          msg.includes("provider is not enabled") ||
          msg.includes("unsupported provider") ||
          msg.includes("validation_failed");
        setError(
          isProviderUnavailable
            ? t("authX.err_provider_configuring", { provider: provider === "google" ? "Google" : "Apple" })
            : error.message,
        );
        setBusy(false);
      }
      // No success branch: signInWithOAuth navigates the browser away.
      // setBusy stays true so the button shows a spinner during redirect.
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("authX.err_signin_failed"));
      setBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "sign_up" && !companyName.trim()) {
      setError(t("authX.err_company_required"));
      return;
    }
    if (mode === "sign_up" && password !== confirmPassword) {
      setError(t("authX.err_passwords_mismatch"));
      return;
    }
    if (mode === "sign_up" && !acceptedTerms) {
      setError(t("authX.err_accept_terms"));
      return;
    }
    setBusy(true);
    try {
      if (mode === "sign_in") {
        const { error } = await signIn({ email, password });
        if (error) setError(error.message);
        else authedRedirect();
      } else {
        const { error, needsConfirmation } = await signUp({
          email,
          password,
          displayName: displayName || undefined,
          companyName: companyName.trim(),
        });
        if (error) setError(error.message);
        else {
          // Ticking the box IS the consent — no separate "confirm your
          // subscription" email. We can't subscribe outright here because
          // with email confirmation on there is no session yet, so the
          // intent is parked and flushed by lib/auth.tsx the first time a
          // session exists (i.e. once the account-confirmation link has
          // been clicked and the address is proven). See lib/newsletterOptIn.ts.
          if (wantsNewsletter) markNewsletterOptInPending(email);
          if (needsConfirmation) setConfirmEmail(email);
          else authedRedirect();
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="
        w-full max-w-[440px]
        rounded-3xl
        border border-rule
        bg-surface/80
        backdrop-blur-xl
        shadow-[0_32px_80px_-20px_rgba(0,0,0,0.5)]
        p-7 sm:p-8
        text-ink
      "
    >
      <div className="flex flex-col gap-1.5 mb-6">
        <h2 className="font-serif text-[26px] sm:text-[28px] leading-[1.1] tracking-[-0.01em]">
          {t("auth.welcome")}
        </h2>
        <p className="text-[13px] text-ink-soft leading-snug">
          {subtitle ??
            (mode === "sign_in"
              ? t("authX.subtitle_sign_in")
              : t("authX.subtitle_sign_up"))}
        </p>
      </div>

      {/* Selected plan chip — appears when the user picked a plan from the
          pricing section (or carried one in via ?plan=). Lets them switch
          back to the pricing grid without losing context. */}
      {selectedPlan && mode === "sign_up" && (
        <div className="mb-4 rounded-xl border border-brand/25 bg-brand/[0.06] px-3.5 py-3 flex items-center gap-3">
          <div className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-brand/15 text-brand">
            <Sparkle size={12} strokeWidth={2.25} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.1em] text-brand/80 font-medium">
              {t("authX.selected_plan")}
            </div>
            <div className="text-[13px] text-ink truncate">
              {selectedPlan.name}
              {selectedPlan.monthly !== null && (
                <span className="text-ink-soft">
                  {" — "}
                  {(() => {
                    const { amount, unit } = formatPriceLabel(selectedPlan, subscription?.billingCycle ?? "monthly");
                    return `${amount}${unit}`;
                  })()}
                </span>
              )}
            </div>
          </div>
          <Link
            to="/#pricing"
            className="text-[11px] text-ink-soft hover:text-ink underline-offset-2 hover:underline"
          >
            {t("authX.change_plan")}
          </Link>
        </div>
      )}

      {!supabaseEnabled && (
        <div className="mb-4 rounded-xl border border-accent2/30 bg-accent2/10 px-3.5 py-3 text-[12px] text-accent2">
          {t("authX.not_configured")}
        </div>
      )}

      {confirmEmail ? (
        <div className="space-y-4">
          <div className="rounded-2xl border border-rule bg-bg-2/40 p-5 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-brand/10 text-brand flex items-center justify-center mb-3">
              <Mail size={20} strokeWidth={1.75} />
            </div>
            <h3 className="font-serif text-[18px] text-ink leading-tight">{t("authX.check_email_title")}</h3>
            <p className="text-[13px] text-ink-soft mt-2 leading-relaxed">
              {t("authX.check_email_body_pre")}{" "}
              <span className="text-ink font-medium">{confirmEmail}</span>.{" "}
              {t("authX.check_email_body_post")}
            </p>
            <p className="text-[11.5px] text-ink-mute mt-3">
              {t("authX.check_email_hint")}
            </p>
          </div>
          {/* Successful-resend confirmation chip. Distinct from `error` so the
              user sees a positive "we did the thing" cue, not a red box. */}
          {resendInfo && (
            <div className="text-[12px] text-brand bg-brand/10 border border-brand/30 rounded-lg px-3 py-2 text-center">
              {resendInfo}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={async () => {
                if (resendCooldownSec > 0) return;
                setError(null);
                setResendInfo(null);
                setBusy(true);
                const { error } = await signUp({ email: confirmEmail, password, displayName, companyName });
                setBusy(false);
                // Supabase returns a "User already registered" error on
                // resends because the auth.users row exists from the original
                // signUp call — that's expected, not a failure. The link is
                // re-sent regardless. Surface other errors plainly.
                const msg = (error?.message ?? "").toLowerCase();
                const isAlreadyRegistered =
                  msg.includes("already registered") ||
                  msg.includes("user already exists");
                if (error && !isAlreadyRegistered) {
                  setError(error.message);
                } else {
                  setResendInfo(t("authX.resend_sent"));
                }
                // Start cooldown regardless of outcome — keeps the user from
                // mashing the button and racing through Supabase's server-side
                // rate limit.
                setResendCooldownSec(60);
              }}
              disabled={busy || resendCooldownSec > 0}
              className="h-10 rounded-lg border border-rule text-[13px] text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={
                resendCooldownSec > 0
                  ? t("authX.resend_available_in", { seconds: resendCooldownSec })
                  : t("authX.resend_aria")
              }
            >
              {busy ? (
                <Loader2 size={14} className="inline animate-spin" />
              ) : resendCooldownSec > 0 ? (
                t("authX.resend_in", { seconds: resendCooldownSec })
              ) : (
                t("authX.resend_email")
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmEmail(null);
                setMode("sign_in");
                setResendInfo(null);
                setResendCooldownSec(0);
              }}
              className="h-10 rounded-lg bg-ink text-paper text-[13px] font-medium hover:bg-ink/90 transition-colors"
            >
              {t("authX.back_to_sign_in")}
            </button>
          </div>
          {error && (
            <div className="text-[12px] text-alert bg-alert/10 border border-alert/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>
      ) : (
        <>
          {!tabsHidden && (
            <div className="relative grid grid-cols-2 gap-1 p-1 mb-5 rounded-xl bg-bg-2/80 border border-rule/40">
              <div
                aria-hidden
                className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-lg bg-brand/15 border border-brand/40 shadow-[0_2px_10px_-2px_rgba(92,211,197,0.35)] transition-transform duration-200 ease-out"
                style={{ transform: mode === "sign_up" ? "translateX(calc(100% + 4px))" : "translateX(0)" }}
              />
              <Tab active={mode === "sign_in"} onClick={() => { setMode("sign_in"); setError(null); }}>{t("auth.sign_in")}</Tab>
              <Tab active={mode === "sign_up"} onClick={() => { setMode("sign_up"); setError(null); }}>{t("auth.sign_up")}</Tab>
            </div>
          )}

          {/* Issue #7 (2026-06-16) — OAuth providers.
              Render only when Supabase is wired (test mode + disabled mode
              both hide these — the user is auto-signed-in in test mode, and
              there's no provider to redirect to in disabled mode). */}
          {supabaseEnabled && (
            <>
              <div className="grid grid-cols-1 gap-2 mb-3">
                <OAuthButton
                  provider="google"
                  busy={busy}
                  onClick={() => handleOAuth("google")}
                />
              </div>
              <div className="flex items-center gap-3 mb-3" aria-hidden>
                <div className="flex-1 h-px bg-rule" />
                <span className="text-[10.5px] uppercase tracking-[0.12em] text-ink-soft/70">
                  {t("authX.or_continue_email")}
                </span>
                <div className="flex-1 h-px bg-rule" />
              </div>
            </>
          )}

          <form className="space-y-3" onSubmit={handleSubmit}>
            {mode === "sign_up" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("authX.first_name")}>
                    <Input
                      value={firstName}
                      onChange={(v) => setFirstName(v)}
                      placeholder="Alex"
                      autoComplete="given-name"
                    />
                  </Field>
                  <Field label={t("authX.last_name")}>
                    <Input
                      value={lastName}
                      onChange={(v) => setLastName(v)}
                      placeholder="Maier"
                      autoComplete="family-name"
                    />
                  </Field>
                </div>
                <Field label={t("auth.company")} required>
                  <Input
                    value={companyName}
                    onChange={(v) => setCompanyName(v)}
                    placeholder="Acme Romania SRL"
                    autoComplete="organization"
                    required
                  />
                </Field>
              </>
            )}

            <Field label={t("authX.email_label")} required>
              <Input
                type="email"
                value={email}
                onChange={(v) => setEmail(v)}
                placeholder={t("authX.email_placeholder")}
                autoComplete="email"
                required
              />
            </Field>

            <Field label={t("auth.password")} required>
              <Input
                type="password"
                value={password}
                onChange={(v) => setPassword(v)}
                placeholder={mode === "sign_up" ? t("authX.pw_check_length") : ""}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                required
                // 10 matches the advertised checklist; sign-IN stays
                // unconstrained so existing accounts with shorter passwords
                // aren't locked out at the browser-validation layer.
                minLength={mode === "sign_up" ? 10 : undefined}
              />
              {mode === "sign_up" && password && (
                <div className="mt-2">
                  <div className="grid grid-cols-4 gap-1">
                    {[1, 2, 3, 4].map((seg) => (
                      <div
                        key={seg}
                        className={`h-1 rounded-full transition-colors ${
                          seg <= passwordStrength.level ? passwordStrength.color : "bg-rule"
                        }`}
                      />
                    ))}
                  </div>
                  <div className="mt-1 text-[11px] text-ink-soft">{passwordStrength.label}</div>
                  <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                    {passwordChecks.map((check) => (
                      <li
                        key={check.label}
                        className={`flex items-center gap-1.5 text-[11px] ${check.met ? "text-brand" : "text-ink-soft/70"}`}
                      >
                        <Check size={11} strokeWidth={2.5} className={check.met ? "opacity-100" : "opacity-30"} />
                        {check.label}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Field>

            {mode === "sign_up" && (
              <Field label={t("authX.repeat_password")} required>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(v) => setConfirmPassword(v)}
                  placeholder={t("authX.repeat_password_placeholder")}
                  autoComplete="new-password"
                  required
                  minLength={10}
                />
              </Field>
            )}

            {mode === "sign_up" && (
              <div className="flex flex-col gap-2.5 pt-1">
                {/* Consent is REQUIRED and deliberately not pre-ticked — a
                    pre-ticked box is not consent under GDPR. The Terms open
                    in a modal rather than a link, because navigating away
                    from a half-filled signup form loses everything typed. */}
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms(e.currentTarget.checked)}
                    data-testid="signup-accept-terms"
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-rule accent-brand cursor-pointer"
                  />
                  <span className="text-[11.5px] leading-snug text-ink-soft">
                    {t("authX.terms_agree_pre")}{" "}
                    <button
                      type="button"
                      // stopPropagation: without it the click bubbles to the
                      // <label> and toggles the checkbox as a side effect of
                      // opening the document the user hasn't read yet.
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTermsOpen(true); }}
                      data-testid="signup-open-terms"
                      // `brand-light`, not `brand-l` — tailwind.config.ts
                      // names the scale DEFAULT/dark/light/tint, so
                      // `hover:text-brand-l` compiles to nothing at all.
                      className="text-brand font-medium underline underline-offset-2 hover:text-brand-light"
                    >
                      {t("authX.terms_of_service")}
                    </button>
                    <span className="text-brand"> *</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wantsNewsletter}
                    onChange={(e) => setWantsNewsletter(e.currentTarget.checked)}
                    data-testid="signup-newsletter"
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-rule accent-brand cursor-pointer"
                  />
                  <span className="text-[11.5px] leading-snug text-ink-soft">
                    {t("authX.newsletter_opt_in")}
                  </span>
                </label>
              </div>
            )}

            <p className="text-[10.5px] text-ink-mute">
              <span className="text-brand">*</span> {t("authX.required")}
            </p>

            {error && (
              <div className="rounded-lg border border-alert/30 bg-alert/10 px-3 py-2 text-[12px] text-alert">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="
                w-full mt-1
                inline-flex items-center justify-center gap-2
                h-11 px-5 rounded-full
                bg-brand hover:bg-brand/90
                text-primary-foreground text-[14px] font-medium
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-all
              "
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {mode === "sign_in" ? t("auth.sign_in") : t("auth.sign_up")}
            </button>
          </form>

          <p className="mt-5 text-[11px] text-ink-soft text-center leading-relaxed">
            {mode === "sign_in" ? (
              <>{t("authX.new_here")} <Link to="/signup" className="text-ink underline-offset-4 hover:underline" onClick={() => setMode("sign_up")}>{t("authX.create_an_account")}</Link></>
            ) : (
              <>{t("authX.already_have_account")} <Link to="/login" className="text-ink underline-offset-4 hover:underline" onClick={() => setMode("sign_in")}>{t("auth.sign_in")}</Link></>
            )}
          </p>
        </>
      )}

      {/* Mounted at the card root, outside the `confirmEmail` branch, so the
          document stays readable no matter which state the card is in. */}
      <TermsDialog open={termsOpen} onOpenChange={setTermsOpen} />
    </div>
  );
}

// Issue #7 (2026-06-16) — OAuth provider button.
//
// Google only — the Apple OAuth option was removed from this UI. Ships its
// own brand mark via inline SVG (no external dependency, no icon-font load)
// so the button looks right on the first paint with no FOUC.
//
// Visual treatment: matches the existing app aesthetic (rounded, border,
// frosted) rather than the official Google "Sign in with Google" brand
// guidelines — those guidelines require white-on-blue + Roboto and would
// clash with the dark glass card. The brand logo + verb-first label
// preserve recognizability without breaking the surface treatment.
//
// Tap target ≥44px high (h-11) per WCAG / our mobile spec.
function OAuthButton({
  provider,
  busy,
  onClick,
}: {
  provider: "google";
  busy: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid={`oauth-${provider}`}
      aria-label={t("authX.continue_with_google")}
      className="
        inline-flex items-center justify-center gap-2
        h-11 rounded-xl
        bg-bg-2/80 hover:bg-bg-2
        border border-rule
        text-[13px] font-medium text-ink
        disabled:opacity-50 disabled:cursor-not-allowed
        transition-colors
      "
    >
      <GoogleLogo />
      <span>Google</span>
    </button>
  );
}

function GoogleLogo() {
  // Google G silhouette, monotone in the brand family (the 4-colour mark
  // is retired with the old teal palette; red is reserved for danger).
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.614z"
        fill="hsl(var(--brand))"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
        fill="hsl(var(--brand))"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        fill="hsl(var(--brand-l))"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
        fill="hsl(var(--brand-d))"
      />
    </svg>
  );
}

function Tab({
  active, children, onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        relative z-10 h-9 rounded-lg text-[12.5px] font-medium transition-colors
        ${active ? "text-brand" : "text-ink-soft hover:text-ink"}
      `}
    >
      {children}
    </button>
  );
}

function Field({
  label, required = false, children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1.5">
        {label}{required && <span className="text-brand ml-0.5">*</span>}
      </div>
      {children}
    </div>
  );
}

function Input({
  type = "text",
  value, onChange,
  placeholder, autoComplete,
  required = false, minLength,
}: {
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete={autoComplete}
      required={required}
      minLength={minLength}
      className="
        w-full h-11 px-3.5
        rounded-xl
        bg-bg-2/80
        border border-rule
        text-[14px] text-ink
        placeholder:text-ink-soft/70
        outline-none
        focus:border-brand/50
        focus:bg-bg-2/85
        focus:shadow-[0_0_0_3px_rgba(92,211,197,0.12)]
        transition-all
      "
    />
  );
}
