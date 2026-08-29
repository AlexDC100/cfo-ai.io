// /settings — Profile, Language, Workspace, Billing, Data, Security.
//
// Settings IA after the May-2026 cleanup pass: five real-feature sections,
// in a single column, with one obvious action per row. Removed: the
// duplicate "Subscription" section (covered by Billing → BillingSection)
// and the "Integrations" section (IntegrationsStub was an ERP/Slack/email
// teaser with no functional backend). Both removed components remain on
// disk so the change is fully reversible.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/instrument/Panel";
import { Amount } from "@/components/instrument/Amount";
import { ModeSwitch } from "@/components/instrument/shell/ModeSwitch";
import { AppearanceSection } from "@/components/cfo/settings/AppearanceSection";
import { SegmentedControl } from "@/components/cfo/settings/SegmentedControl";
import "./settingsXI18n";
import { debugSendMail, debugSendAllMail, type DebugMailKind } from "@/lib/newsletterApi";
import { SUPPORTED_LANGUAGES, setLanguage } from "@/i18n";
import { useAuth } from "@/lib/auth";
import { useActiveOrg } from "@/lib/org";
// useSubscription/isSubscriptionEntitled/planFor/trialDaysLeft + supabaseEnabled
// were used by the removed `Subscription` section; <BillingSection /> now
// owns that surface internally. Re-import here if/when the standalone
// Subscription section is restored.
import { getSupabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  cancelAtPeriodEnd,
  useInvalidateBilling,
  useStripeSubscription,
} from "@/lib/stripeBilling";
import { usePlanState } from "@/lib/planState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { toast as sonnerToast } from "sonner";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Pencil,
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

/** True only when the app is being served from localhost.
 *
 *  Gates the two "Debug —" sections below. Checked at runtime on the
 *  hostname rather than via `import.meta.env.DEV`, because the frontend is
 *  also served from a production-mode bundle by the local `cfo-ai-frontend`
 *  container — a DEV check would hide the debug tools in exactly the
 *  local setup that wants them. Anything reachable at a real domain is,
 *  by definition, not localhost, so prod never renders these. */
function isLocalhost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

export default function Settings() {
  const { t } = useTranslation();
  const { user } = useAuth();
  // Debug sections (email-template preview + toast preview) are developer
  // tools, not product surface — they self-send real email and fire every
  // toast variant. Local only.
  const showDebug = isLocalhost();
  // Sign-out (and its navigate/toast) moved out with the old Security
  // section — the single sign-out now lives in the top-right AccountMenu.
  // useSubscription / planFor / etc. were used by the removed standalone
  // `Subscription` section; <BillingSection/> manages its own state, so
  // the page-level subscription hook is no longer needed here.

  return (
    <>
      {/* Instrument header — 11px caps eyebrow → 19px title. The serif
          hero is retired on authenticated screens; the subtitle rides
          below as quiet context. */}
      <div data-testid="settings-header" className="mb-6">
        <PageHeader eyebrow={t("sidebar.settings")} title={t("settings.title")} />
        <p className="mt-1 max-w-[560px] text-[12.5px] text-ink-soft">
          {t("settings.subtitle")}
        </p>
      </div>

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
        {/* Language — presented like Billing (Section title + card); the
            card's own serif <h3> title was removed for the Section <h2>. */}
        <Section title={t("settings.language")} divider>
          <LanguageCard />
        </Section>

        {/* Display currency — presented like Billing: a Section title
            header above the bordered card (the card's own serif <h3>
            title was removed so the Section <h2> is the single heading). */}
        <Section title={t("settings.currency", "Display currency")} divider>
          <CurrencyCard />
        </Section>

        {/* Appearance — theme (Paper/Terminal) + density, plus THE DIAL's
            view mode (Simple/Pro). The mode block lives here rather than
            inside AppearanceSection (another lane's file): same ModeSwitch
            control as the header, framed by the section's label + hint
            pattern. */}
        <Section title={t("settingsX.appearance.title")} divider>
          <div className="space-y-5">
            <AppearanceSection />
            <div>
              <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-soft">
                {t("modes.switch.label")}
              </div>
              <ModeSwitch />
              <p className="mt-1.5 max-w-[520px] text-[11px] text-ink-soft">
                {t("modes.switch.hint")}
              </p>
            </div>
          </div>
        </Section>

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
            were removed in the 2026-07 dead-code cleanup
            (recoverable from git history). */}

        {/* Plan & usage section removed per operator directive
            (May 2026). The same surface lives in three other
            authenticated places — keeping it in Settings was the third
            seat at the same table:
              · /pricing — UsageThisMonth + status strip (full picture)
              · AccountMenu — docs-this-month + progress bar (glanceable)
              · Settings → Billing — current plan + price + email
            `PlanUsageCard` was removed in the 2026-07 dead-code
            cleanup (recoverable from git history). */}

        {/* Billing — simplified per operator directive (May 2026): just
            Current plan + Billing email + Manage subscription. The
            subtitle was dropped because the card is now self-evident.
            Prices come from /api/plan/state (server config). */}
        <Section title={t("settings.billing_title")} divider>
          <BillingSection />
        </Section>

        {/* The old standalone "Data" section (clear-my-uploads) has moved
            into the Danger Zone at the bottom of the page, alongside the
            security actions. `DataSection` stays defined on disk for
            revert. */}

        {/* F5.0 Step 3 (CFO AI Learn) — learning-mode picker. Lets the
            user switch between Guided / Subtle / Off and reset the
            tutorialsSeen + coachDismissed flags. The underline + tour
            visibility responds immediately via the data-attribute CSS
            rules in src/styles/learning.css. */}
        <Section
          title="Learning"
          subtitle="How CFO AI Learn appears across the app. Affects underlined numbers, page tours, and the first-run coach."
          divider
        >
          <LearningSettingsSection />
        </Section>

        {/* Newsletter section removed per operator directive (2026-07-27).
            `components/NewsletterSettings.tsx` stays on disk — Settings was
            its only mount point, so this is a one-line JSX restore, and the
            backend routes it calls (src/engine/api/_newsletter.py) are
            still live for the marketing-site signup + confirm-link flow. */}

        {/* Debug sections — localhost only (see `isLocalhost` above).
            Both are developer tools that leaked into the production
            account page: the email preview self-sends real Resend mail,
            and the toast preview fires every variant at once. */}
        {showDebug && (
          // One dashed enclosure with a single "Debug" heading. The dashed
          // rule is the signal that everything inside is a developer tool
          // and not part of the product — which is why the two children
          // no longer need to repeat "Debug —" in their own titles.
          <section
            data-testid="settings-debug"
            className="rounded-2xl border border-dashed border-rule-strong/70 px-5 py-5 space-y-6"
          >
            <div>
              <h2 className="text-[15px] font-medium text-ink">Debug</h2>
              <p className="mt-0.5 text-[12.5px] text-ink-soft">
                Developer tools. Visible on localhost only.
              </p>
            </div>

            {/* Email preview. Sends any branded mail type to the signed-in
                user's OWN email (backend enforces self-send only). Lets Alex
                eyeball every template end-to-end without triggering the real
                flows. Backed by POST /api/newsletter/debug-send. */}
            <Section
              title="Email preview"
              subtitle="Send any app email type to your own inbox to preview its styling. Delivered only to you."
            >
              <DebugEmailSection email={user?.email ?? null} />
            </Section>

            {/* Toast preview. Fires every toast variation the app can produce
                (both notification systems) so styling regressions are caught
                by eye in seconds — added 2026-07-23 after the sonner toasts
                shipped with no background. */}
            <Section
              title="Toast preview"
              subtitle="Fire every toast variation (success, error, warning, info, loading, action, plus the legacy system) to verify styling."
            >
              <DebugToastSection />
            </Section>
          </section>
        )}

        {/* Disclaimer — the sidebar modal's content, seated as a real
          Settings section (same i18n keys, one source of truth). There is
          no standalone /disclaimer route to preserve. */}
      <Section title={t("sidebar.disclaimer")} divider>
        <p
          data-testid="settings-disclaimer"
          className="max-w-[560px] text-[12.5px] leading-relaxed text-ink-soft"
        >
          {t("sidebar.footer_note")}
        </p>
      </Section>

      {/* Danger Zone — GitHub-style. Consolidates the security actions
            (password reset, 2FA) and the destructive clear-my-uploads sweep
            that used to live in the separate Security / Data sections.
            Rendered without a <Section> wrapper because it carries its own
            danger-icon header. */}
        <DangerZoneSection email={user?.email ?? null} />

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
    </>
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
        className="rounded-lg border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-soft"
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
}

function ProfileCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  // The name fields are read-only until the user opts into editing. Toggled
  // by the Edit button; also exits on focus leaving the field group.
  const [editing, setEditing] = useState(false);
  // What was last persisted — lets `exitEditing` skip a pointless round-trip
  // (and a "Profile saved" toast) when the user opened edit mode, changed
  // nothing, and tabbed away.
  const savedNameRef = useRef("");
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const [email, setEmail] = useState(user?.email ?? "");
  // Last confirmed-on-the-session address. Compared against the field to
  // decide whether Done needs to trigger an email-change confirmation.
  const savedEmailRef = useRef(user?.email ?? "");

  // The name is captured as two fields but still stored as the single
  // `profiles.full_name` column — no schema change. First token is the first
  // name, everything after it is the last name (so "Ana Maria Popescu" keeps
  // "Maria Popescu" together rather than dropping it).
  const name = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");

  useEffect(() => {
    if (!user) return;
    const sb = getSupabase();
    if (!sb) return;
    void (async () => {
      const { data } = await sb
        .from("profiles")
        .select("full_name, display_name")
        .eq("id", user.id)
        .maybeSingle();
      const p = (data ?? {}) as Profile;
      setProfile(p);
      // Fall back to user_metadata for first-time users who haven't saved
      // a profile row yet (signUp seeds display_name into user_metadata but
      // doesn't always backfill the profiles table).
      const meta = (user.user_metadata ?? {}) as Record<string, string | undefined>;
      const stored = (p.full_name ?? p.display_name ?? meta.display_name ?? "").trim();
      const gap = stored.indexOf(" ");
      setFirstName(gap === -1 ? stored : stored.slice(0, gap));
      setLastName(gap === -1 ? "" : stored.slice(gap + 1).trim());
      savedNameRef.current = stored;
      setEmail(user.email ?? "");
      savedEmailRef.current = user.email ?? "";
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
    // Company + role were removed from the profile per the operator's
    // directive — the account no longer collects them.
    const { error: pErr } = await sb
      .from("profiles")
      .upsert(
        { id: user.id, full_name: name, email: user.email },
        { onConflict: "id" },
      );
    // Also mirror into user_metadata so `useAuth().displayName` reflects the
    // change without a full session refresh.
    const { error: aErr } = await sb.auth.updateUser({
      data: { display_name: name },
    });
    setBusy(false);
    const error = pErr ?? aErr;
    if (error) toast({ title: "Couldn't save profile", description: error.message, variant: "destructive" });
    else {
      savedNameRef.current = name;
      toast({ title: "Profile saved" });
    }
  }

  /** Leave edit mode, persisting only if the name actually changed. Email is
   *  display-only (see the field below), so there's nothing else to save. */
  function exitEditing() {
    setEditing(false);
    if (name !== savedNameRef.current) void save();
  }

  /** Blur handler on the field GROUP, not the individual inputs: tabbing
   *  from First name to Last name blurs the first input, and exiting edit
   *  mode there would fight the user mid-entry. `relatedTarget` is whatever
   *  is receiving focus — if it's still inside this group (or is the Edit
   *  button, which does its own toggling), stay in edit mode. */
  function handleGroupBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!editing) return;
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    exitEditing();
  }

  function toggleEditing() {
    if (editing) {
      exitEditing();
      return;
    }
    setEditing(true);
    // Put the caret in First name so the button click is the only
    // interaction needed before typing.
    window.setTimeout(() => firstInputRef.current?.focus(), 0);
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
    // Heading + subtitle ("Profile / How CFO AI introduces you across the
    // app.") removed 2026-07-27 — the two labelled name fields and the email
    // line say what this is. `settings.profile_title` / `profile_subtitle`
    // stay in the locale files for a one-line restore.
    <section>
      {/* onBlur on the wrapper (React bubbles focus events) so focus moving
          BETWEEN the two name fields doesn't close edit mode. */}
      <div className="space-y-4" onBlur={handleGroupBlur}>
        {/* Edit sits on the same line as the two name fields — `items-end`
            aligns it to the inputs rather than to their labels. */}
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[150px]">
            <Field label={t("settings.first_name")}>
              <Input
                value={firstName}
                onChange={setFirstName}
                placeholder="Alex"
                readOnly={!editing}
                inputRef={firstInputRef}
                ariaLabel={t("settings.first_name")}
              />
            </Field>
          </div>
          <div className="flex-1 min-w-[150px]">
            <Field label={t("settings.last_name")}>
              <Input
                value={lastName}
                onChange={setLastName}
                placeholder="Maier"
                readOnly={!editing}
                ariaLabel={t("settings.last_name")}
              />
            </Field>
          </div>
          {/* One button for both states. Saving is a side effect of leaving
              edit mode (here or via blur), so there is no separate Save —
              the name can't be left in an edited-but-unsaved state. */}
          <button
            onClick={toggleEditing}
            disabled={busy}
            data-testid="settings-profile-edit"
            aria-pressed={editing}
            // While editing, the brand-tinted border is the "this is the
            // active thing" signal — flat, no animated fill, matching the
            // segmented controls below.
            className={cn(
              "shrink-0 inline-flex items-center justify-center gap-1.5 h-8 rounded-sm px-3 text-[12.5px] font-medium border disabled:opacity-50 transition-colors duration-micro",
              editing
                ? "bg-surface text-ink border-brand/60"
                : "bg-surface border-rule text-ink-soft hover:text-ink hover:border-rule-strong",
            )}
          >
            {!editing && <Pencil size={12} strokeWidth={1.75} />}
            {busy
              ? t("settings.saving")
              : editing
                ? t("settings.done", "Done")
                : t("settings.edit", "Edit")}
          </button>
        </div>
        {/* Email is display-only. It's the sign-in identity, and changing it
            is a confirm-by-link flow rather than a field edit — so it stays
            read-only even in edit mode instead of looking editable and then
            behaving differently from the two fields beside it. */}
        <Field label={t("settings.email")}>
          <Input value={email} onChange={setEmail} readOnly ariaLabel={t("settings.email")} />
        </Field>
      </div>
    </section>
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
    toast({ title: `${t("settings.language")}: ${langName}` });
  }

  return (
    <div>
      {/* Description above, buttons below — the picker used to sit to the
          RIGHT of the description, which put the control furthest from the
          text explaining it and left the row unbalanced once the card border
          was removed. */}
      <div className="space-y-3">
        <p className="text-[12.5px] text-ink-soft max-w-[480px]">
          {t("settings.language_description")}
        </p>
        {/* Segmented control — one hairline rail, the active language
            raised to surface. The pickLanguage flow (setLanguage +
            profile mirror + toast) is unchanged. */}
        <SegmentedControl
          value={
            SUPPORTED_LANGUAGES.find((l) => i18n.language?.startsWith(l.code))?.code ??
            SUPPORTED_LANGUAGES[0]?.code ??
            "en"
          }
          onChange={(code) => void pickLanguage(code)}
          ariaLabel={t("settings.language")}
          options={SUPPORTED_LANGUAGES.map((lang) => ({
            value: lang.code,
            label: lang.label,
            badge: lang.badge,
            testId: `lang-${lang.code}`,
          }))}
        />
      </div>
    </div>
  );
}

/* ───────── Currency display card ───────────────────────────────────────── */
//
// Mirrors the top-bar CurrencyToggle and adds a rate provenance line
// ("1 EUR = X RON / Y USD, from BNR, updated <date>").
//
// The shared currency context means the choice made here is the same
// choice reflected in the top bar (and vice versa). No duplicate state.
//
// The "Refresh now" button was removed 2026-07-27 — see the note at the
// provenance block below. `refresh` / `refreshing` are still on the
// context for other callers and for a one-line restore.

function CurrencyCard() {
  const { t } = useTranslation();
  const { display, rates, setDisplay } = useCurrencyContext();
  const fetchedAt = rates?.fetched_at ? new Date(rates.fetched_at) : null;
  const fetchedAtLabel = fetchedAt
    ? fetchedAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
  const sourceLabel = rates?.source === "BNR" ? "BNR (Banca Națională a României)" : "offline fallback";
  // Quoted FROM the selected currency ("1 <selected> = X <other>"), so the
  // line reads in the same direction as the conversion the app is applying
  // to every figure on screen. The payload is EUR-based (each entry is
  // "units per 1 EUR"), so 1 display in TO = rates[TO] / rates[display].
  const crossRates = (["RON", "EUR", "USD"] as const)
    .filter((c) => c !== display)
    .map((to) => {
      const from = rates?.rates?.[display];
      const t = rates?.rates?.[to];
      return {
        to,
        // Raw number; <Amount> owns formatting (4 dp holds up in both
        // directions: RON→EUR ~0.1911, the reverse ~5.2327) and renders
        // the missing marker itself when the feed is absent.
        value: from && t ? t / from : null,
      };
    });

  return (
    // Whole card left, live cross-rates right — the rates read as a
    // standing readout for the section rather than as a footnote attached
    // to the toggle row alone.
    <div className="flex items-start justify-between gap-6 flex-wrap">
      {/* Description above, toggle below — matches LanguageCard. */}
      <div className="space-y-3 flex-1 min-w-[280px]">
        <div>
          <p className="text-[12.5px] text-ink-soft max-w-[520px]">
            {t(
              "settings.currency_description",
              "Choose the currency every monetary figure in the app is displayed in. Values are stored in their native currency; conversion happens at display time only.",
            )}
          </p>
          {/* Provenance sits with the description, not with the numbers —
              it qualifies where the whole feed comes from, and inside the
              rates box it read as a footnote to those two lines only. */}
          <div className="mt-1 text-[11px] text-ink-soft">
            {t("settings.currency_source", "Source")}: {sourceLabel} ·{" "}
            {t("settings.currency_updated", "Updated")} {fetchedAtLabel}
            {rates?.stale && (
              <span className="ml-1 text-caution">
                · {t("settings.currency_stale", "offline fallback")}
              </span>
            )}
          </div>
        </div>
        {/* Matches the language segmented control above. */}
        <SegmentedControl
          value={display}
          onChange={(c) => setDisplay(c)}
          ariaLabel={t("settings.currency", "Display currency")}
          options={(["RON", "EUR", "USD"] as const).map((c) => ({
            value: c,
            label: c,
            testId: `settings-currency-${c.toLowerCase()}`,
          }))}
        />
      </div>

      {/* Live cross-rates readout — mono via <Amount>; no provenance
          affordance because the FX payload carries none (never fake it).
          The caption scopes the numbers: conversion is presentational,
          the stored figures stay in their native currency. */}
      <div className="shrink-0 rounded-md border border-rule bg-bg-2/40 px-3.5 py-2.5 text-[12px] text-ink-soft">
        {crossRates.map((r) => (
          <div key={r.to} className="flex items-baseline gap-1.5">
            <span>1 {display} =</span>
            <Amount
              value={r.value}
              kind="count"
              fractionDigits={4}
              className="text-[12px] text-ink"
            />
            <span>{r.to}</span>
          </div>
        ))}
        <div className="mt-1 border-t border-rule-soft pt-1 text-[10.5px] text-ink-soft">
          {t("settingsX.currency.display_only")}
        </div>
      </div>
      {/* "Refresh now" removed (2026-07-27). Rates now come from the
          `fx-rates` Edge Function, which keeps one shared BNR row refreshed
          daily for every user — a manual per-user refresh button no longer
          buys anything the page doesn't already do on mount. The context
          still exposes `refresh()` for a one-line restore. */}
    </div>
  );
}

/* ───────── Workspace card ──────────────────────────────────────────────── */

function WorkspaceCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { org, renameWorkspace } = useActiveOrg();
  const { toast } = useToast();
  const [name, setName] = useState(org?.name ?? "");
  const [busy, setBusy] = useState(false);

  // Renames the ACTIVE workspace. This used to resolve `memberships … limit 1`
  // inline (twice) and rename whichever organization came back first — wrong
  // as soon as a user has more than one company.
  useEffect(() => {
    if (org?.name) setName(org.name);
  }, [org?.name]);

  async function save() {
    if (!org) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    const ok = await renameWorkspace(org.id, trimmed);
    setBusy(false);
    // Deliberately NOT mirrored into auth metadata (`company_name`). That is a
    // per-user field and cannot represent N companies — writing it here made
    // the header chip show the last-renamed workspace regardless of which one
    // was active. The header reads the active org's name instead.
    if (ok) toast({ title: "Workspace renamed" });
    else toast({ title: "Couldn't save workspace", description: "The rename was rejected.", variant: "destructive" });
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
            <span className="text-[22px] font-semibold leading-none tracking-[-0.01em] text-ink">
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
        <p className="text-[11.5px] text-ink-soft">
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
            className="text-[11px] text-ink-soft hover:text-ink transition-colors"
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
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-soft font-medium">{label}</div>
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
        <span className="text-[12px] text-ink-soft">{t("settings.coming_soon")}</span>
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
      <div className="px-5 py-3 text-[11.5px] text-ink-soft flex items-center gap-2">
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
            Clear uploads
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
              className="inline-flex items-center gap-1.5 h-11 sm:h-9 px-3.5 rounded-lg bg-alert hover:bg-alert/90 text-white text-[12.5px] font-medium disabled:opacity-60 transition-colors"
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

/* ───────── Debug — email preview (self-send) ────────────────────────────
 *
 * One "Send" button per app mail type. Each calls
 * POST /api/newsletter/debug-send, which the backend delivers ONLY to the
 * caller's own verified email (no recipient field on the wire), so this is
 * safe to expose — you can only email yourself. Per-row busy state so
 * clicking one doesn't spin the others.
 */
const DEBUG_MAIL_TYPES: { kind: DebugMailKind; label: string; description: string }[] = [
  { kind: "signup_confirm", label: "Confirm signup", description: "Sent to verify a new account's email." },
  { kind: "password_reset", label: "Password reset", description: "The reset-your-password link email." },
  { kind: "newsletter_confirm", label: "Newsletter — confirm", description: "Double opt-in confirmation." },
  { kind: "newsletter_welcome", label: "Newsletter — welcome", description: "Sent after a subscription is confirmed." },
  { kind: "newsletter_broadcast", label: "Newsletter — broadcast", description: "Admin-composed broadcast wrapper (sample content)." },
  { kind: "renewal_reminder", label: "Renewal reminder", description: "Subscription-renews-soon heads-up." },
];

/* ───────── Debug — toast preview ────────────────────────────────────────
 * Fires one of each toast variation, staggered so they stack visibly:
 * sonner default / success / info / warning / error / loading / action,
 * then the legacy useToast default + destructive. Pure client-side. */
function DebugToastSection() {
  const { toast } = useToast();

  function fireAll() {
    const steps: Array<() => void> = [
      () => sonnerToast("Plain toast", { description: "Default sonner toast with a description." }),
      () => sonnerToast.success("Success toast", { description: "Something completed successfully." }),
      () => sonnerToast.info("Info toast", { description: "A neutral informational message." }),
      () => sonnerToast.warning("Warning toast", { description: "Something needs your attention." }),
      () => sonnerToast.error("Error toast", { description: "Something went wrong." }),
      () => {
        const id = sonnerToast.loading("Loading toast", { description: "Dismisses by itself in 3s." });
        window.setTimeout(() => sonnerToast.dismiss(id), 3000);
      },
      () => sonnerToast("Action toast", {
        description: "Carries an action button.",
        action: { label: "Undo", onClick: () => sonnerToast.success("Action clicked") },
      }),
      () => toast({ title: "Legacy toast", description: "Default variant of the useToast system." }),
      () => toast({ title: "Legacy destructive", description: "Destructive variant of the useToast system.", variant: "destructive" }),
    ];
    steps.forEach((fn, i) => window.setTimeout(fn, i * 350));
  }

  return (
    <button
      type="button"
      onClick={fireAll}
      data-testid="debug-send-toasts"
      className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3.5 py-2 text-[13px] font-medium text-ink hover:bg-bg-2 transition-colors"
    >
      <Sparkle size={14} strokeWidth={2} />
      Send all toast variations
    </button>
  );
}

function DebugEmailSection({ email }: { email: string | null }) {
  const { toast } = useToast();
  const [busyKind, setBusyKind] = useState<DebugMailKind | "all" | null>(null);

  async function send(kind: DebugMailKind, label: string) {
    if (!email) {
      toast({ title: "Not signed in", description: "Sign in to send preview emails.", variant: "destructive" });
      return;
    }
    setBusyKind(kind);
    try {
      const res = await debugSendMail(kind);
      toast({ title: `"${label}" sent`, description: `Delivered to ${res.to}. Check your inbox.` });
    } catch (e) {
      toast({
        title: `Couldn't send "${label}"`,
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusyKind(null);
    }
  }

  async function sendAll() {
    if (!email) {
      toast({ title: "Not signed in", description: "Sign in to send preview emails.", variant: "destructive" });
      return;
    }
    setBusyKind("all");
    try {
      const res = await debugSendAllMail();
      toast({
        title: "All preview emails sent",
        description: `${res.sent} emails delivered to ${res.to}. Check your inbox.`,
      });
    } catch (e) {
      toast({
        title: "Couldn't send preview emails",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <div className="rounded-2xl border border-rule bg-surface divide-y divide-rule/60">
      <div className="px-5 py-4 flex items-center justify-between gap-3 bg-bg-2/40">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-ink">All email types</div>
          <div className="text-[11.5px] text-ink-soft leading-snug">
            Sends every template below to your address in one batch.
          </div>
        </div>
        <button
          type="button"
          disabled={busyKind !== null || !email}
          onClick={() => void sendAll()}
          data-testid="settings-debug-email-send-all"
          className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-rule bg-surface text-[12.5px] font-medium text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors"
        >
          {busyKind === "all"
            ? <><Loader2 size={13} className="animate-spin" />Sending all…</>
            : <><Mail size={13} strokeWidth={1.75} />Send all</>}
        </button>
      </div>
      {DEBUG_MAIL_TYPES.map((m) => (
        <div key={m.kind} className="px-5 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-rule bg-bg-2 text-ink-soft shrink-0">
              <Mail size={14} strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <div className="text-[13.5px] text-ink truncate">{m.label}</div>
              <div className="text-[11.5px] text-ink-soft leading-snug">{m.description}</div>
            </div>
          </div>
          <button
            type="button"
            disabled={busyKind !== null || !email}
            onClick={() => void send(m.kind, m.label)}
            data-testid={`settings-debug-email-${m.kind}`}
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-rule bg-surface text-[12.5px] font-medium text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors"
          >
            {busyKind === m.kind
              ? <><Loader2 size={13} className="animate-spin" />Sending…</>
              : <><Mail size={13} strokeWidth={1.75} />Send</>}
          </button>
        </div>
      ))}
      <div className="px-5 py-3 text-[11.5px] text-ink-soft flex items-center gap-2">
        <AlertTriangle size={12} strokeWidth={1.75} />
        {email
          ? <>Preview emails are delivered only to <span className="text-ink-soft">{email}</span>. Requires RESEND_API_KEY on the backend.</>
          : "Sign in to send preview emails to yourself."}
      </div>
    </div>
  );
}

/* ───────── Danger Zone — destructive + security-sensitive actions ───────
 *
 * GitHub-style danger zone: an animated gradient border (animate-danger-
 * gradient, defined in tailwind.config.ts) framing a card with a danger-icon
 * header. Consolidates the security actions (password reset, 2FA) and the
 * destructive "clear all my uploads" sweep that previously lived in the
 * separate Security and Data sections.
 */
function DangerZoneSection({ email }: { email: string | null }) {
  const { toast } = useToast();
  const sb = getSupabase();
  const [pwBusy, setPwBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  // Which type-to-confirm dialog is open, if any. Both confirm on the
  // account email — the one string the user can't mistype from muscle
  // memory and can't confuse between the two actions.
  const [dangerDialog, setDangerDialog] = useState<null | "cancel" | "data" | "account">(null);

  // Show "Cancel plan" whenever the user is on a PAID tier, read from
  // /api/plan/state — the same source the plan card above renders, so the
  // row can't be missing for someone the page is telling they're on Pro.
  //
  // Gating on the Stripe `subscriptions` row instead (the obvious first
  // guess) hid the row for anyone whose paid tier isn't backed by a row
  // that /api/billing/subscription returns — it answers null on any
  // non-OK response or missing row, which is not the same question as
  // "is this user on a paid plan".
  //
  // Only two things hide it: a free tier (nothing to cancel), and Stripe
  // explicitly reporting the cancellation already happened.
  const { data: stripeSub } = useStripeSubscription();
  const { state: planState } = usePlanState();
  const invalidateBilling = useInvalidateBilling();
  const onPaidPlan = planState?.plan_key === "starter" || planState?.plan_key === "pro";
  const alreadyCancelled = Boolean(
    stripeSub && (stripeSub.cancel_at_period_end || stripeSub.status === "canceled"),
  );
  const hasCancellableSub = onPaidPlan && !alreadyCancelled;

  /** Cancels at PERIOD END, not immediately — the user keeps what they've
   *  paid for until the term runs out. Same endpoint the Stripe portal's
   *  cancel uses. */
  async function cancelPlan() {
    const ok = await cancelAtPeriodEnd();
    if (!ok) {
      toast({
        title: "Couldn't cancel",
        description: "Please try again, or use Manage to open the Stripe portal.",
        variant: "destructive",
      });
      return;
    }
    setDangerDialog(null);
    invalidateBilling();
    toast({
      title: "Plan cancelled",
      description: "You keep full access until the end of the current billing period.",
    });
  }

  /** Erases the contents of every workspace this user OWNS, keeping the
   *  account and the (now empty) workspaces. Backed by `delete_all_my_data()`
   *  — see supabase/schema_phase_account_deletion.sql. */
  async function deleteAllMyData() {
    if (!sb) return;
    const { data, error } = await sb.rpc("delete_all_my_data");
    if (error) {
      toast({ title: "Couldn't delete your data", description: error.message, variant: "destructive" });
      return;
    }
    setDangerDialog(null);
    const n = typeof data === "number" ? data : 0;
    toast({
      title: "All data deleted",
      description: `Cleared ${n} workspace${n === 1 ? "" : "s"}. Your account and workspaces are intact.`,
    });
    // Hard reload rather than a route change: every TanStack Query cache,
    // localStorage run cache and data-presence flag on this tab now
    // describes rows that no longer exist.
    window.location.assign("/dashboard");
  }

  /** Erases owned workspaces AND the auth user. Irreversible. */
  async function deleteMyAccount() {
    if (!sb) return;
    const { error } = await sb.rpc("delete_my_account");
    if (error) {
      toast({ title: "Couldn't delete your account", description: error.message, variant: "destructive" });
      return;
    }
    // The session's user no longer exists, so signOut is best-effort — it
    // only matters for clearing the local token, and a failure there
    // shouldn't block the redirect.
    try { await sb.auth.signOut(); } catch { /* identity is already gone */ }
    window.location.assign("/");
  }

  async function sendPasswordReset() {
    if (!sb || !email) return;
    setPwBusy(true);
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + "/login",
    });
    setPwBusy(false);
    if (error) toast({ title: "Couldn't send reset email", description: error.message, variant: "destructive" });
    else toast({ title: "Password reset email sent", description: `Check ${email}.` });
  }

  async function clearMyUploads() {
    setClearBusy(true);
    try {
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
      if (deleted_count > 0) window.location.assign("/dashboard");
    } catch (e) {
      toast({
        title: "Couldn't clear uploads",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setClearBusy(false);
    }
  }

  return (
    // Alert tokens only — red is reserved for danger, and this IS the
    // danger surface. Flat at rest: the hairline alert border carries the
    // warning; no resting shadow.
    <div className="rounded-md border border-alert/40 bg-surface overflow-hidden">
      <div className="bg-surface overflow-hidden">
        {/* Header — danger icon + title */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-alert/15 bg-alert/5">
          <span className="inline-flex items-center justify-center h-9 w-9 rounded-md bg-alert/10 text-alert ring-1 ring-alert/20">
            <AlertTriangle size={17} strokeWidth={2} />
          </span>
          <div>
            <h3 className="text-[14.5px] font-semibold text-alert">Danger zone</h3>
            <p className="text-[11.5px] text-ink-soft">
              Security-sensitive and destructive actions. Proceed carefully.
            </p>
          </div>
        </div>

        {/* Actions. Darker than the surrounding card (`bg-bg` sits below
            `surface` in both themes) so the zone reads as its own recessed
            panel rather than as more page. */}
        <div className="divide-y divide-rule/60 bg-bg">
          <Row icon={Lock} title="Change password" description="Send a password-reset link to your email.">
            {/* Was a bare text link, which made the one non-destructive
                action here look like a footnote next to three real
                buttons. Neutral outline — it isn't destructive, so it
                deliberately doesn't take the red treatment below. */}
            <button
              onClick={sendPasswordReset}
              disabled={pwBusy || !email}
              className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-rule bg-surface text-[12.5px] font-medium text-ink-soft hover:text-ink hover:border-rule-strong disabled:opacity-50 transition-colors"
            >
              {pwBusy && <Loader2 size={13} className="animate-spin" />}
              {pwBusy ? "Sending…" : "Send reset email"}
            </button>
          </Row>

          <Row icon={Shield} title="Two-factor authentication" description="Add a second factor to your sign-in.">
            <span className="text-[12px] text-ink-soft">Coming soon</span>
          </Row>

          {/* Clear all uploads — two-step confirm */}
          <div className="px-5 py-4 flex items-start justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-alert/20 bg-alert/5 text-alert shrink-0">
                <Trash2 size={14} strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <div className="text-[13.5px] text-ink">Clear all my uploaded documents</div>
                <div className="text-[11.5px] text-ink-soft leading-snug max-w-[440px]">
                  Hides every document and analysis you've uploaded to this workspace.
                  Reversible by support for 30 days. Doesn't affect other users.
                </div>
              </div>
            </div>
            {!confirming ? (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                data-testid="settings-clear-uploads"
                className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-alert/30 bg-alert/10 text-[12.5px] font-medium text-alert hover:bg-alert/20 transition-colors"
              >
                <Trash2 size={13} strokeWidth={1.75} />
                Clear uploads
              </button>
            ) : (
              <div className="shrink-0 flex items-center gap-2">
                <button
                  type="button"
                  disabled={clearBusy}
                  onClick={() => setConfirming(false)}
                  className="inline-flex items-center h-9 px-3 rounded-lg border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={clearBusy}
                  onClick={() => { void clearMyUploads(); }}
                  data-testid="settings-confirm-clear"
                  className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-alert hover:bg-alert/90 text-white text-[12.5px] font-medium disabled:opacity-60 transition-colors"
                >
                  {clearBusy
                    ? <><Loader2 size={13} className="animate-spin" />Clearing…</>
                    : <><Trash2 size={13} strokeWidth={1.75} />Yes, clear them</>}
                </button>
              </div>
            )}
          </div>

          {/* Cancel plan — the least destructive action in this zone, so it
              sits first among the three. Nothing is erased; the plan just
              stops renewing. */}
          {hasCancellableSub && (
            <DangerRow
              title="Cancel plan"
              description="Stops your subscription from renewing. You keep full access until the end of the current billing period, then drop to the free tier. Your data is untouched."
              buttonLabel="Cancel plan"
              onClick={() => setDangerDialog("cancel")}
            />
          )}

          {/* Delete all data — keeps the account, empties every owned
              workspace. Distinct from "Clear uploads" above, which only
              soft-hides documents and is support-reversible for 30 days;
              this one also takes periods, analyses, alerts, chats and the
              stored files, with no recovery. */}
          <DangerRow
            title="Delete all my data"
            description="Permanently erases documents, financial periods, analyses, alerts and chat history from every workspace you own, plus the uploaded files themselves. Your account and workspaces stay — they'll just be empty. This cannot be undone."
            buttonLabel="Delete all data"
            onClick={() => setDangerDialog("data")}
          />

          {/* Delete account — the full nuke, including the auth identity. */}
          <DangerRow
            title="Delete my account"
            description="Deletes your account and every workspace you own, along with all their data. Workspaces you're only a member of stay with their remaining members. You'll be signed out immediately. This cannot be undone."
            buttonLabel="Delete account"
            onClick={() => setDangerDialog("account")}
          />
        </div>
      </div>

      <ConfirmPhraseDialog
        open={dangerDialog === "cancel"}
        onClose={() => setDangerDialog(null)}
        onConfirm={cancelPlan}
        phrase={email ?? ""}
        title="Cancel your plan?"
        description="Your subscription stops renewing. You keep full access until the end of the current billing period, then move to the free tier. Nothing is deleted, and you can resubscribe at any time."
        confirmLabel="Cancel plan"
        busyLabel="Cancelling…"
      />

      <ConfirmPhraseDialog
        open={dangerDialog === "data"}
        onClose={() => setDangerDialog(null)}
        onConfirm={deleteAllMyData}
        phrase={email ?? ""}
        title="Delete all your data?"
        description="Every document, financial period, analysis, alert and chat in the workspaces you own will be permanently erased, along with the uploaded files. Your account and workspaces remain, empty. There is no recovery window."
        confirmLabel="Permanently delete data"
        busyLabel="Deleting…"
      />

      <ConfirmPhraseDialog
        open={dangerDialog === "account"}
        onClose={() => setDangerDialog(null)}
        onConfirm={deleteMyAccount}
        phrase={email ?? ""}
        title="Delete your account?"
        description="This erases your account and every workspace you own, with all of their documents, periods, analyses and chats. You will be signed out and will not be able to sign back in. There is no recovery window."
        confirmLabel="Permanently delete account"
        busyLabel="Deleting…"
      />
    </div>
  );
}

/** One destructive row in the Danger zone: description on the left, a
 *  red outline button on the right that opens a type-to-confirm dialog.
 *  Shares the shape of the "Clear uploads" row above it. */
function DangerRow({
  title, description, buttonLabel, onClick,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  onClick: () => void;
}) {
  return (
    <div className="px-5 py-4 flex items-start justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-alert/20 bg-alert/5 text-alert shrink-0">
          <Trash2 size={14} strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <div className="text-[13.5px] text-ink">{title}</div>
          <div className="text-[11.5px] text-ink-soft leading-snug max-w-[440px]">
            {description}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onClick}
        data-testid={`settings-${buttonLabel.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`}
        // The former hover fill is now the resting state — these read as
        // destructive at a glance instead of only once the cursor lands.
        className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-alert/30 bg-alert/10 text-[12.5px] font-medium text-alert hover:bg-alert/20 transition-colors"
      >
        <Trash2 size={13} strokeWidth={1.75} />
        {buttonLabel}
      </button>
    </div>
  );
}

/* ───────── Type-to-confirm dialog (GitHub pattern) ──────────────────────
 *
 * The destructive button stays disabled until the user types an exact
 * phrase. Mirrors `PurgeWorkspaceDialog` in Workspace.tsx — same friction,
 * same visual language — but takes the phrase as a prop because these two
 * actions confirm on the account email, not a workspace name.
 *
 * Deliberately NOT extracted into a shared component with Workspace.tsx's
 * copy: that one is coupled to a `Workspace` object (fresh-per-target reset
 * keyed on `workspace.id`, name-derived copy), and generalising it would
 * mean threading four render props through for no reuse beyond these three
 * call sites. The duplication here is ~40 lines of dialog chrome.
 */
function ConfirmPhraseDialog({
  open, onClose, onConfirm, title, description, phrase, confirmLabel, busyLabel,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  title: string;
  description: React.ReactNode;
  /** Exact string the user must type before the confirm button unlocks. */
  phrase: string;
  confirmLabel: string;
  busyLabel: string;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const match = phrase.length > 0 && typed.trim() === phrase;

  // Reset on every open — a phrase typed for one action must never carry
  // over and pre-arm the next dialog.
  useEffect(() => {
    if (open) {
      setTyped("");
      setBusy(false);
    }
  }, [open]);

  async function confirm() {
    if (!match || busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <label className="block">
          <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-soft font-semibold mb-1.5">
            Type{" "}
            <span className="font-mono normal-case tracking-normal text-ink">{phrase}</span>{" "}
            to confirm
          </span>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void confirm(); }}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            data-testid="confirm-phrase-input"
            className="w-full h-10 px-3 rounded-lg border border-rule bg-surface text-[14px] text-ink placeholder:text-ink-soft focus:outline-none focus:ring-2 focus:ring-alert/30 focus:border-alert/40"
          />
        </label>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/70 disabled:opacity-40 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!match || busy}
            data-testid="confirm-phrase-confirm"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-alert text-white text-[13px] font-medium hover:bg-alert/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy
              ? <><Loader2 size={14} className="animate-spin" />{busyLabel}</>
              : <><Trash2 size={14} strokeWidth={1.75} />{confirmLabel}</>}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ───────── Section / Field / Row primitives ────────────────────────────── */

function Section({ title, subtitle, divider = false, children }: {
  title: string;
  subtitle?: string;
  /** Draw a rule above the heading. Used to separate the top-level Settings
   *  sections from each other now that the individual cards no longer carry
   *  their own borders — without it the page is one undifferentiated column
   *  of headings and controls. */
  divider?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={divider ? "border-t border-rule pt-5" : undefined}>
      {/* Caps section titles — the same register as PanelHeader, so the
          Settings column scans like a stack of instrument panels. */}
      <h2 className="text-[12.5px] font-medium uppercase tracking-[0.08em] text-ink-soft">
        {title}
      </h2>
      {subtitle && <p className="mt-1 text-[12px] text-ink-soft">{subtitle}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-soft font-medium mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Input({
  value, onChange, placeholder, readOnly = false, inputRef, ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Renders as a non-interactive value display (see ProfileCard's edit
   *  toggle). `readOnly` rather than `disabled` on purpose: a disabled
   *  input is skipped by the tab order and unreadable to screen readers,
   *  and it can't receive focus — which the group-blur handler needs. */
  readOnly?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Accessible name. Field's caption div is purely visual (no <label>
   *  association), so inputs without a placeholder have NO name for AT —
   *  a critical axe `label` violation (D1). */
  ariaLabel?: string;
}) {
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      readOnly={readOnly}
      aria-label={ariaLabel}
      aria-readonly={readOnly || undefined}
      className={cn(
        // Instrument input: 32px, hairline rule, flat at rest. Focus is a
        // brand-tinted border, not a glow.
        "w-full h-8 border rounded-sm px-2.5 text-[13px] transition-colors duration-micro focus:outline-none",
        readOnly
          // Keep the field's outline so it still reads as an input, just
          // faded — a fully borderless value gave no hint that Edit would
          // turn it into something typeable. `select-none` + no focus ring:
          // a read-only input still takes focus and text selection by
          // default, which made it look editable when it isn't.
          ? "bg-transparent border-rule/40 text-ink-soft cursor-default select-none"
          : "bg-surface border-rule text-ink focus:border-brand/60",
      )}
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
          {description && <div className="text-[11.5px] text-ink-soft leading-snug">{description}</div>}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
