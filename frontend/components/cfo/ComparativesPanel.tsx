// ComparativesPanel — the controls (which prior, which columns) and the
// summary (comparability, the variance bridge, top movers) for two
// periods side by side.
//
// Everything numeric here is the engine's document
// (`/api/period/{id}/comparatives`): the bridge steps, whether the walk
// closes, the movers and their verdicts, the materiality floor. This
// file formats and refuses; it computes nothing a reader could disagree
// with.
import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";

import {
  detailLevelLabelKey,
  formatDeltaPct,
  type BridgeDto,
  type ComparativesResponse,
  type MoverDto,
} from "@/lib/comparatives";
import type { OrgPeriod } from "@/lib/orgPeriods";
import { formatPeriodMonth } from "@/lib/orgPeriods";
import { useComparativesView, type ComparativeColumns } from "@/stores/comparativesView";
import { useAmountFormatter } from "@/stores/currency";
import { MONEY_MISSING } from "@/lib/money";

// ── Prior ratios, for the Ratios tab's tiles ─────────────────────────
// The prior period's RatioBundle — computed by the SAME computeRatios on
// the prior's own served statements and metrics — keyed by ratio key.
// Provided by the dashboard at the tab's call site; a tile outside the
// provider (or with no prior) renders its single-period markup.
export interface RatioPrior {
  byKey: Map<string, number | null>;
  label: string;
}

export const RatioPriorCtx = createContext<RatioPrior | null>(null);

export function useRatioPrior(): RatioPrior | null {
  return useContext(RatioPriorCtx);
}

/** Flatten a RatioBundle-shaped object (groups of `{key, value}` rows)
 *  into a key → value map. Non-array fields are ignored. */
export function ratioPriorFromBundle(
  bundle: Record<string, unknown> | null | undefined,
  label: string,
): RatioPrior | null {
  if (!bundle) return null;
  const byKey = new Map<string, number | null>();
  for (const group of Object.values(bundle)) {
    if (!Array.isArray(group)) continue;
    for (const r of group) {
      if (r && typeof r === "object" && typeof (r as { key?: unknown }).key === "string") {
        const v = (r as { value?: unknown }).value;
        byKey.set((r as { key: string }).key, typeof v === "number" && Number.isFinite(v) ? v : null);
      }
    }
  }
  return { byKey, label };
}

// ── Controls ─────────────────────────────────────────────────────────

export function ComparativesControls({
  periods,
  currentId,
  autoPick,
  currency: _currency,
}: {
  /** Every period of the workspace, newest first. */
  periods: readonly OrgPeriod[];
  currentId: string | null;
  /** What AUTO resolves to right now, for the option label. */
  autoPick: OrgPeriod | null;
  currency: string;
}) {
  const { t } = useTranslation();
  const { view, setPriorPeriodId, setColumn } = useComparativesView();
  const candidates = periods.filter((p) => p.period_id !== currentId);
  const value = view.priorPeriodId === null ? "auto" : view.priorPeriodId;
  const label = (p: OrgPeriod) => formatPeriodMonth(p.period_end) ?? p.period_label;
  const toggles: { key: keyof ComparativeColumns; label: string }[] = [
    { key: "prior", label: t("statements.cmp.colPrior") },
    { key: "delta", label: t("statements.cmp.colDelta") },
    { key: "deltaPct", label: t("statements.cmp.colDeltaPct") },
    { key: "share", label: t("statements.cmp.colShare") },
  ];
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2 text-[12px] text-ink-soft"
      data-testid="comparatives-controls"
    >
      <label className="inline-flex items-center gap-2">
        <span className="font-mono uppercase tracking-[0.08em] text-[10.5px] text-ink-mute">
          {t("statements.cmp.compareWith")}
        </span>
        <select
          data-testid="comparatives-prior-select"
          className="h-8 rounded-sm border border-rule bg-surface px-2 text-[12.5px] text-ink"
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            setPriorPeriodId(v === "auto" ? null : v === "none" ? "none" : v);
          }}
        >
          <option value="auto">
            {t("statements.cmp.auto")}{autoPick ? ` — ${label(autoPick)}` : ""}
          </option>
          <option value="none">{t("statements.cmp.none")}</option>
          {candidates.map((p) => (
            <option key={p.period_id} value={p.period_id}>{label(p)}</option>
          ))}
        </select>
      </label>
      {view.priorPeriodId !== "none" && (
        <div className="inline-flex items-center gap-3" data-testid="comparatives-columns">
          <span className="font-mono uppercase tracking-[0.08em] text-[10.5px] text-ink-mute">
            {t("statements.cmp.columns")}
          </span>
          {toggles.map((c) => (
            <label key={c.key} className="inline-flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                data-testid={`comparatives-col-${c.key}`}
                checked={view.columns[c.key]}
                onChange={(e) => setColumn(c.key, e.target.checked)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Summary ──────────────────────────────────────────────────────────

function Bridge({ bridge, title, currency }: { bridge: BridgeDto; title: string; currency: string }) {
  const { t } = useTranslation();
  const fmt = useAmountFormatter(currency);
  const signed = (v: number) =>
    Math.abs(v) < 0.005 ? "0" : fmt(v, { sign: v > 0 ? "positive" : "negative" });
  return (
    <div className="rounded-md border border-rule bg-surface p-4" data-testid={`cmp-bridge-${bridge.statement.toLowerCase()}`} data-closes={bridge.closes}>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h4 className="text-[13px] font-semibold text-ink">{title}</h4>
        <span className={`text-[10.5px] font-mono uppercase tracking-[0.06em] ${bridge.closes ? "text-ink-mute" : "text-alert"}`}>
          {bridge.closes ? t("statements.cmp.bridgeCloses") : t("statements.cmp.refusedTitle")}
        </span>
      </div>
      <div className="font-mono tabular-nums text-[12.5px]">
        <div className="flex justify-between gap-3 py-1 border-b border-rule-soft">
          <span className="text-ink-soft">{t("statements.cmp.bridgePrior", { label: bridge.from_label })}</span>
          <span className="text-ink">{bridge.prior_total === null ? MONEY_MISSING : fmt(bridge.prior_total)}</span>
        </div>
        {bridge.steps.map((s) => (
          <div key={s.key} className="flex justify-between gap-3 py-1" data-step={s.key} data-step-status={s.status}>
            <span className="text-ink-soft truncate">
              {s.label}
              {s.status === "new" && <span className="ml-1 text-ink-mute uppercase text-[10px]">{t("statements.cmp.new")}</span>}
              {s.status === "gone" && <span className="ml-1 text-ink-mute uppercase text-[10px]">{t("statements.cmp.gone")}</span>}
            </span>
            <span className={s.amount > 0.005 ? "text-success" : s.amount < -0.005 ? "text-alert" : "text-ink-mute"}>
              {signed(s.amount)}
            </span>
          </div>
        ))}
        <div className="flex justify-between gap-3 py-1 border-t border-rule font-semibold">
          <span className="text-ink">{t("statements.cmp.bridgeCurrent", { label: bridge.to_label })}</span>
          <span className="text-ink">{bridge.current_total === null ? MONEY_MISSING : fmt(bridge.current_total)}</span>
        </div>
      </div>
      {!bridge.closes && (
        <p className="mt-2 text-[12px] text-alert" data-testid="cmp-bridge-refused">
          {t("statements.cmp.bridgeRefused", { reason: bridge.reason })}
        </p>
      )}
    </div>
  );
}

function MoverRow({ m, currency }: { m: MoverDto; currency: string }) {
  const { t } = useTranslation();
  const fmt = useAmountFormatter(currency);
  const pct = formatDeltaPct(m.delta_pct);
  return (
    <li className="flex items-baseline justify-between gap-3 py-1 text-[12.5px]" data-mover={m.key} data-verdict={m.verdict ?? "none"}>
      <span className="text-ink truncate">{m.label}</span>
      <span className="font-mono tabular-nums whitespace-nowrap">
        <span className={m.delta !== null && m.delta > 0 ? "text-success" : "text-alert"}>
          {m.delta === null ? MONEY_MISSING : fmt(m.delta, { sign: m.delta > 0 ? "positive" : "negative" })}
        </span>
        {pct && <span className="ml-2 text-ink-soft">{pct}</span>}
        <span className="ml-2 text-ink-mute text-[11px]">
          {t("statements.cmp.materiality", { pct: `${(m.materiality * 100).toFixed(1)}%`, base: m.base_key === "pl.revenue" ? "revenue" : "total assets" })}
        </span>
      </span>
    </li>
  );
}

export function ComparativesSummary({
  doc,
  statement,
  currency,
}: {
  doc: ComparativesResponse;
  /** Which bridges to show on this tab. */
  statement: "PL" | "BS";
  currency: string;
}) {
  const { t } = useTranslation();
  const mv = doc.movers;
  const base = mv.bases[statement];
  const baseName = statement === "PL" ? t("statements.cmp.colShare").replace("% of ", "") : t("statements.cmp.colShareBs").replace("% of ", "");
  const floorPct = `${(mv.materiality_floor * 100).toFixed(1)}%`;
  const inStatement = (m: MoverDto) => m.statement === statement;
  const top = mv.top.filter(inStatement);
  const improved = mv.improved.filter(inStatement);
  const deteriorated = mv.deteriorated.filter(inStatement);
  return (
    <section className="space-y-4" data-testid={`comparatives-summary-${statement.toLowerCase()}`}>
      <p className="text-[12.5px] text-ink-soft" data-testid="cmp-comparability">
        {t("statements.cmp.detailNote", {
          current: doc.current.label,
          currentLevel: t(detailLevelLabelKey(doc.current.detail_level.level)),
          prior: doc.prior.label,
          priorLevel: t(detailLevelLabelKey(doc.prior.detail_level.level)),
        })}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {statement === "PL" ? (
          <Bridge bridge={doc.bridges.pl} title={`${t("statements.cmp.bridgeTitle")} — ${t("statements.cmp.bridgePl")}`} currency={currency} />
        ) : (
          <>
            <Bridge bridge={doc.bridges.bs_assets} title={`${t("statements.cmp.bridgeTitle")} — ${t("statements.cmp.bridgeAssets")}`} currency={currency} />
            <Bridge bridge={doc.bridges.bs_liabilities_equity} title={`${t("statements.cmp.bridgeTitle")} — ${t("statements.cmp.bridgeLe")}`} currency={currency} />
          </>
        )}
        <div className="rounded-md border border-rule bg-surface p-4" data-testid="cmp-movers">
          <h4 className="text-[13px] font-semibold text-ink mb-2">{t("statements.cmp.moversTitle")}</h4>
          {top.length === 0 ? (
            <p className="text-[12px] text-ink-mute">{t("statements.cmp.nothingAbove", { floor: floorPct, base: baseName })}</p>
          ) : (
            <ul className="divide-y divide-rule-soft">
              {top.map((m) => <MoverRow key={m.key} m={m} currency={currency} />)}
            </ul>
          )}
          {(improved.length > 0 || deteriorated.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2 mt-3">
              <div data-testid="cmp-improved">
                <div className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-success mb-1">{t("statements.cmp.improved")}</div>
                <ul className="text-[12px] text-ink space-y-0.5">
                  {improved.map((m) => <li key={m.key}>{m.label}</li>)}
                </ul>
              </div>
              <div data-testid="cmp-deteriorated">
                <div className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-alert mb-1">{t("statements.cmp.deteriorated")}</div>
                <ul className="text-[12px] text-ink space-y-0.5">
                  {deteriorated.map((m) => <li key={m.key}>{m.label}</li>)}
                </ul>
              </div>
            </div>
          )}
          <p className="mt-3 text-[11px] text-ink-mute">
            {base && base[1] !== null
              ? t("statements.cmp.belowFloor", { n: mv.below_floor, floor: floorPct, base: baseName })
              : null}
          </p>
        </div>
      </div>
    </section>
  );
}

export function ComparativesRefusedNote({ code, message }: { code: string; message: string }) {
  const { t } = useTranslation();
  const text =
    code === "same_period" ? t("statements.cmp.refusedSame")
    : code === "period_not_in_workspace" ? t("statements.cmp.refusedNotInWorkspace")
    : message;
  return (
    <p className="text-[12.5px] text-ink-soft" data-testid="comparatives-refused" data-code={code}>
      {t("statements.cmp.refusedTitle")}: {text}
    </p>
  );
}
