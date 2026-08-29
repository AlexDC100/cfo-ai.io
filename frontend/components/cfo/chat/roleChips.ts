// THE DIAL (Part E) — mode/role-aware chat suggestion chips.
//
// Simple mode swaps the workspace-grounded starter set (the Pro
// DSCR/leverage/covenant chips in CFOEmptyState.tsx) for owner-language
// questions: "Can I afford to hire?", "Why is profit lower than last
// year?", "Do I have a cash problem?" — EN + RO (tu-form), shipped with
// the bundle. DETERMINISTIC LIST, NO MODEL CALL: the set and its order
// are pure functions of (mode, role, language).
//
// Role tunes ORDERING only, never membership:
//   · owner / accountant / unknown — the three mandate questions lead
//     (they are the first three of the base order);
//   · analyst — valuation/credit-flavoured chips first.
//
// Pro mode never reaches this module's list — useWorkspacePrompts in
// CFOEmptyState.tsx returns the existing Pro set unchanged (hard rule 3:
// nothing pro is removed).

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Banknote,
  Landmark,
  Scale,
  Timer,
  TrendingDown,
  Users,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { UserRole } from "@/lib/viewMode";
import type { SuggestedPrompt } from "./industryPrompts";
import "./roleChipsI18n";

export interface RoleChipDef {
  /** i18n leaf under roleChips.ws.<id>.{title,prompt}. */
  id: string;
  icon: LucideIcon;
  /** Valuation/credit-flavoured — analysts see these first. */
  valuation?: boolean;
}

/** Base order = owner order: the three mandate questions lead. */
export const SIMPLE_WORKSPACE_CHIP_DEFS: readonly RoleChipDef[] = [
  { id: "hire", icon: Users },
  { id: "profitWhy", icon: TrendingDown },
  { id: "cashProblem", icon: Wallet },
  { id: "bills", icon: Timer },
  { id: "takeMoney", icon: Banknote },
  { id: "worry", icon: AlertTriangle },
  { id: "worth", icon: Scale, valuation: true },
  { id: "bankLoan", icon: Landmark, valuation: true },
];

/** Pure, deterministic role ordering. Same members, same relative order
 *  within each flavour bucket — only the bucket precedence moves. */
export function orderChipsForRole<T extends { valuation?: boolean }>(
  defs: readonly T[],
  role: UserRole,
): T[] {
  if (role === "analyst") {
    return [...defs.filter((d) => d.valuation), ...defs.filter((d) => !d.valuation)];
  }
  // owner, accountant, or no role recorded — base order.
  return [...defs];
}

/** Simple-mode workspace-grounded chips, resolved in the active language
 *  and ordered for the given role. */
export function useSimpleWorkspacePrompts(role: UserRole): SuggestedPrompt[] {
  const { t } = useTranslation();
  return useMemo(
    () =>
      orderChipsForRole(SIMPLE_WORKSPACE_CHIP_DEFS, role).map((d) => ({
        icon: d.icon,
        title: t(`roleChips.ws.${d.id}.title`),
        prompt: t(`roleChips.ws.${d.id}.prompt`),
      })),
    [role, t],
  );
}
