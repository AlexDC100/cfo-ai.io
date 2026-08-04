// Settings → Billing section.
//
// LAYOUT (Jul 2026 — plan cards replace the plain "Current plan" line)
// ────────────────────────────────────────────────────────
//   Billing
//
//   ┌── STARTER ──────────┐  ┌── PRO ── Most popular ──┐
//   │  €14.99 / month     │  │  €39.99 / month         │
//   │  [ Current plan ]   │  │  [ Start Pro ]          │
//   └─────────────────────┘  └─────────────────────────┘
//
//                                    [ Manage subscription ]
//
// The plan cards ARE the current-plan readout — `PricingTableV2` flips
// the matching tier's CTA to "Current plan" (disabled). That replaced a
// static "Current plan / Pro · €39.99 / mo" field, which named the tier
// but offered no way to change it without a trip to /pricing.
//
// Note this is `PricingTableV2` (Starter/Pro, priced from
// /api/pricing/config), NOT the marketing site's `pricingGrid` HTML in
// Landing.tsx (Solo/Business, hardcoded €19.99/€59). Those are older plan
// names with no checkout wiring, so rendering them to a signed-in user
// would offer tiers that don't exist in Stripe.
//
// What this surface DOES:
//   · Renders the live plan cards, with the user's own tier marked and
//     every other tier a working checkout CTA. Prices come from
//     /api/pricing/config — the same server truth /pricing and the
//     AccountMenu read, so nothing drifts between surfaces.
//   · "Manage subscription" routes to the Stripe customer portal when
//     a Stripe subscription exists. For trial / intro / no-sub users
//     it routes to /pricing so they can pick a tier.
//
// What this surface NO LONGER does (kept on disk for revert):
//   · "Manage payment method" + "Cancel subscription" two-button row
//     — Stripe's portal covers both, so a single CTA is cleaner
//   · Pending-cancel banner
//   · CancelSaveAttempt save-attempt dialog
//   The function defs for the removed pieces stay below so a revert
//   is one-line JSX restore.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle } from "lucide-react";
import {
  useStripeSubscription,
  openBillingPortal,
  cancelAtPeriodEnd,
  useInvalidateBilling,
  type StripeSubscription,
} from "@/lib/stripeBilling";
// `useToast` import dropped — toast was only used to surface a Stripe-
// portal failure; the new handleManage just navigates so there's no
// async error to toast.
import { usePlanState, type PlanState } from "@/lib/planState";
import { useAuth } from "@/lib/auth";
import { formatEur, type PlanKey } from "@/lib/pricingConfig";
import { SITE } from "@/config/site";
import { UpcomingInvoicePreview } from "./UpcomingInvoicePreview";
import { CurrentPlanCard } from "./CurrentPlanCard";
import { UsageThisMonth } from "./pricing/UsageThisMonth";
import { formatDateOnly } from "@/lib/locale";

export function BillingSection() {
  // Stripe sub state — used to route "Manage subscription" to the
  // Stripe Customer Portal when a real subscription exists, or fall
  // back to /pricing for trial / pre-checkout users.
  const { data: stripeSub, isLoading: subLoading } = useStripeSubscription();

  // V2 plan truth — name + price both come from here, server-side
  // config. This is the same hook PricingTableV2 + AccountMenu use, so
  // prices are guaranteed consistent across surfaces.
  const { state: planState, loading: planLoading } = usePlanState();

  // Billing email — for now we render the auth email. If a separate
  // billing_email column lands on the profile, swap the value here.
  const { user } = useAuth();

  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  // Feed the plan cards the tier the user is actually on so the matching
  // card renders "Current plan" (disabled) instead of a checkout CTA.
  // `undefined` means "no current plan" to PricingTableV2 (all CTAs live),
  // which is the right read while plan state is still resolving.
  const currentPlanKey: PlanKey | null =
    (planState?.plan_key as PlanKey | undefined) ?? null;

  /** Re-introduced (May 2026, Stripe go-live):
   *   · If the user has a Stripe-linked subscription (any tier),
   *     POST /api/billing/portal and redirect to the returned URL.
   *     Stripe Customer Portal owns: update card / view invoices /
   *     cancel / change plan.
   *   · Otherwise — trial / pre-checkout users — fall back to /pricing
   *     so they can pick a tier. The same fallback fires if the portal
   *     call fails (e.g. backend 503, Customer Portal not yet
   *     activated in the Stripe Dashboard). */
  const hasStripeSub = Boolean(
    stripeSub && (stripeSub.tier || stripeSub.plan_key) && stripeSub.status !== "trial",
  );

  async function handleManage() {
    setBusy(true);
    if (hasStripeSub) {
      const ok = await openBillingPortal();
      if (ok) return; // browser navigated away
    }
    // Fallback: no active sub, OR portal call failed → the marketing site's
    // pricing tab, NOT the in-app /pricing route (owner's directive
    // 2026-07-27). Landing.tsx selects its page from the hash — see its
    // `applyHash` / `VALID_PAGES` — so the target is `/#/pricing`, not a
    // path segment. A plain `/pricing` would land on the separate in-app
    // pricing route instead.
    setBusy(false);
    navigate("/#/pricing");
  }

  if (subLoading || planLoading) {
    return (
      <div
        data-testid="billing-loading"
        className="rounded-2xl border border-rule bg-surface p-5"
      >
        <Loader2 size={14} className="inline animate-spin mr-1 text-ink-mute" />
        <span className="text-[13px] text-ink-soft">Loading billing…</span>
      </div>
    );
  }

  return (
    <section
      data-testid="settings-billing"
      data-plan-key={planState?.plan_key ?? "unknown"}
    >
      <div className="space-y-6">
        {/* The plan cards themselves are the "current plan" readout: the
            tier the user is on renders as "Current plan" + disabled, and
            every other tier is a live checkout CTA. That replaced the
            label-over-value "Current plan / Pro · €39.99 / mo" line, which
            stated the tier but gave no way to move off it without a trip
            to /pricing. Prices come from the same /api/pricing/config the
            cards on /pricing read, so nothing can drift between the two
            surfaces. */}
        {/* Usage meters first — "how much have I used?" is the question a
            user opens this section with; the plan card below answers "of
            what?". `compact` drops UsageThisMonth's /pricing page chrome. */}
        <UsageThisMonth compact />

        {/* One card — the plan the user is actually on — in the marketing
            site's card design. The full Starter+Pro grid lives at /pricing;
            repeating it here made Settings a second storefront when the
            question this surface answers is "what am I on?". */}
        <CurrentPlanCard />

        {/* WS2 — live counter for the next invoice (base + metered extras +
            total). Hidden for trial / pre-checkout users; renders itself
            null when /api/billing/upcoming-invoice returns no subscription. */}
        <UpcomingInvoicePreview />

        {/* The "Billing email" field and the divider above this row were
            removed 2026-07-27 — the address was the account email already
            shown in Settings → Profile, so it restated a fact one section
            up and made the plan cards look like they ended in a form.
            The Stripe portal CTA stays: the cards sell tiers, they don't
            manage an existing subscription (card on file, invoices,
            cancel). Falls back to /pricing when there's no Stripe sub. */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleManage}
            disabled={busy}
            data-testid="billing-manage-subscription"
            // Animated teal sweep, matching the selected language/currency
            // pills and the profile Edit button.
            className="
              ask-ai-anim-fill
              inline-flex items-center justify-center gap-2
              h-10 px-4 rounded-md
              bg-surface border border-brand/50
              text-[13px] text-ink font-medium
              transition-colors disabled:opacity-60
              [--af-band:90px] [--af-shift:509.1px]
              [--af-a1:0.34] [--af-a2:0.12] [animation-duration:7.2s]
            "
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            Manage
          </button>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Field — label-over-value row used for both Current plan + Billing
// email so they line up visually.
// ─────────────────────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium mb-1">
        {label}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// planPriceLine — formats the price using the server-side config value.
// Recurring → "€39.99 / mo". One-time intro → "€0.99 one-time". Free
// trial → "Free". Null planState → "Free" (defensive default — same as
// the trial fallback to avoid an empty value).
// ─────────────────────────────────────────────────────────────────────

function planPriceLine(plan: PlanState | null): string {
  if (!plan) return "Free";
  if (plan.plan_recurring) return `${formatEur(plan.plan_price_eur)} / mo`;
  if (plan.plan_price_eur > 0) return `${formatEur(plan.plan_price_eur)} one-time`;
  return "Free";
}

// ─────────────────────────────────────────────────────────────────────
// PRESERVED FOR REVERT (May 2026 simplification)
// ─────────────────────────────────────────────────────────────────────
// `CancelSaveAttempt` + `SaveReason` + `formatDate` are no longer
// rendered. The "Cancel subscription" CTA was folded into the Stripe
// portal (Manage subscription button). Keeping the defs on disk so a
// revert is one-line JSX restore.

interface CancelSaveAttemptProps {
  open: boolean;
  sub: StripeSubscription;
  onClose: () => void;
  onConfirm: () => void;
}

// Kept on disk per revert pattern (May 2026 simplification). Not
// rendered today; the Stripe portal "Manage subscription" covers the
// cancel path.
function CancelSaveAttempt({ open, sub, onClose, onConfirm }: CancelSaveAttemptProps) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="cancel-save-attempt">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle size={16} strokeWidth={2} className="text-[#2AA89B]" />
            Sorry to see you go.
          </AlertDialogTitle>
          <AlertDialogDescription>
            Before you cancel — anything we can help with?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 my-2">
          <SaveReason
            label="Too expensive"
            suggestion="We can pause your subscription for 30 days while you decide."
          />
          <SaveReason
            label="Missing a feature"
            suggestion={`Tell us what you need — ${SITE.supportEmail}`}
          />
          <SaveReason
            label="Bug or technical issue"
            suggestion="Email support — we respond within 24 hours."
          />
        </div>
        <p className="text-[12.5px] text-ink-soft">
          If you cancel now, you keep access until{" "}
          <strong>{formatDate(sub.current_period_end)}</strong>. After that,
          your subscription ends and you won't be charged.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="cancel-keep-subscription">
            Keep my subscription
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="cancel-confirm"
            onClick={onConfirm}
            className="bg-red-700 hover:bg-red-800 text-paper"
          >
            Cancel anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SaveReason({ label, suggestion }: { label: string; suggestion: string }) {
  return (
    <div className="rounded-lg border border-rule bg-bg-2/40 px-3 py-2">
      <div className="text-[13px] text-ink font-medium">{label}</div>
      <div className="text-[12px] text-ink-soft mt-0.5">{suggestion}</div>
    </div>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDateOnly(iso);
  } catch {
    return iso.slice(0, 10);
  }
}

// Reference unused helpers + types so tsc doesn't flag the imports as
// "declared but never used" while the on-disk dead code awaits revert.
const _PRESERVED_FOR_REVERT = {
  cancelAtPeriodEnd,
  useInvalidateBilling,
  CancelSaveAttempt,
  SaveReason,
  formatDate,
};
void _PRESERVED_FOR_REVERT;
