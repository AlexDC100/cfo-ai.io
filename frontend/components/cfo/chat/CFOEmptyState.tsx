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

import { motion } from "framer-motion";
import { TrendingUp, Calculator, FileText, AlertTriangle, GitCompare, LineChart, ShieldAlert, HelpCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useActiveOrg } from "@/lib/org";
import { promptsForIndustry } from "./industryPrompts";

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

export const WORKSPACE_PROMPTS: Array<{ icon: LucideIcon; title: string; prompt: string }> = [
  { icon: AlertTriangle, title: "Biggest financial risk", prompt: "What is our biggest financial risk right now? Cite the period and figures you used." },
  { icon: LineChart,     title: "Cash flow position",      prompt: "Explain our current cash flow position in plain language for the management team." },
  { icon: FileText,      title: "Summarize latest P&L",    prompt: "Summarize the latest P&L: revenue, EBITDA, net profit, and what changed." },
  { icon: GitCompare,    title: "Working-capital change",  prompt: "What changed in working capital this period? Walk me through the moving parts." },
  { icon: Calculator,    title: "Calculate DSCR",          prompt: "Calculate DSCR (rent only and including dividends) and tell me how it compares to a 1.25× covenant." },
  { icon: TrendingUp,    title: "Year-over-year",          prompt: "Compare this year to last year on the headline metrics. Where did we improve and where did we slip?" },
  { icon: ShieldAlert,   title: "Leverage position",       prompt: "Explain our leverage position (Debt/EBITDA, net debt, equity ratio) and whether it's sustainable." },
  { icon: HelpCircle,    title: "Liquidity questions",     prompt: "What questions should I be asking about liquidity for the next board meeting?" },
];

export const GENERAL_PROMPTS: Array<{ icon: LucideIcon; title: string; prompt: string }> = [
  { icon: FileText,    title: "Read a Romanian RAS trial balance", prompt: "How do I read a Romanian RAS trial balance? Walk me through classes 1–7." },
  { icon: Calculator,  title: "EV/EBITDA for food manufacturing",   prompt: "What's a typical EV/EBITDA range for food manufacturing in Romania, and what drives the spread?" },
  { icon: LineChart,   title: "Damodaran ERP for emerging markets", prompt: "Explain Damodaran's approach to estimating equity risk premium for emerging markets." },
  { icon: GitCompare,  title: "RAS vs IFRS",                        prompt: "What are the key differences between Romanian RAS and IFRS that I should know as a CFO?" },
  { icon: ShieldAlert, title: "DSCR vs interest coverage",          prompt: "What's the difference between DSCR and interest coverage, and when does each matter to a lender?" },
  { icon: TrendingUp,  title: "Cash conversion cycle",              prompt: "Walk me through the cash conversion cycle and what each component (DSO, DIO, DPO) actually measures." },
  { icon: HelpCircle,  title: "3-question lender brief",            prompt: "Help me draft a 3-question lender brief for a real-estate single-asset vehicle." },
  { icon: AlertTriangle, title: "Distress signals",                 prompt: "What are the early distress signals a CFO should watch for in a working-capital-heavy business?" },
];

export function CFOEmptyState({ hasPeriod, companyName, onPick, hideHeader = false }: Props) {
  // Industry-tailored suggestions (2026-07-25) — when the workspace has
  // an org-profile industry (picked at onboarding), the general starter
  // set is swapped for prompts in that field's language: cap rates for
  // real estate, ARR for SaaS, WIP for construction. Workspace-grounded
  // prompts (period loaded) stay data-driven and generic.
  const { org } = useActiveOrg();
  const industryPrompts = promptsForIndustry(org?.industry_key);
  const prompts = hasPeriod ? WORKSPACE_PROMPTS : (industryPrompts ?? GENERAL_PROMPTS);
  const industryLabel = industryPrompts ? (org?.industry_display_name ?? null) : null;

  // Cards match the dashboard's DocGuideCard pattern (document-type
  // guide): left-aligned, 3px brand left-border accent, compact medium
  // title over muted body copy — no icon tile.
  const grid = (
    <div>
    <h2 className="mb-2.5 text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
      Suggested questions
      {industryLabel && (
        <span className="normal-case tracking-normal font-normal text-ink-mute">
          {" "}· based on your workspace's field ({industryLabel})
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
            className="
              rounded-lg border border-rule border-l-[3px] border-l-brand
              bg-surface p-3 text-center
              hover:bg-transparent
              transition-colors duration-150 ease-out
              focus:outline-none focus:ring-2 focus:ring-brand/30
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
            ? <>Ask anything about <span className="text-ink-soft italic">{companyName || "your company"}</span>.</>
            : "Ask anything about your company's finances."}
        </h2>
        <p className="mt-2 text-[14px] text-ink-soft max-w-[560px] leading-relaxed">
          {hasPeriod
            ? "CFO AI can explain your numbers, compare periods, and help you understand what matters. It also answers general finance, strategy, and accounting questions."
            : "Load a period to ground answers in your own figures. In the meantime, ask anything — finance, strategy, accounting, or the app itself."}
        </p>
      </div>

      <div className="mt-8">{grid}</div>
    </motion.div>
  );
}
