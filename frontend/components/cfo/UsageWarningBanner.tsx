// UsageWarningBanner.tsx — WS1 in-app banner shown when the caller is
// within 80%+ of any plan cap (docs/month, chat/day, chat/month).
//
// Renders once per browser session (session-storage dismissal); a fresh
// tab brings it back. That cadence is intentional — operator wants
// users to see the warning consistently as their usage climbs, not be
// able to dismiss it forever and then hit a surprise hard-block.
//
// Visibility logic (in order):
//   1. usage-limits flag off / no plan state                    → render null
//   2. user dismissed this session                              → render null
//   3. docs_used >= 80% of included_docs                        → docs warning
//   4. chat_used_today >= 80% of chat_daily_cap                 → chat-today warning
//   5. chat_used_this_period >= 80% of chat_monthly_cap         → chat-month warning
//   6. otherwise                                                 → render null
//
// Copy is intentionally tight: one fact + one CTA, no apology. The
// CTA goes to /pricing for users on Trial/Intro/Starter (upgrade
// to Pro removes most caps); Pro users in metered-overage range get
// a "see your upcoming invoice" anchor to /settings instead.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, X } from "lucide-react";
import { usePlanState } from "@/lib/planState";

const DISMISS_KEY = "cfo-ai-usage-banner-dismissed";

type Trigger =
  | { kind: "docs";       pct: number; used: number; cap: number }
  | { kind: "chat_day";   pct: number; used: number; cap: number }
  | { kind: "chat_month"; pct: number; used: number; cap: number };

function pickTrigger(state: ReturnType<typeof usePlanState>["state"]): Trigger | null {
  if (!state) return null;
  const triggers: Trigger[] = [];

  if (state.included_docs > 0) {
    const pct = state.docs_used / state.included_docs;
    if (pct >= 0.8) {
      triggers.push({
        kind: "docs", pct,
        used: state.docs_used, cap: state.included_docs,
      });
    }
  }

  if (state.chat_daily_cap && state.chat_daily_cap > 0) {
    const pct = state.chat_used_today / state.chat_daily_cap;
    if (pct >= 0.8) {
      triggers.push({
        kind: "chat_day", pct,
        used: state.chat_used_today, cap: state.chat_daily_cap,
      });
    }
  }

  if (state.chat_monthly_cap && state.chat_monthly_cap > 0) {
    const pct = state.chat_used_this_period / state.chat_monthly_cap;
    if (pct >= 0.8) {
      triggers.push({
        kind: "chat_month", pct,
        used: state.chat_used_this_period, cap: state.chat_monthly_cap,
      });
    }
  }

  // Pick the most-utilized cap so the user sees the most-urgent one
  triggers.sort((a, b) => b.pct - a.pct);
  return triggers[0] ?? null;
}

function bannerCopy(t: Trigger, planKey: string | null | undefined, tr: TFunction): {
  message: string;
  ctaLabel: string;
} {
  // For Starter, "Upgrade to Pro" is the upsell. For Pro, "See upcoming
  // invoice" reminds them they'll be charged for overages (no upsell —
  // they're already on the top self-serve tier).
  const upgradeCta = planKey === "pro"
    ? { label: tr("panels.usage.seeInvoice"), path: "/settings" }
    : { label: tr("panels.usage.upgradePro"), path: "/pricing" };

  if (t.kind === "docs") {
    const remaining = t.cap - t.used;
    if (remaining <= 0) {
      return {
        message: tr("panels.usage.docsAll", { cap: t.cap }),
        ctaLabel: upgradeCta.label,
      };
    }
    return {
      message: tr("panels.usage.docsSome", { used: t.used, cap: t.cap }),
      ctaLabel: upgradeCta.label,
    };
  }
  if (t.kind === "chat_day") {
    return {
      message: tr("panels.usage.chatDay", { used: t.used, cap: t.cap }),
      ctaLabel: upgradeCta.label,
    };
  }
  return {
    message: tr("panels.usage.chatMonth", { used: t.used, cap: t.cap }),
    ctaLabel: upgradeCta.label,
  };
}

function ctaPath(planKey: string | null | undefined): string {
  return planKey === "pro" ? "/settings" : "/pricing";
}

export function UsageWarningBanner() {
  const { t: tr } = useTranslation();
  const { state, loading } = usePlanState();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  const trigger = useMemo(() => (loading || !state ? null : pickTrigger(state)), [loading, state]);

  if (!trigger || dismissed) return null;

  const { message, ctaLabel } = bannerCopy(trigger, state?.plan_key ?? null, tr);
  const path = ctaPath(state?.plan_key ?? null);

  const handleDismiss = () => {
    setDismissed(true);
    try { window.sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
  };

  return (
    <div
      role="status"
      data-testid="usage-warning-banner"
      data-trigger={trigger.kind}
      className="
        sticky top-14 z-30
        mx-4 sm:mx-8 lg:mx-10 mb-4
        rounded-xl border border-caution/40 bg-caution-tint
        px-4 py-2.5
        flex items-center gap-3
      "
    >
      <AlertTriangle
        size={14}
        strokeWidth={2}
        className="text-caution shrink-0"
        aria-hidden
      />
      <p className="text-[13px] text-caution flex-1">
        {message}
      </p>
      <button
        type="button"
        onClick={() => navigate(path)}
        data-testid="usage-warning-banner-cta"
        className="
          inline-flex items-center h-7 px-3 rounded-md
          bg-caution text-caution-tint text-[12px] font-medium
          hover:bg-caution/85 transition-colors
        "
      >
        {ctaLabel}
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={tr("productsX.inflight.dismiss")}
        data-testid="usage-warning-banner-dismiss"
        className="text-caution/70 hover:text-caution shrink-0"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
