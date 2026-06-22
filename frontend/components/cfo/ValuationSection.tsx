// Dashboard valuation surface — server-computed EBITDA × peer-multiple as the
// headline, with DCF and EV/Revenue rendered as cross-checks. The "football
// field" chart at the bottom plots every method on the same x-axis so the
// user can eyeball the spread.
//
// Why this lives here (not inside FinancialStatements.tsx):
//   The existing in-page ValuationPanel runs client-side WACC + DCF + Graham
//   math against the Statements blob. That math stays — useful when there's
//   no server-side valuation yet. This component reads valuations from the
//   backend (PeriodValuation, loaded via useActivePeriod) and presents the
//   industry-aware peer-multiple primary method that Phase II makes the
//   headline.
//
// Interaction surface (Step 4):
//   · Multiple slider — drag between the P25 and P75 industry multiples.
//   · EBITDA / Debt / Cash editable pills — click to override the engine
//     defaults. Each fires a PUT /api/period/:id/valuation-assumptions
//     and refetches the period so the football field repaints with the
//     new equity values.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Info } from "lucide-react";
import type { PeriodValuation } from "@/lib/activePeriod";
import { periodQueryKey } from "@/lib/activePeriod";
import { getSupabase } from "@/lib/supabase";
import { useCurrency } from "@/stores/currency";
import { convertFromTo } from "@/lib/money";
import type { Currency } from "@/lib/rates";

interface Props {
  valuation: PeriodValuation;
  periodId: string;
  currency: string;
}

/** Currency-aware money formatter. Converts the source-currency value
 *  through the global currency switcher (RON → EUR → USD) before
 *  rendering, so every call site flips currency when the user toggles
 *  the top bar. Used in JSX where we need a string (KpiTile values,
 *  slider labels, formula lines). */
function useFmtMoney() {
  const { display, rates } = useCurrency();
  return (n: number | null | undefined, sourceCurrency: string): string => {
    if (n === null || n === undefined) return "—";
    const src = (sourceCurrency || "RON") as Currency;
    const converted = convertFromTo(n, src, display, rates.rates);
    const sign = converted < 0 ? "-" : "";
    const a = Math.abs(converted);
    if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(2)}M ${display}`;
    if (a >= 1_000) return `${sign}${(a / 1_000).toFixed(0)}K ${display}`;
    return `${sign}${a.toFixed(0)} ${display}`;
  };
}

function fmtMultiple(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(1)}×`;
}

function confidenceTone(c: PeriodValuation["confidence"]) {
  if (c === "high") return { dot: "bg-emerald-500", text: "text-emerald-700", label: "High confidence" };
  if (c === "medium") return { dot: "bg-amber-500", text: "text-amber-700", label: "Medium confidence" };
  return { dot: "bg-slate-400", text: "text-slate-600", label: "Low confidence" };
}

async function saveAssumptions(periodId: string, body: Record<string, number | null>): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return false;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  const res = await fetch(`${apiUrl}/api/period/${periodId}/valuation-assumptions`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function resetAssumptions(periodId: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return false;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  const res = await fetch(`${apiUrl}/api/period/${periodId}/valuation-assumptions`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

export function ValuationSection({ valuation, periodId, currency }: Props) {
  const qc = useQueryClient();
  const conf = confidenceTone(valuation.confidence);
  const hasUserOverrides = !!valuation.user_assumptions;
  const fmtMoney = useFmtMoney();

  // Local-edit state for the four inputs. Initialized from server values;
  // PUT calls fire on blur (for pills) or after a 300ms debounce (slider).
  const initialEbitda = valuation.inputs.ebitda_used ?? 0;
  const initialDebt = valuation.inputs.total_debt_used ?? 0;
  const initialCash = valuation.inputs.cash_used ?? 0;
  const initialMultiple = valuation.primary.multiple_p50 ?? 0;
  const minMultiple = valuation.primary.multiple_p25 ?? Math.max(initialMultiple - 5, 0);
  const maxMultiple = valuation.primary.multiple_p75 ?? initialMultiple + 5;

  const [ebitda, setEbitda] = useState<number>(initialEbitda);
  const [debt, setDebt] = useState<number>(initialDebt);
  const [cash, setCash] = useState<number>(initialCash);
  const [multiple, setMultiple] = useState<number>(initialMultiple);
  const [saving, setSaving] = useState(false);

  // Re-sync if the period valuation reloads (e.g. after pipeline re-run or reset)
  useEffect(() => {
    setEbitda(valuation.inputs.ebitda_used ?? 0);
    setDebt(valuation.inputs.total_debt_used ?? 0);
    setCash(valuation.inputs.cash_used ?? 0);
    setMultiple(valuation.primary.multiple_p50 ?? 0);
  }, [
    valuation.inputs.ebitda_used,
    valuation.inputs.total_debt_used,
    valuation.inputs.cash_used,
    valuation.primary.multiple_p50,
  ]);

  const persist = useCallback(
    async (overrides: Partial<{ ebitda: number; multiple: number; debt: number; cash: number }>) => {
      setSaving(true);
      const body = {
        ebitda_used: overrides.ebitda ?? ebitda,
        multiple_used: overrides.multiple ?? multiple,
        debt_used: overrides.debt ?? debt,
        cash_used: overrides.cash ?? cash,
      };
      const ok = await saveAssumptions(periodId, body);
      setSaving(false);
      if (ok) {
        qc.invalidateQueries({ queryKey: periodQueryKey(periodId) });
      }
    },
    [ebitda, multiple, debt, cash, periodId, qc],
  );

  // Debounced slider commit
  useEffect(() => {
    if (multiple === (valuation.primary.multiple_p50 ?? 0)) return;
    const t = setTimeout(() => { void persist({ multiple }); }, 350);
    return () => clearTimeout(t);
  }, [multiple, valuation.primary.multiple_p50, persist]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    const ok = await resetAssumptions(periodId);
    setSaving(false);
    if (ok) {
      qc.invalidateQueries({ queryKey: periodQueryKey(periodId) });
    }
  }, [periodId, qc]);

  // Client-side recomputed primary equity preview while the user drags the slider
  // before the server round-trip completes. Same formula as the engine.
  const livePreviewEquity = useMemo(() => {
    return ebitda * multiple - debt + cash;
  }, [ebitda, multiple, debt, cash]);

  // Football-field domain: span across every method's low / high
  const fieldRange = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of valuation.football_field) {
      if (r.low !== null && r.low < lo) lo = r.low;
      if (r.high !== null && r.high > hi) hi = r.high;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi === lo) {
      return { lo: 0, hi: Math.max(livePreviewEquity * 1.5, 1) };
    }
    // Pad ends 5% so bars don't kiss the axis
    const pad = (hi - lo) * 0.05;
    return { lo: lo - pad, hi: hi + pad };
  }, [valuation.football_field, livePreviewEquity]);

  function fieldPos(x: number): number {
    const range = fieldRange.hi - fieldRange.lo;
    if (range <= 0) return 0;
    return Math.max(0, Math.min(100, ((x - fieldRange.lo) / range) * 100));
  }

  return (
    <section
      data-testid="valuation-section"
      className="space-y-6"
    >
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-[22px] text-ink leading-tight" data-testid="valuation-heading">
            Company valuation
          </h2>
          <p className="text-[13px] text-ink-soft mt-1">
            Industry-aware peer multiples. For operating businesses the EBITDA × multiple is the
            headline; EV/Revenue is the cross-check. Asset-heavy industries use NAV instead.
          </p>
        </div>
        {hasUserOverrides && (
          <button
            data-testid="valuation-reset"
            onClick={handleReset}
            disabled={saving}
            className="text-[12px] text-ink-soft hover:text-ink inline-flex items-center gap-1.5"
          >
            <RotateCcw size={12} strokeWidth={2} />
            Reset to defaults
          </button>
        )}
      </div>

      {/* ── METHOD WARNINGS (industry routing, methodology demotion) ────── */}
      {valuation.method_warnings && valuation.method_warnings.length > 0 && (
        <div
          data-testid="valuation-method-warnings"
          className="rounded-xl border border-info/40 bg-info-tint/40 px-4 py-3 text-[13px] text-ink leading-relaxed"
        >
          {valuation.method_warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2">
              <Info size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-info" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── PRIMARY CARD ───────────────────────────────────────────────── */}
      <div
        data-testid="valuation-primary"
        className="rounded-2xl border-2 border-brand/40 bg-brand-tint/30 p-6"
      >
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
              Primary method · {(valuation.primary_label ?? (valuation.primary_method === "asset_based"
                ? "Net asset value (book equity + RE markup)"
                : "EV / EBITDA (peer multiple)"))}
            </div>
            <div className="font-serif text-[36px] text-ink leading-tight mt-1" data-testid="valuation-equity-p50">
              {fmtMoney(
                valuation.primary_method === "asset_based"
                  ? (valuation.primary_equity_value ?? null)
                  : livePreviewEquity,
                currency,
              )}
            </div>
            <div className="text-[12.5px] text-ink-soft mt-1" data-testid="valuation-equity-range">
              Range:{" "}
              <span className="tabular-nums">
                {fmtMoney(
                  valuation.primary_method === "asset_based"
                    ? (valuation.primary_equity_low ?? null)
                    : valuation.primary.equity_p25,
                  currency,
                )}
              </span>{" "}
              –{" "}
              <span className="tabular-nums">
                {fmtMoney(
                  valuation.primary_method === "asset_based"
                    ? (valuation.primary_equity_high ?? null)
                    : valuation.primary.equity_p75,
                  currency,
                )}
              </span>
              <span className="text-ink-mute">
                {valuation.primary_method === "asset_based"
                  ? " (book to 1.5× book markup band)"
                  : " (P25 – P75 peer band)"}
              </span>
            </div>
          </div>
          <div className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium ${conf.text}`}>
            <span className={`h-2 w-2 rounded-full ${conf.dot}`} />
            {conf.label}
          </div>
        </div>

        {/* Formula line — visible so the user can audit the math */}
        <div
          data-testid="valuation-formula"
          className="mt-5 rounded-lg bg-bg/60 border border-rule px-4 py-3 font-mono text-[12.5px] text-ink-soft"
        >
          Equity = EBITDA ({fmtMoney(ebitda, currency)}) × Multiple ({fmtMultiple(multiple)})
          − Debt ({fmtMoney(debt, currency)}) + Cash ({fmtMoney(cash, currency)})
          {" = "}
          <span className="text-ink font-semibold">{fmtMoney(livePreviewEquity, currency)}</span>
        </div>

        {/* Interactive inputs */}
        <div className="mt-5 grid grid-cols-1 md:grid-cols-4 gap-4">
          <EditablePill
            testId="valuation-input-ebitda"
            label="EBITDA"
            currency={currency}
            value={ebitda}
            onCommit={(v) => { setEbitda(v); void persist({ ebitda: v }); }}
          />
          <div className="md:col-span-2">
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
              Multiple · {fmtMultiple(minMultiple)} – {fmtMultiple(maxMultiple)}
            </div>
            <div className="mt-1 flex items-center gap-3">
              <input
                data-testid="valuation-input-multiple"
                type="range"
                min={Math.max(minMultiple - 1, 0.5)}
                max={maxMultiple + 1}
                step={0.1}
                value={multiple}
                onChange={(e) => setMultiple(Number(e.target.value))}
                className="flex-1 accent-brand"
              />
              <div className="font-serif text-[18px] text-ink tabular-nums w-16 text-right">
                {fmtMultiple(multiple)}
              </div>
            </div>
            <div className="text-[11px] text-ink-mute mt-1">
              {valuation.multiples_source}
              {valuation.multiples_as_of_date ? ` · ${valuation.multiples_as_of_date}` : null}
            </div>
          </div>
          <EditablePill
            testId="valuation-input-debt"
            label="Total debt"
            currency={currency}
            value={debt}
            onCommit={(v) => { setDebt(v); void persist({ debt: v }); }}
          />
          <EditablePill
            testId="valuation-input-cash"
            label="Cash"
            currency={currency}
            value={cash}
            onCommit={(v) => { setCash(v); void persist({ cash: v }); }}
          />
        </div>
      </div>

      {/* ── FOOTBALL FIELD ───────────────────────────────────────────── */}
      {valuation.football_field.length > 0 && (
        <div data-testid="valuation-football-field" className="rounded-2xl border border-rule bg-surface p-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="font-serif text-[16px] text-ink">Valuation range across methods</h3>
              <p className="text-[12px] text-ink-soft">
                Each bar spans low → high for its method. Wider bars = more sensitivity. The primary method is highlighted.
              </p>
            </div>
            <Info size={14} strokeWidth={1.75} className="text-ink-mute" />
          </div>
          <div className="space-y-3">
            {valuation.football_field
              // Defense in depth: never render DCF on the public valuation
              // panel. Romanian-SME DCFs swing wildly with 5-year noisy
              // historicals + WACC estimates and aren't defensible to a CFO.
              // The backend already excludes it; this match-by-name catches
              // any future regression that re-adds it server-side.
              .filter((row) => !/dcf|wacc|gordon/i.test(row.method))
              .map((row) => (
                <FootballRow
                  key={row.method}
                  row={row}
                  lo={fieldRange.lo}
                  hi={fieldRange.hi}
                  currency={currency}
                  fieldPos={fieldPos}
                />
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

interface FootballRowProps {
  row: PeriodValuation["football_field"][number];
  lo: number;
  hi: number;
  currency: string;
  fieldPos: (x: number) => number;
}

function FootballRow({ row, currency, fieldPos }: FootballRowProps) {
  const fmtMoney = useFmtMoney();
  if (row.low === null || row.high === null) return null;
  const leftPct = fieldPos(row.low);
  const rightPct = fieldPos(row.high);
  const widthPct = Math.max(rightPct - leftPct, 1.5);
  const midPct = row.mid !== null ? fieldPos(row.mid) : null;
  const tone = row.primary
    ? "bg-brand text-paper"
    : "bg-bg-2 text-ink";

  return (
    <div data-testid="valuation-football-row" className="grid grid-cols-12 items-center gap-3">
      <div className="col-span-3 min-w-0">
        <div className={`text-[12.5px] font-medium ${row.primary ? "text-ink" : "text-ink-soft"}`}>
          {row.method}
          {row.primary && (
            <span className="ml-2 text-[9.5px] uppercase tracking-[0.12em] text-brand-d">Primary</span>
          )}
        </div>
        {row.subtitle && (
          <div className="text-[11px] text-ink-mute mt-0.5">{row.subtitle}</div>
        )}
      </div>
      <div className="col-span-7 relative h-6 rounded-md bg-bg-2/40">
        <div
          className={`absolute top-0 h-full rounded-md ${tone}`}
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        />
        {midPct !== null && (
          <div
            className="absolute top-[-2px] h-[28px] w-0.5 bg-ink"
            style={{ left: `${midPct}%` }}
          />
        )}
      </div>
      <div className="col-span-2 text-right text-[12px] tabular-nums text-ink-soft">
        {fmtMoney(row.low, currency)} – {fmtMoney(row.high, currency)}
      </div>
    </div>
  );
}

interface PillProps {
  label: string;
  currency: string;
  value: number;
  onCommit: (v: number) => void;
  testId: string;
}

function EditablePill({ label, currency, value, onCommit, testId }: PillProps) {
  const fmtMoney = useFmtMoney();
  const [draft, setDraft] = useState<string>(String(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
        {label}
      </div>
      <input
        data-testid={testId}
        type="number"
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setEditing(true); }}
        onBlur={() => {
          setEditing(false);
          const n = Number(draft);
          if (!Number.isNaN(n) && n !== value) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        }}
        className="mt-1 w-full h-10 rounded-lg border border-rule bg-bg px-3 text-[14px] text-ink tabular-nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
      <div className="text-[11px] text-ink-mute mt-1 tabular-nums">
        {fmtMoney(value, currency)}
      </div>
    </div>
  );
}
