// AuthCard — premium dark glass card used in three places:
//   · Landing hero (right column)
//   · /login standalone page (centered)
//   · /signup standalone page (centered)
//
// The card owns its own form state + Supabase calls so it can be dropped in
// without prop plumbing. On success it navigates to /today via react-router.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { supabaseEnabled } from "@/lib/supabase";
import { Loader2, Mail, Sparkle, Sparkles } from "lucide-react";
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
  /** Callback for the "Continue with demo" path. Default: enterDemo() then
      navigate("/dashboard"). */
  onDemo?: () => void;
}

export function AuthCard({
  initialMode = "sign_in",
  tabsHidden = false,
  subtitle,
  onAuthenticated,
  onDemo,
}: Props) {
  // ─── Hooks (all unconditional, fixed order) ────────────────────────────
  // useAuth + useNavigate + useSearchParams must run on every render or React
  // throws "change in the order of Hooks". Keep them tight at the top.
  const { signIn, signUp, enterDemo, status } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

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
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);

  // Derived view-model — pure useMemo, deterministic.
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
    // through onboarding (industry pick) then on to /upload. The AuthGuard
    // will keep them on /onboarding until they finish, even if they try to
    // jump to /dashboard manually.
    if (mode === "sign_up" && !next) {
      navigate("/onboarding");
      return;
    }
    target();
  }

  function authedRedirect() {
    void postAuthNavigate();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "sign_up" && !companyName.trim()) {
      setError("Company name is required for new accounts.");
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
        else if (needsConfirmation) setConfirmEmail(email);
        else authedRedirect();
      }
    } finally {
      setBusy(false);
    }
  }

  function handleDemo() {
    if (onDemo) {
      onDemo();
      return;
    }
    enterDemo();
    navigate("/dashboard");
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
          Welcome to CFO AI
        </h2>
        <p className="text-[13px] text-ink-soft leading-snug">
          {subtitle ??
            (mode === "sign_in"
              ? "Sign in to continue. Your decisions and uploads are scoped to your workspace."
              : "Create your workspace. Free tier — no credit card.")}
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
              Selected plan
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
            Change
          </Link>
        </div>
      )}

      {!supabaseEnabled && (
        <div className="mb-4 rounded-xl border border-accent2/30 bg-accent2/10 px-3.5 py-3 text-[12px] text-accent2">
          Authentication isn't configured on this build. Demo access still works.
        </div>
      )}

      {confirmEmail ? (
        <div className="space-y-4">
          <div className="rounded-2xl border border-rule bg-bg-2/40 p-5 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-brand/10 text-brand flex items-center justify-center mb-3">
              <Mail size={20} strokeWidth={1.75} />
            </div>
            <h3 className="font-serif text-[18px] text-ink leading-tight">Check your email</h3>
            <p className="text-[13px] text-ink-soft mt-2 leading-relaxed">
              We sent a confirmation link to{" "}
              <span className="text-ink font-medium">{confirmEmail}</span>.
              Click it to finish creating your account.
            </p>
            <p className="text-[11.5px] text-ink-mute mt-3">
              Didn't see it? Check spam, or wait 60s and try again.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={async () => {
                setError(null);
                setBusy(true);
                const { error } = await signUp({ email: confirmEmail, password, displayName, companyName });
                setBusy(false);
                if (error && !error.message.toLowerCase().includes("already registered")) {
                  setError(error.message);
                }
              }}
              disabled={busy}
              className="h-10 rounded-lg border border-rule text-[13px] text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="inline animate-spin" /> : "Resend email"}
            </button>
            <button
              type="button"
              onClick={() => { setConfirmEmail(null); setMode("sign_in"); }}
              className="h-10 rounded-lg bg-ink text-paper text-[13px] font-medium hover:bg-ink/90 transition-colors"
            >
              Back to sign in
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
            <div className="grid grid-cols-2 gap-1 p-1 mb-5 rounded-xl bg-bg-2/80 border border-rule/40">
              <Tab active={mode === "sign_in"} onClick={() => { setMode("sign_in"); setError(null); }}>Sign in</Tab>
              <Tab active={mode === "sign_up"} onClick={() => { setMode("sign_up"); setError(null); }}>Create account</Tab>
            </div>
          )}

          <form className="space-y-3" onSubmit={handleSubmit}>
            {mode === "sign_up" && (
              <>
                <Field label="Full name">
                  <Input
                    value={displayName}
                    onChange={(v) => setDisplayName(v)}
                    placeholder="Alex Maier"
                    autoComplete="name"
                  />
                </Field>
                <Field label="Company name" required>
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

            <Field label="Work email" required>
              <Input
                type="email"
                value={email}
                onChange={(v) => setEmail(v)}
                placeholder="you@company.com"
                autoComplete="email"
                required
              />
            </Field>

            <Field label="Password" required>
              <Input
                type="password"
                value={password}
                onChange={(v) => setPassword(v)}
                placeholder={mode === "sign_up" ? "At least 6 characters" : ""}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                required
                minLength={6}
              />
            </Field>

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
                text-[#05070A] text-[14px] font-medium
                disabled:opacity-50 disabled:cursor-not-allowed
                shadow-[0_0_0_0_rgba(46,211,198,0.0)]
                hover:shadow-[0_0_24px_-4px_rgba(46,211,198,0.45)]
                transition-all
              "
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {mode === "sign_in" ? "Sign in" : "Create account"}
            </button>
          </form>

          {/* Demo bypass */}
          <div className="mt-4">
            <button
              type="button"
              data-testid="auth-continue-demo"
              onClick={handleDemo}
              className="
                w-full inline-flex items-center justify-center gap-2
                h-11 px-5 rounded-full
                bg-transparent
                border border-rule hover:border-rule-strong/90
                text-ink/90 hover:text-ink text-[13.5px]
                transition-colors
              "
            >
              Continue with demo data
            </button>
          </div>

          <p className="mt-5 text-[11px] text-ink-soft text-center leading-relaxed">
            {mode === "sign_in" ? (
              <>New here? <Link to="/signup" className="text-ink underline-offset-4 hover:underline" onClick={() => setMode("sign_up")}>Create an account</Link></>
            ) : (
              <>Already have one? <Link to="/login" className="text-ink underline-offset-4 hover:underline" onClick={() => setMode("sign_in")}>Sign in</Link></>
            )}
          </p>
        </>
      )}
    </div>
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
        h-9 rounded-lg text-[12.5px] font-medium transition-colors
        ${active
          ? "bg-bg-2/90 text-ink shadow-[0_2px_8px_-2px_rgba(0,0,0,0.4)]"
          : "text-ink-soft hover:text-ink"}
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
        focus:shadow-[0_0_0_3px_rgba(46,211,198,0.12)]
        transition-all
      "
    />
  );
}
