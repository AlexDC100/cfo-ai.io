// /settings — Profile, Language, Workspace, Billing, Data, Security.
//
// Settings IA after the May-2026 cleanup pass: five real-feature sections,
// in a single column, with one obvious action per row. Removed: the
// duplicate "Subscription" section (covered by Billing → BillingSection)
// and the "Integrations" section (IntegrationsStub was an ERP/Slack/email
// teaser with no functional backend). Both removed components remain on
// disk so the change is fully reversible.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/cfo/AppShell";
import { SUPPORTED_LANGUAGES, setLanguage } from "@/i18n";
import { useAuth } from "@/lib/auth";
// useSubscription/isSubscriptionEntitled/planFor/trialDaysLeft + supabaseEnabled
// were used by the removed `Subscription` section; <BillingSection /> now
// owns that surface internally. Re-import here if/when the standalone
// Subscription section is restored.
import { getSupabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Settings as SettingsIcon,
  Shield,
  Sparkle,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { BillingSection } from "@/components/cfo/BillingSection";
import { LearningSettingsSection } from "@/components/learning/LearningSettingsSection";
import {
  IndustryAuditTrail,
  IndustryBadge,
  IndustryPicker,
} from "@/components/cfo/industry";
// FinancialAssumptionsCard + DataRulesCard imports removed from Settings;
// DataRulesCard now lives inside Command Center → Data (imported there).
// PlanUsageCard import dropped — Plan & usage section was removed per
// operator directive. The component file stays on disk; restore the
// import + JSX call to bring the section back (see comment near the
// removed JSX below).
import { useActivePeriod } from "@/lib/activePeriod";
import { useCurrency as useCurrencyContext } from "@/stores/currency";

export default function Settings() {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  // useSubscription / planFor / etc. were used by the removed standalone
  // `Subscription` section; <BillingSection/> manages its own state, so
  // the page-level subscription hook is no longer needed here.

  return (
    <AppShell>
      <header className="mb-7">
        <div className="label-eyebrow">{t("sidebar.settings")}</div>
        <h1 className="mt-2 font-serif text-[40px] leading-[1.1] tracking-[-0.02em]">
          {t("settings.title")}
        </h1>
        <p className="mt-3 text-[15px] text-ink-soft max-w-[640px]">
          {t("settings.subtitle")}
        </p>
      </header>

      {/*
        Settings IA, after cleanup:
          · Account     — profile (Profile + Language)
          · Plan & usage — Pricing V2 surface
          · Billing     — Stripe-backed subscription (one surface, was two)
          · Data        — clear-my-uploads (safe soft-delete; new)
          · Security    — sign-out
        Removed (preserved on disk for revert):
          · `Subscription` (duplicated `Billing`)
          · `Integrations` (non-functional stub)
          · `Workspace` (org-rename input — the workspace label only
                         affects the header chip; not worth a Settings slot)
          · `Industry classification` (per-period field; the picker
                         lives at the top of the Benchmark report and on
                         each period view, so a Settings entry was a
                         confused second seat — operator directive)
      */}
      <div className="space-y-6 max-w-[860px]">
        <ProfileCard />
        <LanguageCard />
        <CurrencyCard />

        {/* Workspace + Industry classification sections were removed per
            operator directive. Function defs kept on disk
            (`WorkspaceCard()` + `IndustrySection()` below). The industry
            picker lives at the top of the Benchmark report and on each
            period view; the workspace label only affects the header chip
            and didn't warrant its own Settings slot. */}

        {/* Financial Assumptions + Data Rules sections were removed
            from Settings per the operator's directive. Financial
            Assumptions was three read-only labels that didn't earn
            their slot; Data Rules belongs in Command Center → Data
            where the threshold sliders sit alongside the other data
            controls. Both component files
            (`FinancialAssumptionsCard.tsx` + `DataRulesCard.tsx`)
            stay on disk for revert; the DataRulesCard import below
            stays only so Command Center → Data can render it. */}

        {/* Plan & usage section removed per operator directive
            (May 2026). The same surface lives in three other
            authenticated places — keeping it in Settings was the third
            seat at the same table:
              · /pricing — UsageThisMonth + status strip (full picture)
              · AccountMenu — docs-this-month + progress bar (glanceable)
              · Settings → Billing — current plan + price + email
            `PlanUsageCard` component file stays on disk for revert. */}

        {/* Billing — simplified per operator directive (May 2026): just
            Current plan + Billing email + Manage subscription. The
            subtitle was dropped because the card is now self-evident.
            Prices come from /api/plan/state (server config). */}
        <Section title={t("settings.billing_title")}>
          <BillingSection />
        </Section>

        {/* Data — workspace housekeeping. Only one control today: a safe
            soft-delete sweep for the caller's own uploads. Reuses the
            existing `deleted_at` mechanism via a new thin batch endpoint
            (POST /api/documents/clear-mine) that intentionally does NOT
            invoke _maybe_drop_empty_period — orphaned empty periods are
            Bug A's domain and are left alone here. */}
        <Section
          title="Data"
          subtitle="Manage the documents and analyses in your workspace."
        >
          <DataSection />
        </Section>

        {/* F5.0 Step 3 (CFO AI Learn) — learning-mode picker. Lets the
            user switch between Guided / Subtle / Off and reset the
            tutorialsSeen + coachDismissed flags. The underline + tour
            visibility responds immediately via the data-attribute CSS
            rules in src/styles/learning.css. */}
        <Section
          title="Learning"
          subtitle="How CFO AI Learn appears across the app. Affects underlined numbers, page tours, and the first-run coach."
        >
          <LearningSettingsSection />
        </Section>

        <Section title={t("settings.security_title")} subtitle={t("settings.security_subtitle")}>
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

        {/*
          REMOVED (still on disk for reversibility):
            · <Section title="Subscription"> + <SubscriptionCard> —
              duplicated `<BillingSection />` above. Function def kept.
            · <Section title="Integrations"> + <IntegrationsStub> —
              ERP/Slack/email teaser, no working backend. Function def kept.
            · <WorkspaceCard /> — org-rename input. The workspace label
              only affects the header chip and didn't earn a Settings
              slot. Function def kept.
            · <Section title="Industry classification"> + <IndustrySection /> —
              per-period field. The picker lives at the top of the
              Benchmark report and on each period view, so a Settings
              entry was a confused second seat. Function def kept.
        */}
      </div>
    </AppShell>
  );
}

/* ───────── Industry section (Phase E) ──────────────────────────────────── */

/**
 * IndustrySection — the workspace-level view of the per-period industry
 * assignment. Reads `?period=<id>` from the URL via useActivePeriod so the
 * Settings page can be deep-linked to a specific period
 * (e.g. /settings?period=<uuid>). When no period is set, the section
 * surfaces an "Open a period first" empty state — Settings has no way to
 * pick a period itself.
 */
function IndustrySection() {
  const { id: periodId } = useActivePeriod();
  const [pickerOpen, setPickerOpen] = useState(false);

  if (!periodId) {
    return (
      <div
        data-testid="settings-industry-empty"
        className="rounded-lg border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-mute"
      >
        Open any period (Dashboard, Cash, Profit…) and come back here to
        review or change its industry classification. The picker also lives
        at the top of the Benchmark report.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <IndustryBadge
        periodId={periodId}
        variant="full"
        onClickChange={() => setPickerOpen(true)}
      />
      <details className="group">
        <summary className="cursor-pointer text-[12.5px] text-ink-soft hover:text-ink select-none">
          View change history
        </summary>
        <div className="mt-3">
          <IndustryAuditTrail periodId={periodId} limit={20} />
        </div>
      </details>
      {pickerOpen && (
        <IndustryPicker
          periodId={periodId}
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
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
  const { t } = useTranslation();
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setProfile] = useState<Profile | null>(null);
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
      // Fall back to user_metadata for first-time users who haven't saved
      // a profile row yet (signUp seeds display_name + company_name into
      // user_metadata but doesn't always backfill the profiles table).
      const meta = (user.user_metadata ?? {}) as Record<string, string | undefined>;
      setName(p.full_name ?? p.display_name ?? meta.display_name ?? "");
      setCompany(p.company_name ?? meta.company_name ?? "");
      setRole(p.role ?? "member");
    })();
  }, [user]);

  async function save() {
    const sb = getSupabase();
    if (!sb || !user) return;
    setBusy(true);
    // UPSERT, not UPDATE — first-time users won't have a profile row yet
    // because the auth-trigger that seeds it can lag behind signUp by a few
    // seconds. UPDATE with no matching row silently succeeds with 0 affected
    // rows, the user clicks Save, sees the toast, but nothing persists.
    // The upsert with `id` as the conflict target fixes both cases.
    const { error: pErr } = await sb
      .from("profiles")
      .upsert(
        { id: user.id, full_name: name, company_name: company, role, email: user.email },
        { onConflict: "id" },
      );
    // Also mirror into user_metadata so `useAuth().displayName` /
    // `companyName` / `workspaceLabel` reflect the change without a full
    // session refresh (those memo'd values read from user_metadata).
    const { error: aErr } = await sb.auth.updateUser({
      data: { display_name: name, company_name: company },
    });
    setBusy(false);
    const error = pErr ?? aErr;
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
    <Section title={t("settings.profile_title")} subtitle={t("settings.profile_subtitle")}>
      <div className="rounded-2xl border border-rule bg-surface px-5 py-5 space-y-4">
        <Field label={t("settings.full_name")}>
          <Input value={name} onChange={setName} placeholder="Alex Maier" />
        </Field>
        <Field label={t("settings.company")}>
          <Input value={company} onChange={setCompany} placeholder="Acme Romania SRL" />
        </Field>
        <Field label={t("settings.role")}>
          <Input value={role} onChange={setRole} placeholder="CFO" />
        </Field>
        <div className="flex items-center justify-between pt-1">
          <p className="text-[11px] text-ink-mute">{t("settings.email")} <span className="text-ink-soft">{user.email}</span></p>
          <button
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand text-paper px-3.5 py-1.5 text-[12.5px] font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {busy ? t("settings.saving") : t("settings.save_profile")}
          </button>
        </div>
      </div>
    </Section>
  );
}

/* ───────── Language card ───────────────────────────────────────────────── */

function LanguageCard() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { toast } = useToast();

  async function pickLanguage(code: string) {
    // 1. Local — i18next changeLanguage + localStorage persist.
    setLanguage(code);
    // 2. Backend — mirror to profiles.language so the choice survives a
    // browser cache clear or a sign-in on a new device. Best-effort; if
    // the column doesn't exist (migration not yet applied) we still keep
    // the local change.
    if (user) {
      const sb = getSupabase();
      if (sb) {
        try {
          await sb.from("profiles").update({ language: code }).eq("id", user.id);
        } catch {
          /* `language` column may not exist yet — non-fatal */
        }
        // Also stash in auth metadata as a fallback persistence layer.
        try {
          await sb.auth.updateUser({ data: { language: code } });
        } catch { /* non-fatal */ }
      }
    }
    // Visible feedback so the user knows the switch happened even if their
    // current page's labels happen to be hardcoded strings.
    const langName = SUPPORTED_LANGUAGES.find((l) => l.code === code)?.label ?? code;
    toast({ title: `Language: ${langName}` });
  }

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
                onClick={() => void pickLanguage(lang.code)}
                data-testid={`lang-${lang.code}`}
                className={`inline-flex items-center gap-1.5 h-11 sm:h-9 px-3 rounded-lg border text-[12.5px] transition-colors ${
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

/* ───────── Currency display card ───────────────────────────────────────── */
//
// Mirrors the top-bar CurrencyToggle and adds:
//   · rate provenance line ("from BNR, updated 23 May 2026")
//   · "Refresh now" button to force-pull fresh rates
//
// The shared currency context means the choice made here is the same
// choice reflected in the top bar (and vice versa). No duplicate state.

function CurrencyCard() {
  const { t } = useTranslation();
  const { display, rates, setDisplay, refresh, refreshing } = useCurrencyContext();
  const fetchedAt = rates?.fetched_at ? new Date(rates.fetched_at) : null;
  const fetchedAtLabel = fetchedAt
    ? fetchedAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
  const sourceLabel = rates?.source === "BNR" ? "BNR (Banca Națională a României)" : "offline fallback";
  const oneEurInRon = rates?.rates?.RON?.toFixed(4) ?? "—";

  return (
    <div className="rounded-2xl border border-rule bg-surface px-5 py-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-serif text-[18px] text-ink">
            {t("settings.currency", "Display currency")}
          </h3>
          <p className="mt-1 text-[12.5px] text-ink-soft max-w-[520px]">
            {t(
              "settings.currency_description",
              "Choose the currency every monetary figure in the app is displayed in. Values are stored in their native currency; conversion happens at display time only.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {(["RON", "EUR", "USD"] as const).map((c) => {
            const active = display === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setDisplay(c)}
                data-testid={`settings-currency-${c.toLowerCase()}`}
                className={`inline-flex items-center gap-1.5 h-11 sm:h-9 px-3 rounded-lg border text-[12.5px] transition-colors ${
                  active
                    ? "bg-ink text-paper border-ink"
                    : "bg-surface text-ink-soft border-rule hover:text-ink hover:border-rule-strong"
                }`}
              >
                <span>{c}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-4 pt-4 border-t border-rule/60 flex items-center justify-between gap-3 flex-wrap text-[12px] text-ink-soft">
        <div>
          <div>
            {t("settings.currency_rate", "Reference rate")}: 1 EUR ={" "}
            <span className="font-mono">{oneEurInRon}</span> RON
          </div>
          <div className="mt-0.5 text-[11.5px]">
            {t("settings.currency_source", "Source")}: {sourceLabel} ·{" "}
            {t("settings.currency_updated", "Updated")} {fetchedAtLabel}
            {rates?.stale && (
              <span className="ml-1 text-amber-600">
                · {t("settings.currency_stale", "offline fallback")}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          data-testid="settings-currency-refresh"
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-rule text-[12px] text-ink-soft hover:text-ink hover:border-rule-strong transition-colors disabled:opacity-50"
        >
          {refreshing && <Loader2 size={12} className="animate-spin" />}
          {refreshing
            ? t("settings.currency_refreshing", "Refreshing…")
            : t("settings.currency_refresh", "Refresh now")}
        </button>
      </div>
    </div>
  );
}

/* ───────── Workspace card ──────────────────────────────────────────────── */

function WorkspaceCard() {
  const { t } = useTranslation();
  const { user, workspaceLabel } = useAuth();
  const { toast } = useToast();
  const [name, setName] = useState(workspaceLabel ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    const sb = getSupabase();
    if (!sb) return;
    void (async () => {
      // Source of truth for the workspace name shown in the header is the
      // user's primary `organizations` row (where CAEN code, industry, etc.
      // also live). The legacy `workspaces` table is empty for most users
      // — reading from it alone produced a stale empty input and the
      // previous Save handler silently no-op'd because UPDATE matched 0
      // rows. Now we hydrate from the org name (joined via memberships).
      try {
        const { data: m } = await sb
          .from("memberships")
          .select("org_id")
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();
        const orgId = m?.org_id as string | undefined;
        if (!orgId) return;
        const { data: org } = await sb
          .from("organizations")
          .select("name")
          .eq("id", orgId)
          .maybeSingle();
        if (org?.name) setName(org.name);
      } catch {
        /* fallback to workspaceLabel from useAuth */
      }
    })();
  }, [user]);

  async function save() {
    const sb = getSupabase();
    if (!sb || !user) return;
    setBusy(true);
    // Save to the user's primary organization — that's what powers the
    // header label + every benchmark report. We resolve the org via the
    // user's membership rather than a hard-coded owner_id (orgs are
    // multi-tenant; one user can be a member of many).
    let error: { message?: string } | null = null;
    try {
      const { data: m, error: memErr } = await sb
        .from("memberships")
        .select("org_id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();
      if (memErr) {
        error = memErr;
      } else if (m?.org_id) {
        const { error: orgErr } = await sb
          .from("organizations")
          .update({ name })
          .eq("id", m.org_id);
        if (orgErr) error = orgErr;
      } else {
        error = { message: "No organization membership found for this user." };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      error = { message: msg };
    }
    // Mirror into auth metadata so the header / workspaceLabel updates
    // immediately without waiting for a session refresh round-trip.
    if (!error) {
      await sb.auth.updateUser({ data: { company_name: name } });
    }
    setBusy(false);
    if (error) toast({ title: "Couldn't save workspace", description: error.message ?? "Unknown error", variant: "destructive" });
    else toast({ title: "Workspace renamed" });
  }

  if (!user) return null;

  return (
    <Section title={t("settings.workspace_title")} subtitle={t("settings.workspace_subtitle")}>
      <div className="rounded-2xl border border-rule bg-surface px-5 py-5 space-y-4">
        <Field label={t("settings.workspace_name")}>
          <Input value={name} onChange={setName} placeholder="My company" />
        </Field>
        <div className="flex justify-end pt-1">
          <button
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand text-paper px-3.5 py-1.5 text-[12.5px] font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {busy ? t("settings.saving") : t("settings.save_workspace")}
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
  const { t } = useTranslation();
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
      <Row icon={Lock} title={t("settings.password")}>
        <button
          onClick={sendPasswordReset}
          disabled={busy || !email}
          className="text-[12px] text-ink-soft hover:text-ink transition-colors disabled:opacity-50"
        >
          {busy ? t("settings.sending") : t("settings.send_reset_email")}
        </button>
      </Row>
      <Row icon={Shield} title={t("settings.2fa")}>
        <span className="text-[12px] text-ink-mute">{t("settings.coming_soon")}</span>
      </Row>
      {/* Sign-out row removed (May 2026 redesign) — the THE single
          sign-out lives in the top-right account dropdown
          (`<AccountMenu/>`, data-testid="account-menu-sign-out"). The
          `onSignOut` prop above stays wired so this is a one-line JSX
          restore if ever needed. */}
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

/* ───────── Data section — safe "Clear my uploads" ───────────────────────
 *
 * Single control: a destructive-looking button that, on confirm, calls
 * POST /api/documents/clear-mine. That endpoint sets `deleted_at = now()`
 * on every live document in the caller's org via ONE PostgREST UPDATE.
 * It intentionally does NOT trigger `_maybe_drop_empty_period` (the Bug A
 * cascade). Orphaned empty periods left behind are Bug A's domain and
 * are NOT cleaned here.
 *
 * UX:
 *   · Two-step gate: first click opens an inline confirm row; the user
 *     must explicitly click "Yes, clear them" to proceed. No type-to-
 *     confirm because the action is reversible at the row level
 *     (deleted_at can be cleared if support intervenes).
 *   · While in flight, both buttons disable + the primary shows a spinner.
 *   · On success: toast with the count + page-reload signal via
 *     `window.location.assign('/dashboard')` so DocumentSwitcher / quick
 *     cards re-fetch and the empty state appears.
 */
function DataSection() {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function clearMyUploads() {
    setBusy(true);
    try {
      const sb = getSupabase();
      const { data: session } = sb
        ? await sb.auth.getSession()
        : { data: { session: null } };
      const token = session?.session?.access_token;
      if (!token) {
        toast({
          title: "Not signed in",
          description: "Sign in to manage your uploads.",
          variant: "destructive",
        });
        return;
      }
      const apiUrl =
        (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
      const r = await fetch(`${apiUrl}/api/documents/clear-mine`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(body || `HTTP ${r.status}`);
      }
      const { deleted_count } = (await r.json()) as { deleted_count: number };
      toast({
        title: deleted_count === 0
          ? "No uploads to clear"
          : `Cleared ${deleted_count} upload${deleted_count === 1 ? "" : "s"}`,
        description: deleted_count === 0
          ? "Your workspace is already empty."
          : "Documents are hidden from the dashboard. Contact support if you need them restored within 30 days.",
      });
      setConfirming(false);
      // Bounce to the dashboard so every active query re-reads the fresh
      // state (DocumentSwitcher, PublicRecordsQuickCard, etc.).
      if (deleted_count > 0) {
        window.location.assign("/dashboard");
      }
    } catch (e) {
      toast({
        title: "Couldn't clear uploads",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-rule bg-bg-2/30 px-5 py-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
            <Trash2 size={14} strokeWidth={1.75} className="text-ink-soft" />
            Clear all my uploaded documents
          </div>
          <p className="mt-1.5 text-[12.5px] text-ink-soft leading-relaxed max-w-[520px]">
            Hides every document (and its analysis) you've uploaded to this workspace.
            Reversible by support for 30 days. Does not affect other organizations or
            other users' uploads.
          </p>
        </div>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            data-testid="settings-clear-uploads"
            className="shrink-0 inline-flex items-center gap-1.5 h-11 sm:h-9 px-3.5 rounded-lg border border-rule bg-surface text-[12.5px] font-medium text-ink hover:bg-bg-2 transition-colors"
          >
            <Trash2 size={13} strokeWidth={1.75} />
            Clear uploads…
          </button>
        ) : (
          <div className="shrink-0 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="inline-flex items-center h-11 sm:h-9 px-3 rounded-lg border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { void clearMyUploads(); }}
              data-testid="settings-confirm-clear"
              className="inline-flex items-center gap-1.5 h-11 sm:h-9 px-3.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[12.5px] font-medium disabled:opacity-60 transition-colors"
            >
              {busy
                ? <><Loader2 size={13} className="animate-spin" />Clearing…</>
                : <><Trash2 size={13} strokeWidth={1.75} />Yes, clear them</>}
            </button>
          </div>
        )}
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
  icon: LucideIcon;
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
