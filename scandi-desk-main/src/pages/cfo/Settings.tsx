// /settings — Profile, Workspace, Subscription, Security, Integrations.
//
// All sections live on a single page so the operator can scan their account
// at a glance. Subscription card is the centrepiece — shows trial countdown,
// renewal date, cancel-at-period-end status, and routes to /pricing for
// upgrade/downgrade. Cancel + reactivate live inline.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/cfo/AppShell";
import { SUPPORTED_LANGUAGES, setLanguage } from "@/i18n";
import { useAuth } from "@/lib/auth";
import {
  isSubscriptionEntitled,
  planFor,
  trialDaysLeft,
  useSubscription,
} from "@/lib/billing";
import { getSupabase, supabaseEnabled } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Lock,
  LogOut,
  Mail,
  Settings as SettingsIcon,
  Shield,
  Sparkle,
} from "lucide-react";

export default function Settings() {
  const { user, displayName, companyName, demoActive, signOut } = useAuth();
  const { subscription, loading, cancel, reactivate, refresh } = useSubscription();
  const { toast } = useToast();
  const navigate = useNavigate();
  const plan = planFor(subscription);
  const entitled = isSubscriptionEntitled(subscription);
  const trialLeft = trialDaysLeft(subscription);

  return (
    <AppShell>
      <header className="mb-7">
        <div className="label-eyebrow">Settings</div>
        <h1 className="mt-2 font-serif text-[40px] leading-[1.1] tracking-[-0.02em]">
          Account
        </h1>
        <p className="mt-3 text-[15px] text-ink-soft max-w-[640px]">
          Manage your profile, workspace, subscription, and security in one place.
        </p>
      </header>

      <div className="space-y-6 max-w-[860px]">
        <ProfileCard />
        <LanguageCard />
        <WorkspaceCard />

        {/* Subscription — the centrepiece. */}
        <Section title="Subscription" subtitle="Plan, trial, and renewal — all in one place.">
          {!supabaseEnabled || demoActive ? (
            <div className="rounded-xl border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-soft">
              You're browsing in demo mode. Sign in or create an account to manage a real subscription.
              <div className="mt-3">
                <Link
                  to="/signup"
                  className="inline-flex items-center gap-1.5 rounded-md bg-brand text-paper px-3 py-1.5 text-[12px] font-medium hover:bg-brand/90 transition-colors"
                >
                  Create account
                </Link>
              </div>
            </div>
          ) : loading ? (
            <div className="rounded-xl border border-rule bg-bg-2/40 px-4 py-6 text-[13px] text-ink-mute">
              Loading subscription…
            </div>
          ) : !subscription || !plan ? (
            <div className="rounded-xl border border-caution/30 bg-caution-tint px-4 py-4 text-[13px] text-caution">
              We couldn't find a subscription on your account.{" "}
              <Link to="/pricing" className="underline-offset-2 hover:underline">Pick a plan →</Link>
            </div>
          ) : (
            <SubscriptionCard
              planName={plan.name}
              status={subscription.status}
              entitled={entitled}
              billingCycle={subscription.billingCycle}
              trialDaysLeft={trialLeft}
              renewsAt={subscription.currentPeriodEnd}
              cancelAtPeriodEnd={subscription.cancelAtPeriodEnd}
              onUpgrade={() => navigate("/pricing")}
              onCancel={async () => {
                const next = await cancel();
                if (next) toast({ title: "Cancellation scheduled", description: "Access continues until the end of the current period." });
                else toast({ title: "Couldn't cancel", variant: "destructive" });
              }}
              onReactivate={async () => {
                const next = await reactivate();
                if (next) toast({ title: "Subscription reactivated" });
                else toast({ title: "Couldn't reactivate", variant: "destructive" });
              }}
              onRefresh={refresh}
            />
          )}
        </Section>

        <Section title="Security" subtitle="Password, sign out, two-factor.">
          <SecurityCard
            email={user?.email ?? null}
            onSignOut={async () => {
              const { error } = await signOut();
              toast({
                title: error ? "Couldn't sign out" : "Signed out",
                description: error?.message,
                variant: error ? "destructive" : undefined,
              });
              if (!error) navigate("/", { replace: true });
            }}
          />
        </Section>

        <Section title="Integrations" subtitle="Connect your ERP, Slack, and email so CFO AI plugs into your stack.">
          <IntegrationsStub />
        </Section>
      </div>
    </AppShell>
  );
}

/* ───────── Profile card ────────────────────────────────────────────────── */

interface Profile {
  full_name: string | null;
  display_name: string | null;
  company_name: string | null;
  role: string | null;
}

function ProfileCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");

  useEffect(() => {
    if (!user) return;
    const sb = getSupabase();
    if (!sb) return;
    void (async () => {
      const { data } = await sb
        .from("profiles")
        .select("full_name, display_name, company_name, role")
        .eq("id", user.id)
        .maybeSingle();
      const p = (data ?? {}) as Profile;
      setProfile(p);
      setName(p.full_name ?? p.display_name ?? "");
      setCompany(p.company_name ?? "");
      setRole(p.role ?? "");
    })();
  }, [user]);

  async function save() {
    const sb = getSupabase();
    if (!sb || !user) return;
    setBusy(true);
    const { error } = await sb
      .from("profiles")
      .update({ full_name: name, company_name: company, role })
      .eq("id", user.id);
    setBusy(false);
    if (error) toast({ title: "Couldn't save profile", description: error.message, variant: "destructive" });
    else toast({ title: "Profile saved" });
  }

  if (!user) {
    return (
      <Section title="Profile" subtitle="Sign in to edit your profile.">
        <div className="rounded-xl border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-soft">
          You need an account to manage profile settings.
        </div>
      </Section>
    );
  }

  return (
    <Section title="Profile" subtitle="How CFO AI introduces you across the app.">
      <div className="rounded-2xl border border-rule bg-surface px-5 py-5 space-y-4">
        <Field label="Full name">
          <Input value={name} onChange={setName} placeholder="Alex Maier" />
        </Field>
        <Field label="Company">
          <Input value={company} onChange={setCompany} placeholder="Acme Romania SRL" />
        </Field>
        <Field label="Role">
          <Input value={role} onChange={setRole} placeholder="CFO" />
        </Field>
        <div className="flex items-center justify-between pt-1">
          <p className="text-[11px] text-ink-mute">Email <span className="text-ink-soft">{user.email}</span></p>
          <button
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand text-paper px-3.5 py-1.5 text-[12.5px] font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {busy ? "Saving…" : "Save profile"}
          </button>
        </div>
      </div>
    </Section>
  );
}

/* ───────── Language card ───────────────────────────────────────────────── */

function LanguageCard() {
  const { t, i18n } = useTranslation();
  return (
    <div className="rounded-2xl border border-rule bg-surface px-5 py-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-serif text-[18px] text-ink">{t("settings.language")}</h3>
          <p className="mt-1 text-[12.5px] text-ink-soft max-w-[480px]">
            {t("settings.language_description")}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {SUPPORTED_LANGUAGES.map((lang) => {
            const active = i18n.language?.startsWith(lang.code) ?? false;
            return (
              <button
                key={lang.code}
                type="button"
                onClick={() => setLanguage(lang.code)}
                data-testid={`lang-${lang.code}`}
                className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border text-[12.5px] transition-colors ${
                  active
                    ? "bg-ink text-paper border-ink"
                    : "bg-surface text-ink-soft border-rule hover:text-ink hover:border-rule-strong"
                }`}
              >
                <span>{lang.flag}</span>
                <span>{lang.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ───────── Workspace card ──────────────────────────────────────────────── */

function WorkspaceCard() {
  const { user, workspaceLabel } = useAuth();
  const { toast } = useToast();
  const [name, setName] = useState(workspaceLabel ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    const sb = getSupabase();
    if (!sb) return;
    void (async () => {
      const { data } = await sb
        .from("workspaces")
        .select("name")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (data?.name) setName(data.name);
    })();
  }, [user]);

  async function save() {
    const sb = getSupabase();
    if (!sb || !user) return;
    setBusy(true);
    const { error } = await sb.from("workspaces").update({ name }).eq("owner_id", user.id);
    setBusy(false);
    if (error) toast({ title: "Couldn't save workspace", description: error.message, variant: "destructive" });
    else toast({ title: "Workspace renamed" });
  }

  if (!user) return null;

  return (
    <Section title="Workspace" subtitle="The label that appears in the top header.">
      <div className="rounded-2xl border border-rule bg-surface px-5 py-5 space-y-4">
        <Field label="Workspace name">
          <Input value={name} onChange={setName} placeholder="My company" />
        </Field>
        <div className="flex justify-end pt-1">
          <button
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand text-paper px-3.5 py-1.5 text-[12.5px] font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {busy ? "Saving…" : "Save workspace"}
          </button>
        </div>
      </div>
    </Section>
  );
}

/* ───────── Subscription card ───────────────────────────────────────────── */

function SubscriptionCard({
  planName, status, entitled, billingCycle, trialDaysLeft, renewsAt,
  cancelAtPeriodEnd, onUpgrade, onCancel, onReactivate, onRefresh,
}: {
  planName: string;
  status: string;
  entitled: boolean;
  billingCycle: string;
  trialDaysLeft: number;
  renewsAt: string | null | undefined;
  cancelAtPeriodEnd: boolean;
  onUpgrade: () => void;
  onCancel: () => void | Promise<void>;
  onReactivate: () => void | Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const renewLabel = renewsAt
    ? new Date(renewsAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })
    : "—";

  return (
    <div className="rounded-2xl border border-rule bg-surface px-5 py-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="inline-flex items-center gap-2">
            <span className="font-serif text-[26px] leading-none tracking-[-0.01em] text-ink">
              {planName}
            </span>
            <StatusBadge status={status} entitled={entitled} cancelAtPeriodEnd={cancelAtPeriodEnd} />
          </div>
          <p className="mt-1.5 text-[12.5px] text-ink-soft capitalize">{billingCycle} billing</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onUpgrade}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand text-paper px-3.5 py-1.5 text-[12.5px] font-medium hover:bg-brand/90 transition-colors"
          >
            Change plan
          </button>
        </div>
      </div>

      <div className="mt-5 grid sm:grid-cols-2 gap-3 text-[12.5px]">
        {status === "trial" && (
          <Stat label="Trial">
            <span className="text-ink">{trialDaysLeft} {trialDaysLeft === 1 ? "day" : "days"} left</span>
          </Stat>
        )}
        <Stat label={status === "trial" ? "Trial ends" : "Renews on"}>
          <span className="text-ink">{renewLabel}</span>
        </Stat>
        <Stat label="Cancel at period end">
          <span className={cancelAtPeriodEnd ? "text-caution" : "text-ink"}>
            {cancelAtPeriodEnd ? "Yes — won't auto-renew" : "No — auto-renews"}
          </span>
        </Stat>
      </div>

      {/* Action row — cancel or reactivate, depending on state. */}
      <div className="mt-5 pt-4 border-t border-rule/60 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11.5px] text-ink-mute">
          Stripe checkout integration is the only remaining step.
          You can change plans freely until then — see <code className="font-mono">billing.ts</code>.
        </p>
        <div className="flex items-center gap-2">
          {cancelAtPeriodEnd ? (
            <button
              onClick={onReactivate}
              className="inline-flex items-center gap-1.5 rounded-md border border-rule hover:border-rule-strong px-3 py-1.5 text-[12px] text-ink-soft hover:text-ink transition-colors"
            >
              <Check size={12} strokeWidth={1.75} />
              Reactivate
            </button>
          ) : (
            <button
              onClick={onCancel}
              className="inline-flex items-center gap-1.5 rounded-md border border-rule hover:border-alert/40 hover:text-alert px-3 py-1.5 text-[12px] text-ink-soft transition-colors"
            >
              Cancel at period end
            </button>
          )}
          <button
            onClick={onRefresh}
            className="text-[11px] text-ink-mute hover:text-ink transition-colors"
            title="Re-fetch subscription from the server"
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, entitled, cancelAtPeriodEnd }: { status: string; entitled: boolean; cancelAtPeriodEnd: boolean }) {
  let label = status;
  let cls = "border-rule bg-bg-2 text-ink-soft";
  if (status === "trial") { label = "Trial"; cls = "border-info/30 bg-info-tint text-info"; }
  else if (status === "active" && cancelAtPeriodEnd) { label = "Active · ending"; cls = "border-caution/30 bg-caution-tint text-caution"; }
  else if (status === "active") { label = "Active"; cls = "border-success/30 bg-success-tint text-success"; }
  else if (status === "past_due") { label = "Past due"; cls = "border-caution/30 bg-caution-tint text-caution"; }
  else if (status === "canceled") { label = "Canceled"; cls = "border-alert/30 bg-alert-tint text-alert"; }
  else if (status === "incomplete") { label = "Incomplete"; cls = "border-caution/30 bg-caution-tint text-caution"; }
  if (!entitled && status !== "trial") cls = "border-alert/30 bg-alert-tint text-alert";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10.5px] uppercase tracking-[0.08em] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-rule bg-bg-2 px-3 py-2.5">
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">{label}</div>
      <div className="mt-1 text-[13px]">{children}</div>
    </div>
  );
}

/* ───────── Security card ───────────────────────────────────────────────── */

function SecurityCard({ email, onSignOut }: { email: string | null; onSignOut: () => void | Promise<void> }) {
  const sb = getSupabase();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function sendPasswordReset() {
    if (!sb || !email) return;
    setBusy(true);
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + "/login" });
    setBusy(false);
    if (error) toast({ title: "Couldn't send reset email", description: error.message, variant: "destructive" });
    else toast({ title: "Password reset email sent", description: `Check ${email}.` });
  }

  return (
    <div className="rounded-2xl border border-rule bg-surface px-5 py-5 space-y-3">
      <Row icon={Lock} title="Password">
        <button
          onClick={sendPasswordReset}
          disabled={busy || !email}
          className="text-[12px] text-ink-soft hover:text-ink transition-colors disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send reset email"}
        </button>
      </Row>
      <Row icon={Shield} title="Two-factor authentication">
        <span className="text-[12px] text-ink-mute">Coming soon</span>
      </Row>
      <Row icon={LogOut} title="Sign out">
        <button
          onClick={onSignOut}
          className="text-[12px] text-alert hover:text-alert/80 transition-colors"
        >
          Sign out of this device
        </button>
      </Row>
    </div>
  );
}

/* ───────── Integrations stub ───────────────────────────────────────────── */

function IntegrationsStub() {
  const items = [
    { icon: SettingsIcon, title: "ERP connector", description: "Live SKU + inventory feed from SAP, Odoo, NetSuite, Sage." },
    { icon: Sparkle,      title: "Slack",         description: "Daily briefings + alerts in your team channel." },
    { icon: Mail,         title: "Email",         description: "Weekly executive briefing + critical alert escalation." },
  ];
  return (
    <div className="rounded-2xl border border-rule bg-surface divide-y divide-rule/60">
      {items.map((it) => (
        <Row key={it.title} icon={it.icon} title={it.title} description={it.description}>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-rule hover:border-rule-strong px-2.5 py-1.5 text-[12px] text-ink-soft hover:text-ink transition-colors">
            Connect
            <ExternalLink size={11} strokeWidth={1.75} />
          </button>
        </Row>
      ))}
      <div className="px-5 py-3 text-[11.5px] text-ink-mute flex items-center gap-2">
        <AlertTriangle size={12} strokeWidth={1.75} />
        Integrations are part of the Professional and Enterprise plans.
      </div>
    </div>
  );
}

/* ───────── Section / Field / Row primitives ────────────────────────────── */

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[15px] font-medium text-ink">{title}</h2>
      {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-soft">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Input({
  value, onChange, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-bg-2 border border-rule rounded-md px-3 py-2 text-[13.5px] text-ink focus:outline-none focus:border-brand/50 focus:bg-surface transition-colors"
    />
  );
}

function Row({
  icon: Icon, title, description, children,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-rule bg-bg-2 text-ink-soft shrink-0">
          <Icon size={14} strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <div className="text-[13.5px] text-ink truncate">{title}</div>
          {description && <div className="text-[11.5px] text-ink-mute leading-snug">{description}</div>}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
