// Premium empty state shown when a conversation has no messages yet.
//
// Replaces the previous "Ask anything." plain-text block with:
//   · serif headline + soft subtitle
//   · prompt-suggestion grid that adapts based on whether a workspace
//     period is loaded (workspace-grounded prompts when yes; general
//     financial-knowledge prompts when no)
//
// Suggestion cards call back to the composer via `onPick(prompt)`.
// They never auto-submit — clicking puts the text in the composer
// for the user to confirm or edit.

import { useMemo } from "react";
import { motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import { TrendingUp, Calculator, FileText, AlertTriangle, GitCompare, LineChart, ShieldAlert, HelpCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useActiveOrg } from "@/lib/org";
import { useAiDegraded } from "@/lib/aiDegraded";
import "./chatDegradedI18n";
import { useIndustryPrompts, type SuggestedPrompt } from "./industryPrompts";

interface Props {
  hasPeriod: boolean;
  companyName?: string | null;
  onPick: (prompt: string) => void;
  /** When true, skip the built-in centered serif headline + subtitle and
   *  render only the left-aligned prompt grid. The full /chat page passes
   *  this because it renders a dashboard-style PageHeader above instead;
   *  the compact slide-over panel keeps the built-in header. */
  hideHeader?: boolean;
}

// Icon + i18n-key definitions — the visible title/prompt strings resolve
// through t() in the hooks below so they follow the active language.
const WORKSPACE_PROMPT_DEFS: Array<{ icon: LucideIcon; key: string }> = [
  { icon: AlertTriangle, key: "risk" },
  { icon: LineChart,     key: "cashFlow" },
  { icon: FileText,      key: "pnl" },
  { icon: GitCompare,    key: "workingCapital" },
  { icon: Calculator,    key: "dscr" },
  { icon: TrendingUp,    key: "yoy" },
  { icon: ShieldAlert,   key: "leverage" },
  { icon: HelpCircle,    key: "liquidity" },
];

const GENERAL_PROMPT_DEFS: Array<{ icon: LucideIcon; key: string }> = [
  { icon: FileText,      key: "ras" },
  { icon: Calculator,    key: "evEbitda" },
  { icon: LineChart,     key: "erp" },
  { icon: GitCompare,    key: "rasIfrs" },
  { icon: ShieldAlert,   key: "dscrVsIc" },
  { icon: TrendingUp,    key: "ccc" },
  { icon: HelpCircle,    key: "lenderBrief" },
  { icon: AlertTriangle, key: "distress" },
];

/** Workspace-grounded starter prompts, resolved in the active language. */
export function useWorkspacePrompts(): SuggestedPrompt[] {
  const { t } = useTranslation();
  return useMemo(
    () =>
      WORKSPACE_PROMPT_DEFS.map((d) => ({
        icon: d.icon,
        title: t(`chatX.prompts.ws.${d.key}.title`),
        prompt: t(`chatX.prompts.ws.${d.key}.prompt`),
      })),
    [t],
  );
}

/** General finance starter prompts, resolved in the active language. */
export function useGeneralPrompts(): SuggestedPrompt[] {
  const { t } = useTranslation();
  return useMemo(
    () =>
      GENERAL_PROMPT_DEFS.map((d) => ({
        icon: d.icon,
        title: t(`chatX.prompts.gen.${d.key}.title`),
        prompt: t(`chatX.prompts.gen.${d.key}.prompt`),
      })),
    [t],
  );
}

export function CFOEmptyState({ hasPeriod, companyName, onPick, hideHeader = false }: Props) {
  // Industry-tailored suggestions (2026-07-25) — when the workspace has
  // an org-profile industry (picked at onboarding), the general starter
  // set is swapped for prompts in that field's language: cap rates for
  // real estate, ARR for SaaS, WIP for construction. Workspace-grounded
  // prompts (period loaded) stay data-driven and generic.
  const { t } = useTranslation();
  const { org } = useActiveOrg();
  const workspacePrompts = useWorkspacePrompts();
  const generalPrompts = useGeneralPrompts();
  const industryPrompts = useIndustryPrompts(org?.industry_key);
  const prompts = hasPeriod ? workspacePrompts : (industryPrompts ?? generalPrompts);
  const industryLabel = industryPrompts ? (org?.industry_display_name ?? null) : null;

  // A2 — suggestion cards stay visible but disabled while the assistant is
  // degraded; the tooltip points at Retry on the failed turn.
  const degraded = useAiDegraded();
  const degradedTooltip = degraded ? t("chatDegraded.disabledTooltip") : undefined;

  // Cards match the dashboard's DocGuideCard pattern (document-type
  // guide): left-aligned, 3px brand left-border accent, compact medium
  // title over muted body copy — no icon tile.
  const grid = (
    <div>
    <h2 className="mb-2.5 text-[10.5px] uppercase tracking-[0.12em] text-ink-soft font-semibold">
      {t("chatX.suggestedQuestions")}
      {industryLabel && (
        <span className="normal-case tracking-normal font-normal text-ink-soft">
          {" "}{t("chatX.basedOnIndustry", { industry: industryLabel })}
        </span>
      )}
    </h2>
    {/* 2-wide everywhere below lg (2026-08-18 per operator — the stacked
        single column read as a long list on phones); lg keeps 4-up. */}
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
      {prompts.map((p) => {
        const Icon = p.icon;
        return (
          <button
            key={p.title}
            type="button"
            onClick={() => onPick(p.prompt)}
            disabled={!!degraded}
            title={degradedTooltip}
            className="
              rounded-md border border-rule border-l-[3px] border-l-brand
              bg-surface p-3 text-center
              hover:bg-transparent
              transition-colors duration-micro ease-out
              focus:outline-none focus:ring-2 focus:ring-brand/30
              disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-surface
            "
            data-testid="chat-prompt-card"
          >
            {/* Icon + title — vertically centered together (2026-07-26), with
                a fixed height so the divider lands at the same spot on every
                card regardless of 1- vs 2-line titles. */}
            <div className="flex items-center justify-center gap-2 min-h-[52px] text-center">
              <Icon size={24} strokeWidth={1.75} className="text-brand-d shrink-0" />
              <span className="text-[12.5px] font-medium text-ink leading-tight">{p.title}</span>
            </div>
            <div aria-hidden className="w-40 max-w-full mx-auto h-px bg-gradient-to-r from-transparent via-rule-strong to-transparent mt-1 mb-3" />
            <p className="text-[11.5px] text-ink-soft leading-relaxed line-clamp-3">{p.prompt}</p>
          </button>
        );
      })}
    </div>
    </div>
  );

  // Full /chat page — header is a dashboard-style PageHeader rendered by the
  // shell above; here we render only the left-aligned prompt grid.
  if (hideHeader) {
    return (
      <div className="w-full max-w-[1040px]" data-testid="chat-empty-state">
        {grid}
      </div>
    );
  }

  // Compact slide-over panel — keep the built-in centered header.
  return (
    <motion.div
      className="w-full max-w-[820px] mx-auto px-2 sm:px-4 py-8 sm:py-12"
      data-testid="chat-empty-state"
    >
      <div className="flex flex-col items-center text-center">
        <h2 className="font-serif text-[28px] sm:text-[32px] text-ink leading-tight">
          {hasPeriod
            ? (
              <Trans
                i18nKey="chatX.emptyTitleCompany"
                values={{ name: companyName || t("chatX.yourCompany") }}
                components={{ 1: <span className="text-ink-soft italic" /> }}
              />
            )
            : t("chatX.emptyTitleGeneral")}
        </h2>
        <p className="mt-2 text-[14px] text-ink-soft max-w-[560px] leading-relaxed">
          {hasPeriod
            ? t("chatX.emptyBodyGrounded")
            : t("chatX.emptyBodyGeneral")}
        </p>
      </div>

      <div className="mt-8">{grid}</div>
    </motion.div>
  );
}
