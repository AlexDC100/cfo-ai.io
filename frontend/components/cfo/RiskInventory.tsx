// Risk Inventory — Section 7 of the comprehensive report.
//
// Renders the 5-8 named risks the deterministic engine identifies in
// `stage_validate` (see src/engine/api/pipeline.py — the rules tagged
// `category='risk_inventory'`). These come back from the alerts API as
// regular alert rows; this component filters by category and renders
// them grouped by severity with a clean numbered layout.
//
// Each row carries a `rule_key` (machine-readable identifier), a
// severity tag, a title, and a body. The component does NOT generate
// risk text — it only displays what the engine produced. That keeps
// risk content audit-able and reproducible.

import { AlertTriangle, AlertCircle, Info } from "lucide-react";

export interface RiskInventoryItem {
  rule_key: string;
  severity: "critical" | "high" | "medium" | "low" | "info" | string;
  title: string;
  body: string;
  facts_cited?: Record<string, number> | null;
}

interface Props {
  /** All alerts for the period — this component filters them down to
   *  `category='risk_inventory'`. Pass the unfiltered list so it can
   *  surface a "no risks identified" state without an empty wrapper. */
  allAlerts: Array<RiskInventoryItem & { category?: string | null }>;
  /** Hide the section heading (e.g. when the report renders its own). */
  hideHeader?: boolean;
}

export function RiskInventory({ allAlerts, hideHeader = false }: Props) {
  // Filter via `rule_key` prefix rather than `category`. The DB CHECK
  // constraint on alerts.category doesn't accept a `risk_inventory`
  // value, so the back-end persists each rule under its natural
  // category (liquidity / leverage / margin / etc.) and uses the
  // `rule_key` prefix `risk_inventory_*` as the Section-7 selector.
  const risks = allAlerts.filter((a) => (a.rule_key ?? "").startsWith("risk_inventory_"));
  // Severity sort: critical → high → medium → low → info
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  risks.sort((a, b) => (order[a.severity] ?? 99) - (order[b.severity] ?? 99));

  return (
    <section data-testid="risk-inventory" className="space-y-3">
      {!hideHeader && (
        <header>
          <h2 className="text-[16px] font-semibold tracking-[-0.005em] text-ink">Risk inventory</h2>
          <p className="mt-1 text-[12.5px] text-ink-soft max-w-[680px]">
            Structural risks the deterministic engine identified from the
            financial statements. Each risk fires from a rule with cited
            facts — the underlying numbers are in the financial-statements
            tab.
          </p>
        </header>
      )}
      {risks.length === 0 ? (
        <div className="rounded-md border border-rule bg-bg-2/40 px-4 py-4 text-[13px] text-ink-soft">
          No structural risks fired. This doesn't mean the company is risk-free
          — it means the standard 7 rules (receivables quality, liquidity,
          raw-material exposure, affiliate dependency, asset maturity,
          leverage, FX exposure) didn't trip thresholds. Always pair with
          qualitative due diligence.
        </div>
      ) : (
        <ol className="space-y-2.5">
          {risks.map((r, i) => (
            <RiskRow key={r.rule_key} risk={r} ordinal={i + 1} />
          ))}
        </ol>
      )}
    </section>
  );
}

function RiskRow({ risk, ordinal }: { risk: RiskInventoryItem; ordinal: number }) {
  const sev = risk.severity;
  // Severity is SEMANTIC, not brand: red only for critical (danger),
  // amber caution for high/medium, slate info for the rest.
  const sevColor =
    sev === "critical" ? "border-alert/40 bg-alert-tint/60"
    : sev === "high"   ? "border-caution/40 bg-caution-tint/60"
    : sev === "medium" ? "border-caution/30 bg-caution-tint/40"
    : "border-rule bg-bg-2/60";
  const sevText =
    sev === "critical" ? "text-alert"
    : sev === "high"   ? "text-caution"
    : sev === "medium" ? "text-caution"
    : "text-info";
  const SevIcon = sev === "critical" || sev === "high" ? AlertTriangle
    : sev === "medium" ? AlertCircle
    : Info;
  const sevLabel = sev.charAt(0).toUpperCase() + sev.slice(1);

  return (
    <li
      data-testid="risk-inventory-row"
      data-rule-key={risk.rule_key}
      data-severity={sev}
      className={`rounded-md border px-4 py-3 ${sevColor}`}
    >
      <div className="flex items-start gap-3">
        <span className="font-mono text-[13px] text-ink-mute tabular-nums shrink-0 w-6">{ordinal}.</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <SevIcon size={13} strokeWidth={2} className={sevText} />
            <span className={`text-[10px] uppercase tracking-[0.1em] font-medium ${sevText}`}>
              {sevLabel}
            </span>
            <span className="text-[13.5px] font-medium text-ink">{risk.title}</span>
          </div>
          <p className="text-[12.5px] text-ink-soft leading-relaxed">{risk.body}</p>
        </div>
      </div>
    </li>
  );
}
