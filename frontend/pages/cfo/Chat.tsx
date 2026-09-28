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
import {
  EQUITY_INCOMPLETE_METRICS, NET_RESULT_REFUSED_METRICS, assembledPlOf, equityRefusalOf, netIncomeRefusalOf,
  readServedOneEbitda,
} from "@/lib/servedOneEbitda";
// servedFacts gateway — the snapshot's BS totals are the SERVED
// (reconciliation-adjusted) figures, so the assistant quotes the same
// book the dashboard, exports and BS tab show.
import { STOCK_SLOW_CLAIM_RULE, printInventoryDays, readInventoryDaysSplit } from "@/lib/inventoryDays";
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

export function buildWorkspaceSnapshot(p: ReturnType<typeof useActivePeriod>): string | undefined {
  if (!p.id) return undefined;

  const lines: string[] = [];
  lines.push(`Period: ${p.label ?? p.id}`);
  if (p.statements?.companyName) lines.push(`Company: ${p.statements.companyName}`);
  if (p.industry) lines.push(`Industry: ${p.industry}`);

  if (p.metrics && p.metrics.length > 0) {
    // A row the engine REFUSES on these statements is never handed to the
    // assistant as a figure, whatever the row holds (a period persisted
    // before the refusal still carries the build-up under `net_income` and
    // the equity ratios on the short equity — critic round 3, 2026-09-28):
    // it is stated refused, with the engine's reason.
    const niRefusal = netIncomeRefusalOf(p.statements);
    const eqRefusal = equityRefusalOf(p.statements);
    const refusalOfRow = (name: string) =>
      (niRefusal && NET_RESULT_REFUSED_METRICS.includes(name) ? niRefusal : null)
      ?? (eqRefusal && EQUITY_INCOMPLETE_METRICS.includes(name) ? eqRefusal : null);
    lines.push("");
    lines.push("Headline metrics (server-computed):");
    for (const m of p.metrics as PeriodMetric[]) {
      const refused = refusalOfRow(m.name);
      if (refused) {
        lines.push(`  · ${m.name}: REFUSED — ${refused.text.en}`);
        continue;
      }
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
    // THE ONE EBITDA (owner ruling 2026-09-26): the stock variation (711)
    // and own work capitalised (72x) are inside it; turnover is 70x − 709.
    // A refused EBITDA is stated with the engine's reason — the assistant
    // must never be handed a number where the dashboard prints a refusal.
    pushIf(lines, "Net turnover (cifra de afaceri netă, 70x − 709)", canonical.headline.revenue);
    if (canonical.ebitda.reported === null) {
      lines.push(
        `  · EBITDA: REFUSED — ${canonical.ebitda.refusal?.text.en ?? "the engine served no EBITDA for this period"} ` +
          `(EBIT, EBITDA margins and EBITDA-based ratios are refused with it)`,
      );
    }
    pushIf(lines, "EBITDA (711 and 72x inside)",               canonical.ebitda.reported);
    // Its two components as the engine served them — the figure, or the
    // engine's own refusal words (a refused 711 is never handed over as a
    // zero, and never silently dropped: the assistant must be able to say
    // WHY the EBITDA above is refused).
    const oneEbitda = readServedOneEbitda(assembledPlOf(p.statements));
    for (const [label, served, figure] of [
      ["Variația stocurilor de produse (net 711, inside EBITDA)", oneEbitda?.inventoryVariation ?? null, canonical.ebitda.inventory_variation],
      ["Own work capitalised (net 72x, inside EBITDA)", oneEbitda?.capitalizedOwnWork ?? null, canonical.ebitda.capitalized_own_work],
    ] as const) {
      if (served && served.value === null && served.refusal) lines.push(`  · ${label}: REFUSED — ${served.refusal.text.en}`);
      else pushIf(lines, label, figure);
    }
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
    if (canonical.netProfit.refusal) {
      lines.push(
        `  · Net profit: REFUSED — ${canonical.netProfit.refusal.text.en} ` +
          `(net margin, ROE and ROA are refused with it)`,
      );
    }
    pushIf(lines, "Net profit — statutory (acct 121)",         canonical.netProfit.statutory_account_121);
    pushIf(lines, "Net result built from the accounts",        canonical.netProfit.reconstructed);
    pushIf(lines, "Not explained by the accounts (RON)",       canonical.netProfit.reconciliation_gap);
    if (canonical.netProfit.gap_pct !== null) {
      lines.push(`  · Gap %: ${canonical.netProfit.gap_pct.toFixed(2)}%`);
    }
    pushIf(lines, "Interest expense",                          canonical.headline.interest_expense);
    pushIf(lines, "Depreciation",                              canonical.headline.depreciation);
    pushIf(lines, "Tax",                                       canonical.headline.tax);
  }
  const served = p.statements ? factsFrom(p.statements as Statements) : null;
  // `totalAssets()` is ABSENT-CAPABLE. `null !== 0` is true, which would
  // open a "Balance sheet highlights:" heading with nothing under it —
  // every line beneath is a `pushIf` that skips a non-number. The probe
  // asks the question it means: did the gateway state a non-zero total?
  const servedAssets = served ? served.totalAssets() : null;
  if (
    served &&
    (served.isCanonical || abs || (typeof servedAssets === "number" && servedAssets !== 0))
  ) {
    // Grand totals via the servedFacts gateway — the ADJUSTED served
    // figures (identical to the BS tab and both exports); bucket-level
    // highlights keep their assembled_bs reads (no canonical equivalent).
    lines.push("");
    lines.push("Balance sheet highlights:");
    pushIf(lines, "Total assets", served.totalAssets());
    // Total equity the engine REFUSED as the company's equity (it excludes a
    // refused year's result — critic round 2, 2026-09-27): stated with the
    // reason, never handed to the assistant as a figure it could divide.
    const equityRefusal = canonical?.balance.equity_refusal ?? null;
    if (equityRefusal) {
      lines.push(
        `  · Total equity: REFUSED — ${equityRefusal.text.en} ` +
          `(the equity ratio, debt / equity, ROE and a book-equity value are refused with it)`,
      );
    } else {
      pushIf(lines, "Total equity", served.totalEquity());
    }
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
  // INVENTORY DAYS — the ONE served block (engine.ratios.inventory_days),
  // printed as every surface prints it, and its CLAIM POLICY (owner spec
  // 2026-09-26 P1.5, design B5): the assistant may call stock slow or high
  // only when the policy allows it, and must cite the split and the average.
  //
  // The TOTAL is printed WITH its basis label on its own line ("… 49 days …
  // — Basis: stock at 31 December — a single day"): a figure handed over
  // without its basis is the one a model calls "slow". Where the policy
  // does NOT allow a slow claim, the snapshot carries ONE plain rule line
  // (STOCK_SLOW_CLAIM_RULE, the owner's Romanian with the English): the
  // Ask CFO AI edge function (supabase/functions/chat-llm) cannot be
  // redeployed in this release, so the rule rides here, in the
  // `dataset_summary` it already puts into its system prompt.
  const inventorySplit = p.statements ? readInventoryDaysSplit(p.statements) : null;
  if (inventorySplit) {
    const printed = printInventoryDays(inventorySplit, "en");
    lines.push("");
    lines.push(`${printed.title} (served; the dio / ccc / inventory_turnover metrics above read it):`);
    const row = (r: { label: string; accounts: string; days: string; flow: string }): string =>
      `  · ${r.label}${r.accounts ? ` (${r.accounts})` : ""}: ${r.days}${r.flow ? ` ${r.flow}` : ""}`;
    for (const r of [...printed.legs, ...(printed.other ? [printed.other] : [])]) lines.push(row(r));
    lines.push(`${row(printed.total)}${printed.basis ? ` — ${printed.basis}` : ""}`);
    for (const note of [printed.closing ?? "", ...printed.notes]) {
      if (note) lines.push(`  · ${note}`);
    }
    lines.push(
      `  · Claim policy: stock ${inventorySplit.maySlowClaim ? "MAY" : "may NOT"} be called slow or high` +
        `${inventorySplit.claimText ? ` — ${inventorySplit.claimText.en}` : ""}.`,
    );
    if (!inventorySplit.maySlowClaim) {
      lines.push(`  · Rule: ${STOCK_SLOW_CLAIM_RULE.en} (RO: ${STOCK_SLOW_CLAIM_RULE.ro})`);
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
