// SCENARIOS — named lever sets, run through the ONE forecast engine.
//
// plan/2 B13 (minimal cut): "one engine" (plan_contract_v2 S4). This page used
// to compute its own what-if in the browser: `buildScenarioBaseline` +
// `applyCascade` from the `lib/scenarios` modules. That cascade held cost of sales flat
// under a revenue move (defect 0.1), let cash run below zero with no funding
// line (0.3), and labelled the top-line lever with another industry's word for
// every company (0.2). It is gone from this page. Nothing here is calculated
// in the browser.
//
// ── WHAT THE PAGE DOES ─────────────────────────────────────────────────
//
//   · POSTs the BASE plan to /api/forecast/{id}/recompute: the reader's lever
//     overrides and no shocks;
//   · POSTs the SELECTED TEMPLATE the same way: the same overrides, plus the
//     template's declared shock set (`lib/scenarioTemplates`), each shock in
//     the engine's own vocabulary. Cost of sales follows volume, other
//     operating income is held, cash is floored and the shortfall is drawn on
//     a priced funding line — all by the engine (R2, R3, S3);
//   · paints both served responses side by side through `lib/forecastFacts`
//     and <ProjectedAmount>. No delta column: the engine does not serve one in
//     this build, and a subtraction here would be a second model;
//   · reuses the Forecast page's lever rail for the free levers;
//   · on a 409/422 renders the ENGINE'S sentence as the refusal — never a
//     blank page, and never numbers held over from a different request.
//
// The horizon is the engine's: the page sends monthly_months and omits
// total_years (2.2), and learns the plan length from the served labels.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Lock, Sparkles } from "lucide-react";

import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { PageHeader as InstrumentPageHeader, Chip } from "@/components/instrument/Panel";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import { LeverRail, cellToWire } from "@/components/forecast/LeverRail";
import {
  ScenarioOutcome,
  type ColumnState,
  type OutcomeColumn,
} from "@/components/scenarios/ScenarioOutcome";
import { ScenarioTemplatePicker } from "@/components/scenarios/ScenarioTemplatePicker";
import { useActivePeriod } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { useActiveLocale } from "@/lib/locale";
import { cfoApi } from "@/lib/cfoApi";
import { readProjection, type LeverRef, type ProjectionView } from "@/lib/forecastFacts";
import {
  applyLeverEdit,
  buildRecomputeBody,
  planYearLabels,
  type LeverEdit,
} from "@/lib/forecastLevers";
import { readEngineRefusal } from "@/lib/forecastRefusal";
import {
  BASE_TEMPLATE_ID,
  SCENARIO_MONTHLY_MONTHS,
  SCENARIO_TEMPLATES,
  compileTemplate,
  scenarioRequestBody,
} from "@/lib/scenarioTemplates";

type Read = { view: ProjectionView } | { error: string } | null;

/** One served payload through the one reader. A payload that claims to be a
 *  projection and breaks its own contract is a producer defect and paints
 *  nothing, not half a projection. */
function read(data: unknown): Read {
  if (data === undefined || data === null) return null;
  try {
    const view = readProjection(data);
    return view ? { view } : { error: "the response is not a projection" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function columnState(
  query: { isError: boolean; error: unknown; isFetching: boolean },
  parsed: Read,
  refusedFallback: string,
): ColumnState {
  if (query.isError) {
    return {
      kind: "refused",
      sentence: readEngineRefusal(query.error)?.text ?? refusedFallback,
    };
  }
  if (parsed && "error" in parsed) return { kind: "contract", message: parsed.error };
  if (parsed && "view" in parsed) {
    return { kind: "ready", view: parsed.view, recomputing: query.isFetching };
  }
  return { kind: "loading" };
}

function ScenariosEngine({
  periodId,
  periodLabel,
}: {
  periodId: string;
  periodLabel: string | null;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const [templateId, setTemplateId] = useState<string>(BASE_TEMPLATE_ID);
  /** What the reader has typed into the lever rail; `committed` is what has
   *  been SENT (after the pack's own debounce). */
  const [edits, setEdits] = useState<readonly LeverEdit[]>([]);
  const [committed, setCommitted] = useState<readonly LeverEdit[]>([]);
  const editsKey = JSON.stringify(edits);
  const committedKey = JSON.stringify(committed);

  /** The last BASE plan the server produced for this book. It feeds the lever
   *  rail (its controls, never the comparison's numbers) and the driver keys a
   *  template's `pool_level.*` expands over. */
  const [lastGood, setLastGood] = useState<{ periodId: string; view: ProjectionView } | null>(
    null,
  );
  const held = lastGood && lastGood.periodId === periodId ? lastGood.view : null;
  const leversRef = useRef<readonly LeverRef[]>([]);
  const planYears = held ? planYearLabels(held.horizon, held.horizonAnnual).length : 0;

  const overrides = useMemo(
    () =>
      buildRecomputeBody(
        Math.max(planYears, 1),
        SCENARIO_MONTHLY_MONTHS,
        committed,
        leversRef.current,
      ).overrides,
    // committedKey carries the content of `committed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [committedKey, planYears],
  );

  const baseQuery = useQuery({
    queryKey: ["scenarios", periodId, BASE_TEMPLATE_ID, committedKey],
    queryFn: () => cfoApi.forecastRecompute(periodId, scenarioRequestBody(overrides, [])),
    // While a lever recompute is in flight the last BASE answer stays up with
    // "Recomputing…" beside it. On a refusal TanStack drops it: the column
    // then carries the engine's sentence and no number.
    //
    // SCOPED TO THIS PERIOD. TanStack hands `placeholderData` the observer's
    // last query WITH data — including a query of another period, and one
    // `queryClient.clear()` (the workspace switch) has already removed. An
    // unscoped `keepPreviousData` therefore painted the previous period's (or
    // the previous company's) projection under the new one while it loaded.
    placeholderData: (previous, previousQuery) =>
      previousQuery && previousQuery.queryKey[1] === periodId ? previous : undefined,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const baseRead = useMemo(() => read(baseQuery.data), [baseQuery.data]);
  const baseView = baseRead && "view" in baseRead ? baseRead.view : null;
  const baseIsPlaceholder = baseQuery.isPlaceholderData;

  useEffect(() => {
    // Only a view THIS request served becomes `lastGood`. A placeholder is an
    // earlier answer; stamping the current periodId onto it is how a previous
    // period's lever rail and label survived a switch (and how a refusal of
    // the new period failed to reach the page-level refusal state).
    if (!baseView || baseIsPlaceholder) return;
    leversRef.current = baseView.levers;
    setLastGood({ periodId, view: baseView });
  }, [baseView, baseIsPlaceholder, periodId]);

  const template =
    SCENARIO_TEMPLATES.find((tpl) => tpl.id === templateId) ?? SCENARIO_TEMPLATES[0];
  const isBase = template.id === BASE_TEMPLATE_ID;
  const servedKeys = useMemo(() => (held ? held.levers.map((l) => l.key) : null), [held]);
  const compiled = useMemo(
    () => (servedKeys ? compileTemplate(template, servedKeys) : null),
    [template, servedKeys],
  );
  const shocksKey = compiled && compiled.ok ? JSON.stringify(compiled.shocks) : "";

  const templateQuery = useQuery({
    queryKey: ["scenarios", periodId, template.id, committedKey, shocksKey],
    queryFn: () =>
      cfoApi.forecastRecompute(
        periodId,
        scenarioRequestBody(overrides, compiled && compiled.ok ? compiled.shocks : []),
      ),
    enabled: !isBase && !!compiled && compiled.ok,
    // Held over ONLY while the same template recomputes FOR THE SAME PERIOD.
    // Switching template never shows the previous template's figures under
    // the new one's name, and switching period never shows the previous
    // period's.
    placeholderData: (previous, previousQuery) =>
      previousQuery &&
      previousQuery.queryKey[1] === periodId &&
      previousQuery.queryKey[2] === template.id
        ? previous
        : undefined,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const templateRead = useMemo(() => read(templateQuery.data), [templateQuery.data]);

  /** THE DEBOUNCE IS THE PACK'S OWN (`client.debounce_ms`), read off the
   *  payload. A number typed here would be a cut-off written as prose. */
  const debounceMs = held?.client.debounceMs ?? 0;
  useEffect(() => {
    if (editsKey === committedKey) return undefined;
    const id = setTimeout(() => setCommitted(JSON.parse(editsKey)), debounceMs);
    return () => clearTimeout(id);
  }, [editsKey, committedKey, debounceMs]);

  // A period switch resets the edits, the held base plan and both query
  // observers by REMOUNTING this component (`key={period.id}` below), not by
  // an effect: an effect runs after the first render of the new period, which
  // has already painted with the old state.

  const refusedFallback = t("scenarios.refusal.fallback", "The engine did not return a projection.");
  const baseState = columnState(baseQuery, baseRead, refusedFallback);
  const templateName = t(`scenarios.template.${template.id}.name`);
  let templateState: ColumnState | null = null;
  if (!isBase) {
    if (compiled && !compiled.ok) {
      // A declared pattern this book serves no driver for. The page's own
      // refusal: applying the rest would be half a template under its name.
      templateState = {
        kind: "refused",
        sentence: t(
          "scenarios.refusal.noServedKeys",
          "this book serves no operating-cost pool, so the operating-cost shock of this template cannot be applied, and the template is not run in part",
        ),
      };
    } else if (!compiled) {
      templateState = baseQuery.isError
        ? { kind: "refused", sentence: baseState.kind === "refused" ? baseState.sentence : refusedFallback }
        : { kind: "loading" };
    } else {
      templateState = columnState(templateQuery, templateRead, refusedFallback);
    }
  }

  const columns: OutcomeColumn[] = [
    { id: "base", title: t("scenarios.template.base.name"), state: baseState },
    ...(templateState ? [{ id: "template" as const, title: templateName, state: templateState }] : []),
  ];

  const baseRefusal = baseQuery.isError ? readEngineRefusal(baseQuery.error) : null;
  const refusedLeverKey =
    baseRefusal && leversRef.current.some((l) => l.key === baseRefusal.field)
      ? baseRefusal.field
      : null;

  const onChange = (key: string, index: number, text: string) => {
    const lever = leversRef.current.find((l) => l.key === key);
    if (!lever) return;
    const length = lever.shape === "scalar" ? 1 : Math.max(planYears, 1);
    setEdits((prev) =>
      applyLeverEdit(prev, key, index, text === "" ? null : cellToWire(text, lever), length),
    );
  };
  const onReset = (key: string) => {
    // Reset DROPS the override; the engine re-derives the value on its own
    // ladder and re-states the tier it stands on.
    setEdits((prev) => prev.filter((e) => e.key !== key));
  };
  const onAdopt = (key: string, values: readonly string[]) => {
    setEdits((prev) =>
      [...prev.filter((e) => e.key !== key), { key, values: [...values] }].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    );
  };

  // The page-level refusal: the BASE plan could not be built, so there is no
  // projection to compare anything with. The engine's sentence, verbatim.
  const pageRefused = baseState.kind === "refused" && !held;

  return (
    <div className="max-w-[1560px] space-y-5 pb-16">
      <InstrumentPageHeader
        eyebrow={t("scenarios.eyebrow", "Analysis")}
        title={t("scenarios.title", "Scenario planning")}
        context={
          <>
            <span>
              {t(
                "scenarios.context",
                "What-if on the projection of {{period}}. Every figure is computed by the forecast engine.",
                { period: held?.basePeriodLabel ?? periodLabel ?? "—" },
              )}
            </span>
            <Chip tone="neutral" className="whitespace-nowrap">
              <Lock size={11} strokeWidth={2} aria-hidden />
              {t("scenarios.actualsLocked", "Actuals never change")}
            </Chip>
          </>
        }
      />

      {/* NOT DISMISSIBLE: every number below is a projection. */}
      <div
        data-testid="scenarios-banner"
        className="rounded-xl border border-amber/40 bg-amber/5 px-4 py-3 text-[13px] leading-snug text-ink"
      >
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          {t("scenarios.banner.eyebrow", "Every figure on this page is a projection")}
        </span>
        <p className="mt-1 text-ink-soft">
          {t(
            "scenarios.banner.body",
            "Each number is produced by the forecast engine from the closing position of {{period}} and the shocks and levers listed on this page. Nothing here changes your trial balance.",
            { period: held?.basePeriodLabel ?? periodLabel ?? "—" },
          )}
        </p>
      </div>

      <ScenarioTemplatePicker
        selectedId={template.id}
        servedDriverKeys={servedKeys}
        onSelect={setTemplateId}
      />

      {pageRefused ? (
        <div
          data-testid="scenarios-refusal"
          className="rounded-xl border border-rule bg-surface px-4 py-3 text-[13px] leading-snug"
        >
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {t("scenarios.refusal.title", "No projection")}
          </span>
          <p className="mt-1 text-ink-soft" data-testid="scenarios-refusal-detail">
            {baseState.kind === "refused" ? baseState.sentence : refusedFallback}
          </p>
        </div>
      ) : (
        <ScenarioOutcome columns={columns} locale={locale} />
      )}

      {held ? (
        <div className="space-y-2">
          <p className="px-1 text-[12px] leading-snug text-ink-soft">
            {t(
              "scenarios.levers.lead",
              "The levers below apply to every column: the base plan and the selected template both carry them.",
            )}
          </p>
          <LeverRail
            view={held}
            edits={edits}
            recomputing={baseQuery.isFetching || templateQuery.isFetching}
            error={baseRefusal?.text ?? null}
            refusedKey={refusedLeverKey}
            onChange={onChange}
            onReset={onReset}
            onAdopt={onAdopt}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function Scenarios() {
  useActivePeriodFallback();
  const period = useActivePeriod();
  const navigate = useNavigate();
  const { t } = useTranslation();

  if (!period.id) {
    return (
      <div className="max-w-[1560px] space-y-8">
        <PageHeader
          hero
          eyebrow={t("scenarios.empty.eyebrow", "Scenario planning")}
          title={t("scenarios.empty.title", "Stress-test your plan before it happens")}
          subtitle={t(
            "scenarios.empty.subtitle",
            "Scenarios run named sets of shocks through the forecast engine: sales volume, selling and purchase prices, operating costs and working-capital days. Upload or open a period to begin; your actuals are never changed.",
          )}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/dashboard")}
            data-testid="scenarios-empty-dashboard"
            className="inline-flex items-center gap-1.5 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 px-5 py-2.5 text-[13.5px] font-medium text-ink hover:border-brand/60 transition-colors"
          >
            {t("scenarios.empty.dashboard", "Go to dashboard")}
          </button>
          <button
            type="button"
            onClick={() => openAskCfoAi(t("scenarios.empty.askPrompt"))}
            data-testid="scenarios-empty-ask-cfo-ai"
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-rule bg-surface/70 backdrop-blur text-[13px] font-medium text-ink hover:bg-bg-2/60 hover:border-rule-strong transition-colors"
          >
            <Sparkles size={16} strokeWidth={2} className="text-brand-d" />
            {t("scenarios.empty.ask", "Ask CFO AI")}
          </button>
        </div>
      </div>
    );
  }

  // KEYED BY PERIOD. Everything this component holds — the last base plan the
  // server produced (which feeds the lever rail and the page-level refusal),
  // the reader's edits, the selected template and both query observers — is
  // an answer about ONE period. A new period (the ?period= stepper, or the
  // workspace switch, which also clears the query cache) mounts a fresh one,
  // so nothing from a different request is ever painted under the new label.
  return (
    <ScenariosEngine key={period.id} periodId={period.id} periodLabel={period.label ?? null} />
  );
}
