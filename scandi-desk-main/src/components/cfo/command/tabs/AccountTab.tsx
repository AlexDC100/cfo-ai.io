// AccountTab.tsx — Account tab of the Command Center.
//
// CONTENT (per the cleanup spec, §10)
//   Profile
//     · User name + email (display only — no extra action)
//     · Manage profile             → /settings
//   Billing
//     · Manage billing             → /settings (Billing section)
//   Security
//     · Change password            — active (Supabase reset flow)
//     · Two-factor authentication  — coming_soon
//   Session
//     · Sign out                   — THE ONLY sign-out in the app
//
// ⚠️  CRITICAL — exactly one sign-out
// ──────────────────────────────────
// The cleanup spec is emphatic: "There must be exactly ONE sign-out
// action in the entire Command Center" and TopHeader avatar must not
// duplicate it. This row is THE source-of-truth sign-out. If a future
// PR adds another, the menu-cleanliness E2E (E2E test 7) WILL fail —
// that's the safeguard.
//
// The sign-out flow:
//   1. Close drawer (smooth animation)
//   2. Call `signOut()` from useAuth
//   3. Toast confirmation (or error)
//   4. Navigate to /login on success

import {
  CreditCard,
  KeyRound,
  ShieldCheck,
  User,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/lib/auth";

import { Row } from "../Row";
import { Section } from "../Section";

interface Props {
  /** Close the Command Center after launching an action. */
  onClose: () => void;
}

export function AccountTab({ onClose }: Props) {
  const navigate = useNavigate();
  const { user, displayName } = useAuth();

  function launch(fn: () => void) {
    onClose();
    setTimeout(fn, 220);
  }

  // Sign-out was REMOVED from this tab per the operator's directive.
  // The single sign-out source-of-truth is now the top-right
  // <AccountMenu/> (`data-testid="account-menu-sign-out"`) — moved
  // there in the May 2026 redesign from the Sidebar System group.
  // Keeping a sign-out here would duplicate the single-action rule the
  // brief is explicit about.

  return (
    <>
      <Section label="Profile">
        <Row
          icon={User}
          title={displayName ?? user?.email ?? "Profile"}
          hint={user?.email ?? "Sign in to manage your profile"}
          featureKey="manage_profile"
          onClick={() => launch(() => navigate("/settings"))}
          testId="cmd-account-profile"
        />
      </Section>

      <Section label="Billing">
        <Row
          icon={CreditCard}
          title="Manage billing"
          hint="Plan, invoices, payment method"
          featureKey="manage_billing"
          onClick={() => launch(() => navigate("/settings"))}
          testId="cmd-account-billing"
        />
      </Section>

      <Section label="Security">
        <Row
          icon={KeyRound}
          title="Change password"
          hint="Reset your password via email"
          featureKey="change_password"
          onClick={() => launch(() => navigate("/settings"))}
          testId="cmd-account-change-password"
        />
        <Row
          icon={ShieldCheck}
          title="Two-factor authentication"
          featureKey="two_factor_auth"
          testId="cmd-account-2fa"
        />
      </Section>

      {/* Session section + Sign out live in the top-right <AccountMenu/>
          (May 2026 redesign — relocated from the Sidebar System group).
          Look for `data-testid="account-menu-sign-out"` (single source
          of truth). The duplicate has been removed here on purpose. */}
    </>
  );
}
