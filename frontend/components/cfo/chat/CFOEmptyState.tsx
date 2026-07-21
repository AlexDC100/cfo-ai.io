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
  const prompts = hasPeriod ? WORKSPACE_PROMPTS : GENERAL_PROMPTS;

  const grid = (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
      {prompts.map((p) => {
        const Icon = p.icon;
        return (
          <button
            key={p.title}
            type="button"
            onClick={() => onPick(p.prompt)}
            className="
              group text-center flex flex-col items-center gap-2.5
              rounded-xl border border-rule bg-surface/70
              px-4 py-5
              hover:border-brand/30 hover:bg-surface
              focus:outline-none focus:ring-2 focus:ring-brand/30
              transition-all
            "
            data-testid="chat-prompt-card"
          >
            <span className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-bg-2/60 text-ink-soft group-hover:bg-brand/10 group-hover:text-brand-d transition-colors">
              <Icon size={22} strokeWidth={1.75} />
            </span>
            <span className="block text-[14px] font-medium text-ink">{p.title}</span>
            <span className="block text-[12px] text-ink-soft leading-relaxed line-clamp-2">{p.prompt}</span>
          </button>
        );
      })}
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
