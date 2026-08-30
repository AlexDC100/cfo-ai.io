// Ask CFO AI — full-page chat experience.
//
// The page itself is intentionally thin: it pulls the active period
// from `useActivePeriod()`, serialises it into a workspace snapshot
// (same logic as before the redesign), and mounts the shared
// `CFOChatShell` in its "page" variant. The shell owns the
// conversation store, history sidebar, message stream, and composer.
//
// The same `CFOChatShell` is mounted in `CFOChatPanel` (slide-over)
// from `AppShell`, so any "Ask CFO AI" entry point on the rest of the
// app shows the same conversations and uses the same composer — no
// second assistant.
//
// The exported `chatShellRef` is captured by `AppShell` so a click on
// "Ask CFO AI" while ALREADY on /chat focuses the composer instead of
// re-navigating. (See `AppShell.openAskCfoAi`.)

import { useEffect, useMemo, useRef } from "react";
import { useActivePeriod, type PeriodMetric } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { CFOChatShell, type CFOChatShellHandle } from "@/components/cfo/chat/CFOChatShell";
import { setChatShellRef } from "@/components/cfo/chat/sharedShellRef";
import { buildCanonicalMetrics } from "@/lib/canonicalMetrics";
// servedFacts gateway — the snapshot's BS totals are the SERVED
// (reconciliation-adjusted) figures, so the assistant quotes the same
// book the dashboard, exports and BS tab show.
import { factsFrom } from "@/lib/servedFacts";
import type { Statements } from "@/lib/financialReport";

export default function Chat() {
  // 2026-05-24 — auto-resolve active period so the chat has workspace
  // context when opened directly via sidebar (no ?period= preserved).
  useActivePeriodFallback();
  const period = useActivePeriod();
  const ref = useRef<CFOChatShellHandle | null>(null);

  // Publish the shell handle on a module-level singleton so the AppShell's
  // top-header "Ask CFO AI" button can call `focusComposer()` when the
  // user is already on this page. Unset on unmount.
  useEffect(() => {
    setChatShellRef(ref.current);
    return () => setChatShellRef(null);
  });

  // F5.0 Phase 1.6 — Read a "preload" prompt left by a LearnableNumber
  // popover's "Ask CFO AI" action. The popover writes the question +
  // concept context to sessionStorage just before navigating here; we
  // pre-fill the composer + focus it so the user lands with the
  // question ready to send (or edit). One-shot — we consume + clear.
  useEffect(() => {
    if (!ref.current) return;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem("cfo-chat-preload");
    } catch {
      raw = null;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { prompt?: string };
      if (parsed?.prompt && typeof parsed.prompt === "string") {
        ref.current.setComposer(parsed.prompt);
        ref.current.focusComposer();
      }
    } catch {
      /* malformed — ignore */
    } finally {
      try {
        sessionStorage.removeItem("cfo-chat-preload");
      } catch {
        /* ignore */
      }
    }
    // Run on mount only — the preload is a hand-off, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const workspaceSnapshot = useMemo(() => buildWorkspaceSnapshot(period), [period]);
  const companyName = period.statements?.companyName ?? null;

  // The chat now renders like every other tab: it flows in AppShell's normal
  // padded content area and scrolls at the DOCUMENT level (the shell owns a
  // sticky sidebar + sticky composer). No full-bleed / inner-scroller wrapper.
  return (
    <CFOChatShell
      ref={ref}
      variant="page"
      workspaceSnapshot={workspaceSnapshot}
      periodLabel={period.label}
      periodId={period.id}
      companyName={companyName}
    />
  );
}

// ─── Workspace snapshot ────────────────────────────────────────────
// Serialise the active period into a compact text snapshot the LLM uses
// as ground truth for THIS user's company-specific figures. The model
// is instructed (server-side, in cfo_ai._build_workspace_chat_system_prompt)
// to cite the period when quoting any figure here and to say "I don't
// have that in the workspace" when asked for anything not present —
// never to fabricate the user's own numbers.
//
// Read-only: this function does NOT recompute, derive, or transform
// any engine value; it formats values the engine already emitted.

function buildWorkspaceSnapshot(p: ReturnType<typeof useActivePeriod>): string | undefined {
  if (!p.id) return undefined;

  const lines: string[] = [];
  lines.push(`Period: ${p.label ?? p.id}`);
  if (p.statements?.companyName) lines.push(`Company: ${p.statements.companyName}`);
  if (p.industry) lines.push(`Industry: ${p.industry}`);

  if (p.metrics && p.metrics.length > 0) {
    lines.push("");
    lines.push("Headline metrics (server-computed):");
    for (const m of p.metrics as PeriodMetric[]) {
      if (m.value === null || m.value === undefined) continue;
      const unit = m.unit ? ` ${m.unit}` : "";
      lines.push(`  · ${m.name}: ${fmtNum(m.value)}${unit}`);
    }
  }

  const apl = (p.statements as unknown as { assembled_pl?: Record<string, number> } | null)?.assembled_pl;
  const abs = (p.statements as unknown as { assembled_bs?: Record<string, number> } | null)?.assembled_bs;
  const acf = (p.statements as unknown as { assembled_cf?: Record<string, number | boolean> } | null)?.assembled_cf;

  // Canonical metrics — single source of truth. The assistant sees the
  // SAME Reported / Core / acct-121 figures the Dashboard surfaces, so
  // when the user asks "what's our EBITDA?" the answer can't drift
  // from what's on the screen. See `src/lib/canonicalMetrics.ts`.
  const canonical = buildCanonicalMetrics(p);
  if (canonical) {
    lines.push("");
    lines.push("Canonical metrics (single source of truth):");
    pushIf(lines, "Revenue",                                   canonical.headline.revenue);
    pushIf(lines, "Total operating revenue",                   canonical.headline.total_operating_revenue);
    pushIf(lines, "EBITDA — reported (legal view, ties to acct 121)", canonical.ebitda.reported);
    pushIf(lines, "EBITDA — core (basis for valuation)",       canonical.ebitda.core);
    if (canonical.ebitda.adjustments.length > 0) {
      lines.push("  EBITDA Reported→Core bridge (canonical):");
      for (const a of canonical.ebitda.adjustments) {
        lines.push(`    − ${a.account} ${a.label}: ${fmtNum(a.amount)}`);
      }
    } else {
      lines.push("  (no 758/781 movements on file — Reported = Core for this period)");
    }
    pushIf(lines, "EBIT",                                      canonical.headline.ebit);
    pushIf(lines, "Net profit — statutory (acct 121)",         canonical.netProfit.statutory_account_121);
    pushIf(lines, "Net profit — reconstructed (bottom-up)",    canonical.netProfit.reconstructed);
    pushIf(lines, "Reconciliation gap (RON)",                  canonical.netProfit.reconciliation_gap);
    if (canonical.netProfit.gap_pct !== null) {
      lines.push(`  · Gap %: ${canonical.netProfit.gap_pct.toFixed(2)}%`);
    }
    pushIf(lines, "Capitalized own work (722, memo)",          canonical.headline.capitalized_own_work_memo);
    pushIf(lines, "Interest expense",                          canonical.headline.interest_expense);
    pushIf(lines, "Depreciation",                              canonical.headline.depreciation);
    pushIf(lines, "Tax",                                       canonical.headline.tax);
  }
  const served = p.statements ? factsFrom(p.statements as Statements) : null;
  if (served && (served.isCanonical || abs || served.totalAssets() !== 0)) {
    // Grand totals via the servedFacts gateway — the ADJUSTED served
    // figures (identical to the BS tab and both exports); bucket-level
    // highlights keep their assembled_bs reads (no canonical equivalent).
    lines.push("");
    lines.push("Balance sheet highlights:");
    pushIf(lines, "Total assets", served.totalAssets());
    pushIf(lines, "Total equity", served.totalEquity());
    pushIf(lines, "Total liabilities", served.totalLiabilities());
    const status = served.status();
    if (status) {
      lines.push(`  · Balance status: ${status}`);
      const rec = served.reconciliation();
      if (status === "RECONCILED" && rec) {
        lines.push(
          `  · Reconciliation: a source imbalance of ${fmtNum(rec.original_difference)} was closed by the visible adjusting line "Diferențe de reconciliere" (${rec.placement === "pnl" ? "P&L" : "balance sheet"} placement, ${rec.origin}); totals above include the adjustment. Reconciled is not balanced.`,
        );
      }
    }
    if (abs) {
      pushIf(lines, "Total debt", abs.total_debt);
      pushIf(lines, "Cash", abs.cash);
      pushIf(lines, "Accounts receivable (net)", abs.ar_net);
      pushIf(lines, "Accounts payable", abs.ap);
      pushIf(lines, "PP&E (net)", abs.ppe_net);
    }
  }
  if (acf) {
    lines.push("");
    lines.push("Cash flow highlights:");
    // `assembled_cf` mixes numbers and booleans in one record, so each read
    // is `number | boolean`. These lines become the context string the
    // assistant reasons over — a boolean reaching a money line would put
    // "Cash from operating: true" in front of the model. The four reads
    // below used to be `as number | undefined` casts, which asserted the
    // union away instead of resolving it; `acfNum`/`acfBool` narrow for
    // real, so a shape change is caught rather than asserted past.
    pushIfBool(lines, "Approximated (single-period upload)", acfBool(acf.is_approximated));
    pushIf(lines, "Cash from operating", acfNum(acf.cash_from_operating));
    pushIf(lines, "Cash used in investing", acfNum(acf.cash_used_in_investing));
    pushIf(lines, "Cash used in financing", acfNum(acf.cash_used_in_financing));
    pushIf(lines, "Net change in cash", acfNum(acf.net_change_in_cash));
  }

  if (p.briefing && p.briefing.trim()) {
    lines.push("");
    lines.push("Prior engine-generated briefing:");
    lines.push(p.briefing.trim());
  }

  if (p.recommendations && p.recommendations.length > 0) {
    lines.push("");
    lines.push("Recommendations on file:");
    for (const r of p.recommendations.slice(0, 8)) {
      const rec = r as { urgency?: string | null; title?: string | null };
      const sev = rec.urgency ? `[${rec.urgency}] ` : "";
      lines.push(`  · ${sev}${rec.title ?? "(untitled)"}`);
    }
  }

  if (p.alerts && p.alerts.length > 0) {
    lines.push("");
    lines.push("Alerts on file:");
    for (const a of p.alerts.slice(0, 8)) {
      const alert = a as { severity?: string | null; title?: string | null };
      const sev = alert.severity ? `[${alert.severity}] ` : "";
      lines.push(`  · ${sev}${alert.title ?? "(untitled)"}`);
    }
  }

  return lines.join("\n");
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}
/** Narrow one `assembled_cf` field. The view is heterogeneous by design
 *  (numeric flows beside `is_approximated`), so an indexed read is a union;
 *  absent or wrong-typed becomes undefined, and `pushIf` then omits the
 *  line entirely rather than showing the assistant a made-up figure. */
function acfNum(v: number | boolean | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function acfBool(v: number | boolean | undefined): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function pushIf(lines: string[], label: string, val: number | undefined | null): void {
  if (val === undefined || val === null || !Number.isFinite(val)) return;
  lines.push(`  · ${label}: ${fmtNum(val)}`);
}
function pushIfBool(lines: string[], label: string, val: boolean | undefined): void {
  if (val === undefined || val === null) return;
  lines.push(`  · ${label}: ${val ? "yes" : "no"}`);
}
