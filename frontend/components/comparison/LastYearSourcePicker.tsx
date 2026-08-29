// F6.1b (2026-06-21) — "Last year" source picker.
//
// Lets the user choose what the variance report's Last-year column compares
// against, without re-typing numbers:
//   · a prior year already inside this analysis (multi-year periods / demo)
//   · another period they've uploaded (e.g. last year's trial balance — the
//     "upload last year's actuals as a period and diff it" flow)
//   · the Last-year column from the budget file (when present)
//   · nothing
//
// The chosen period's P&L is computed through the SAME canonical pipeline as
// the live Actual column and converted into the active currency, so the diff
// is apples-to-apples. A sensible default is auto-selected (most-recent prior
// period) so the report shows a real year-over-year out of the box.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Check, History, Loader2, CalendarClock } from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import {
  fetchPeriodFromApi,
  periodQueryKey,
  type PeriodLineItem,
  type PeriodMetric,
} from "@/lib/activePeriod";
import type { Statements } from "@/lib/financialReport";
import type { Rates } from "@/lib/rates";
import {
  actualLinesFor,
  convertLines,
  historicalCandidates,
  type LastYearCandidate,
  type LineMap,
} from "@/lib/comparison/comparePeriod";
import { cn } from "@/lib/utils";

export type LastYearSelection =
  | { kind: "period"; lines: LineMap; label: string }
  | { kind: "budget" }
  | { kind: "none" };

interface Props {
  statements: Statements;
  /** Active period currency (line values are reported in this currency). */
  activeCurrency: string;
  /** The active period's id, so it's excluded from the "other uploads" list. */
  activePeriodId: string | null;
  /** True when the uploaded budget file carries a Last-year column. */
  hasBudgetLastYear: boolean;
  rates: Rates;
  onChange: (sel: LastYearSelection) => void;
}

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

interface ListPeriod {
  period_id: string;
  period_label: string;
  period_end: string | null;
  currency: string | null;
  has_meaningful_data?: boolean;
  documents?: { detected_type?: string | null }[];
}
interface ListPayload {
  periods: ListPeriod[];
}

async function fetchPeriodsList(): Promise<ListPayload | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const r = await fetch(`${apiBase()}/api/org/periods-with-documents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return (await r.json()) as ListPayload;
}

const BUDGET = "__budget__";
const NONE = "__none__";

export function LastYearSourcePicker({
  statements,
  activeCurrency,
  activePeriodId,
  hasBudgetLastYear,
  rates,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string | null>(null); // null = not yet defaulted
  const [touched, setTouched] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // In-statement prior years (no network) — available immediately.
  const histCands = useMemo(() => historicalCandidates(statements), [statements]);

  // Other uploaded periods. Shares the DocumentSwitcher cache key.
  const { data: listData } = useQuery({
    queryKey: ["periods-with-documents"],
    queryFn: fetchPeriodsList,
    staleTime: 10_000,
  });

  const periodCands = useMemo<LastYearCandidate[]>(() => {
    const rows = (listData?.periods ?? []).filter(
      (p) => p.period_id !== activePeriodId && p.has_meaningful_data !== false,
    );
    // Newest first by raw period_end (nulls last) — robust vs sorting the
    // composed sublabel, where a null date would start with the currency code.
    rows.sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? ""));
    return rows.map((p) => ({
      id: p.period_id,
      label: p.period_label || (p.period_end ?? "Period"),
      sublabel: [p.period_end, p.currency || ""].filter(Boolean).join(" · "),
      kind: "period" as const,
      currency: p.currency || activeCurrency,
    }));
  }, [listData, activePeriodId, activeCurrency]);

  const allCands = useMemo(() => [...histCands, ...periodCands], [histCands, periodCands]);

  // Default selection. Respect an uploaded file's own Last-year column first
  // (the user chose to provide it); otherwise auto-pick the most-recent prior
  // period so year-over-year shows out of the box. Stays "live" while the
  // current value is still an empty default (null/NONE) so that backend
  // periods arriving AFTER first paint (deep-link to the page) still upgrade
  // the default — but never overrides a concrete pick or a user choice.
  useEffect(() => {
    if (touched) return;
    if (sel !== null && sel !== NONE) return; // already on a concrete source
    if (hasBudgetLastYear) setSel(BUDGET);
    else if (allCands.length) setSel(allCands[0].id);
    else setSel(NONE);
  }, [allCands, hasBudgetLastYear, touched, sel]);

  // A backend period selection is fetched lazily (cached if already viewed).
  const selectedBackendId =
    sel && sel !== BUDGET && sel !== NONE && !sel.startsWith("hist:") ? sel : null;
  const { data: fetched, isFetching } = useQuery({
    queryKey: selectedBackendId ? periodQueryKey(selectedBackendId) : ["period", "__lyp__"],
    queryFn: () => fetchPeriodFromApi(selectedBackendId!),
    enabled: !!selectedBackendId,
    staleTime: 5 * 60_000,
  });

  // Resolve the current selection into a concrete LastYearSelection.
  const resolved = useMemo<LastYearSelection>(() => {
    if (!sel || sel === NONE) return { kind: "none" };
    if (sel === BUDGET) return { kind: "budget" };
    if (sel.startsWith("hist:")) {
      const c = histCands.find((x) => x.id === sel);
      if (c?.lines) {
        return {
          kind: "period",
          lines: convertLines(c.lines, c.currency, activeCurrency, rates),
          label: c.label,
        };
      }
      return { kind: "none" };
    }
    // backend period
    if (fetched?.kind === "ok") {
      const d = fetched.data;
      const lines = actualLinesFor(
        d.statements,
        (d.line_items as PeriodLineItem[]) ?? [],
        (d.metrics as PeriodMetric[]) ?? [],
      );
      const c = periodCands.find((x) => x.id === sel);
      return {
        kind: "period",
        lines: convertLines(lines, d.statements.currency ?? activeCurrency, activeCurrency, rates),
        label: c?.label ?? "Selected period",
      };
    }
    return { kind: "none" }; // still fetching
  }, [sel, histCands, periodCands, fetched, activeCurrency, rates]);

  // Emit upward only when the resolved value actually changes (signature guard
  // avoids a render loop from the fresh object identity each render).
  const sig = JSON.stringify(resolved);
  const lastSig = useRef<string | null>(null);
  useEffect(() => {
    if (lastSig.current === sig) return;
    lastSig.current = sig;
    onChange(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Outside-click closes the menu.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(id: string) {
    setTouched(true);
    setSel(id);
    setOpen(false);
  }

  const triggerLabel =
    sel === BUDGET
      ? "Budget file column"
      : sel === NONE || !sel
        ? "Not comparing"
        : allCands.find((c) => c.id === sel)?.label ?? "Select a period";

  return (
    <div
      ref={containerRef}
      data-testid="last-year-source-picker"
      className="rounded-xl border border-rule bg-surface px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-ink">Compare against last year</div>
          <div className="mt-0.5 text-[11.5px] text-ink-soft">
            {allCands.length === 0 && !hasBudgetLastYear ? (
              <>Upload last year’s trial balance on the dashboard, then pick it here.</>
            ) : (
              <>Pick a prior year or a period you’ve uploaded — we compute its P&amp;L the same way.</>
            )}
          </div>
        </div>

        <div className="relative">
          <button
            type="button"
            data-testid="last-year-trigger"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-2 rounded-lg border border-rule bg-bg-2/40 hover:bg-bg-2 px-3 min-h-[40px] text-[12.5px] font-medium text-ink transition-colors"
          >
            {isFetching && selectedBackendId ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-soft" />
            ) : (
              <CalendarClock className="w-3.5 h-3.5 text-ink-soft" />
            )}
            <span className="truncate max-w-[180px]">{triggerLabel}</span>
            <ChevronDown className={cn("w-3.5 h-3.5 text-ink-soft transition-transform", open && "rotate-180")} />
          </button>

          {open && (
            <div
              role="menu"
              data-testid="last-year-menu"
              className="absolute right-0 z-40 mt-1 w-[280px] max-h-[340px] overflow-y-auto rounded-lg border border-rule bg-surface shadow-lg py-1"
            >
              {histCands.length > 0 && (
                <MenuGroup label="Prior years · this analysis">
                  {histCands.map((c) => (
                    <MenuRow
                      key={c.id}
                      icon={<History className="w-3.5 h-3.5" />}
                      title={c.label}
                      sub={c.sublabel}
                      active={sel === c.id}
                      onClick={() => pick(c.id)}
                      testId={`last-year-opt-${c.id}`}
                    />
                  ))}
                </MenuGroup>
              )}

              {periodCands.length > 0 && (
                <MenuGroup label="Other uploaded periods">
                  {periodCands.map((c) => (
                    <MenuRow
                      key={c.id}
                      icon={<CalendarClock className="w-3.5 h-3.5" />}
                      title={c.label}
                      sub={c.sublabel}
                      active={sel === c.id}
                      onClick={() => pick(c.id)}
                      testId={`last-year-opt-period`}
                    />
                  ))}
                </MenuGroup>
              )}

              <MenuGroup label="Other">
                {hasBudgetLastYear && (
                  <MenuRow
                    title="Budget file column"
                    sub="Use the “Last year” column from your upload"
                    active={sel === BUDGET}
                    onClick={() => pick(BUDGET)}
                    testId="last-year-opt-budget"
                  />
                )}
                <MenuRow
                  title="Don’t compare"
                  sub="Hide the Last-year column"
                  active={sel === NONE}
                  onClick={() => pick(NONE)}
                  testId="last-year-opt-none"
                />
              </MenuGroup>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-0.5">
      <div className="px-3 py-1 text-[9.5px] uppercase tracking-[0.12em] text-ink-soft font-semibold">
        {label}
      </div>
      {children}
    </div>
  );
}

function MenuRow({
  icon,
  title,
  sub,
  active,
  onClick,
  testId,
}: {
  icon?: React.ReactNode;
  title: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-bg-2/60 transition-colors min-h-[40px]",
        active && "bg-brand-tint/60",
      )}
    >
      <span className="mt-0.5 text-ink-soft shrink-0">
        {active ? <Check className="w-3.5 h-3.5 text-brand-dark dark:text-brand-light" /> : icon}
      </span>
      <span className="min-w-0">
        <span className={cn("block text-[12.5px] truncate", active ? "text-ink font-semibold" : "text-ink-soft")}>
          {title}
        </span>
        {sub && <span className="block text-[10.5px] text-ink-soft truncate">{sub}</span>}
      </span>
    </button>
  );
}
