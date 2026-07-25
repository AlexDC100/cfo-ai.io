// tokenUsage.ts — Claude-style token presentation of plan usage.
//
// 2026-07-24 (operator directive): usage indicators read as a TOKEN
// budget — the subscription grants an allowance of tokens and each AI
// interaction / document analysis spends from it — instead of separate
// "documents this month" and "chats today" counters.
//
// IMPORTANT — this is a UNIT CONVERSION of the real backend counters,
// not a new enforcement system. The engine still meters docs
// (docs_used / included_docs) and chat turns (chat_used_this_period /
// chat_monthly_cap); this module maps both onto one token scale so the
// UI can show a single budget. If real per-request token metering ever
// lands server-side, swap the derivation here and every indicator
// updates at once.

import type { PlanState } from "@/lib/planState";

/** Token cost of one Ask CFO AI interaction. */
export const TOKENS_PER_CHAT = 1_000;
/** Token cost of one document analysis (a full pipeline run dwarfs a
 *  chat turn, hence the 25× weight). */
export const TOKENS_PER_DOC = 25_000;

export interface TokenUsage {
  /** Total tokens the current plan grants per period — null when the
   *  plan has no metered caps at all (nothing to budget against). */
  allowance: number | null;
  /** Tokens spent this period across chats + documents. */
  spent: number;
  /** max(0, allowance - spent); null when allowance is null. */
  remaining: number | null;
  /** 0-100, clamped; 0 when there is no allowance. */
  pct: number;
}

export function tokenUsage(plan: PlanState): TokenUsage {
  const spent =
    plan.chat_used_this_period * TOKENS_PER_CHAT
    + plan.docs_used * TOKENS_PER_DOC;
  // A plan with neither a chat cap nor included docs has nothing to
  // meter — surface "no allowance" rather than a fake 0/0 bar.
  const metered = plan.chat_monthly_cap != null || plan.included_docs > 0;
  if (!metered) return { allowance: null, spent, remaining: null, pct: 0 };
  const allowance =
    (plan.chat_monthly_cap ?? 0) * TOKENS_PER_CHAT
    + plan.included_docs * TOKENS_PER_DOC;
  return {
    allowance,
    spent,
    remaining: Math.max(0, allowance - spent),
    pct: allowance > 0 ? Math.min(100, Math.round((spent / allowance) * 100)) : 0,
  };
}

/** Compact token formatting — 950, 1.5K, 2.3M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return `${Math.round(n)}`;
}
