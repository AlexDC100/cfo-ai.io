// SCENARIOS — named templates, run by the ONE forecast engine, on the company
// on screen (forecast-scenarios-live).
//
// "One engine" (plan_contract_v2 S4; scenarios_rulings R6). This page used to
// compute its own what-if in the browser (a client cascade that held cost of
// sales flat under a revenue move, let cash run below zero with no funding
// line, and labelled the top-line lever with another industry's word). That
// cascade is DELETED, with every module under frontend/lib/scenarios/ and the
// old input store. Nothing on this page is calculated in the browser.
//
// ── WHAT THE PAGE DOES ─────────────────────────────────────────────────
//
//   · reads the engine's template catalogue (GET /api/forecast/templates/
//     scenarios: packs/scenarios/templates.yaml, FMCG Romania);
//   · POSTs the BASE plan to /api/forecast/{id}/scenario with template
//     "base" and the reader's lever overrides — the engine's
//     `project_levers`, the same function the forecast GET runs, so the base
//     column IS the forecast (gate F4);
//   · POSTs the SELECTED TEMPLATE the same way, by id: the ENGINE compiles its
//     shocks over this book (cost of sales follows volume, other operating
//     income is held, cash is floored and every shortfall is drawn on a
//     priced funding line whose interest is its own line — R2, R3, S3);
//   · paints both served responses side by side through `lib/forecastFacts`
//     and <ProjectedAmount>. No delta column: a subtraction here would be a
//     second model;
//   · saves the REQUEST (template id + levers) to the company on screen's own
//     prefs (org_prefs.prefs.scenarios), and re-runs it through the engine
//     when opened (gate F6);
//   · on a 409/422 renders the ENGINE'S sentence — never a blank page, and
//     never numbers held over from a different request.
//
// With no company open, or a company with no analysed year, it says so in one
// sentence and offers the user's companies. It carries no upload control.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import { PageHeader as InstrumentPageHeader, Chip } from "@/components/instrument/Panel";
import { CompanyCards } from "@/components/cfo/CompanyCards";
import { LeverRail, cellToWire } from "@/components/forecast/LeverRail";
import {
  ScenarioOutcome,
  type ColumnState,
  type OutcomeColumn,
} from "@/components/scenarios/ScenarioOutcome";
import { ScenarioTemplatePicker } from "@/components/scenarios/ScenarioTemplatePicker";
import { SavedScenarios } from "@/components/scenarios/SavedScenarios";
import { usePageCompany } from "@/lib/pageCompany";
import { useActiveLocale } from "@/lib/locale";
import { cfoApi } from "@/lib/cfoApi";
import { readProjection, type LeverRef, type ProjectionView } from "@/lib/forecastFacts";
import { applyLeverEdit, buildRecomputeBody, type LeverEdit } from "@/lib/forecastLevers";
import { readEngineRefusal } from "@/lib/forecastRefusal";
import { useServedText } from "@/lib/forecastSentences";
import {
  BASE_TEMPLATE_ID,
  SCENARIO_HORIZON,
  readCatalogue,
  scenarioRequestBody,
} from "@/lib/scenarioCatalogue";
import type { SavedScenario } from "@/lib/savedScenarios";

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

/** A saved scenario's overrides as lever edits (the rail's own shape). */
function editsOf(overrides: Record<string, { values: (string | null)[] }>): LeverEdit[] {
  return Object.keys(overrides)
    .sort()
    .map((key) => ({ key, values: [...overrides[key].values] }));
}

function ScenariosEngine({
  periodId,
  periodLabel,
  companyName,
  orgId,
}: {
  periodId: string;
  periodLabel: string | null;
  companyName: string | null;
  orgId: string | null;
}) {
  const { t } = useTranslation();
  const say = useServedText();
  const locale = useActiveLocale();
  const [templateId, setTemplateId] = useState<string>(BASE_TEMPLATE_ID);
  /** What the reader has typed into the lever rail; `committed` is what has
   *  been SENT (after the pack's own debounce). */
  const [edits, setEdits] = useState<readonly LeverEdit[]>([]);
  const [committed, setCommitted] = useState<readonly LeverEdit[]>([]);
  const editsKey = JSON.stringify(edits);
  const committedKey = JSON.stringify(committed);

  const catalogueQuery = useQuery({
    queryKey: ["scenario-templates"],
    queryFn: () => cfoApi.forecastScenarioTemplates(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const catalogue = useMemo(() => readCatalogue(catalogueQuery.data), [catalogueQuery.data]);
  const templates = catalogue?.templates ?? [];

  /** The last BASE plan the server produced for this book. It feeds the lever
   *  rail (its controls, never the comparison's numbers) and the pool count
   *  a template card names. */
  const [lastGood, setLastGood] = useState<{ periodId: string; view: ProjectionView } | null>(
    null,
  );
  const held = lastGood && lastGood.periodId === periodId ? lastGood.view : null;
  const leversRef = useRef<readonly LeverRef[]>([]);

  const overrides = useMemo(
    () =>
      buildRecomputeBody(
        SCENARIO_HORIZON.total_years,
        SCENARIO_HORIZON.monthly_months,
        committed,
        leversRef.current,
      ).overrides as Record<string, { values: (string | null)[] }>,
    // committedKey carries the content of `committed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [committedKey],
  );

  const baseQuery = useQuery({
    queryKey: ["scenarios", periodId, BASE_TEMPLATE_ID, committedKey],
    queryFn: () =>
      cfoApi.forecastScenario(periodId, scenarioRequestBody(BASE_TEMPLATE_ID, overrides)),
    // SCOPED TO THIS PERIOD. TanStack hands `placeholderData` the observer's
    // last query WITH data — including a query of another period, and one
    // `queryClient.clear()` (the workspace switch) has already removed.
    placeholderData: (previous, previousQuery) =>
      previousQuery && previousQuery.queryKey[1] === periodId ? previous : undefined,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const baseRead = useMemo(() => read(baseQuery.data), [baseQuery.data]);
  const baseView = baseRead && "view" in baseRead ? baseRead.view : null;
  const baseIsPlaceholder = baseQuery.isPlaceholderData;

  useEffect(() => {
    // Only a view THIS request served becomes `lastGood`: a placeholder is an
    // earlier answer, and stamping the current periodId onto it is how a
    // previous period's lever rail and label survived a switch.
    if (!baseView || baseIsPlaceholder) return;
    leversRef.current = baseView.levers;
    setLastGood({ periodId, view: baseView });
  }, [baseView, baseIsPlaceholder, periodId]);

  const isBase = templateId === BASE_TEMPLATE_ID;
  const servedKeys = useMemo(() => (held ? held.levers.map((l) => l.key) : null), [held]);

  const templateQuery = useQuery({
    queryKey: ["scenarios", periodId, templateId, committedKey],
    queryFn: () => cfoApi.forecastScenario(periodId, scenarioRequestBody(templateId, overrides)),
    enabled: !isBase,
    // Held over ONLY while the same template recomputes FOR THE SAME PERIOD.
    placeholderData: (previous, previousQuery) =>
      previousQuery &&
      previousQuery.queryKey[1] === periodId &&
      previousQuery.queryKey[2] === templateId
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

  const refusedFallback = t("scenarios.refusal.fallback", "The engine did not return a projection.");
  const baseState = columnState(baseQuery, baseRead, refusedFallback);
  const templateName = t(`scenarios.template.${templateId}.name`, templateId.replace(/_/g, " "));
  const templateState: ColumnState | null = isBase
    ? null
    : columnState(templateQuery, templateRead, refusedFallback);

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
    const length = lever.shape === "scalar" ? 1 : SCENARIO_HORIZON.total_years;
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
  const onOpenSaved = (saved: SavedScenario) => {
    // A saved scenario is a REQUEST: its template and its levers go back to
    // the engine as they were saved, sent at once (no debounce to wait out).
    const next = editsOf(saved.overrides);
    setTemplateId(saved.templateId);
    setEdits(next);
    setCommitted(next);
  };

  // The page-level refusal: the BASE plan could not be built, so there is no
  // projection to compare anything with. The engine's sentence, verbatim.
  const pageRefused = baseState.kind === "refused" && !held;
  const shownLabel = held?.basePeriodLabel ?? periodLabel ?? "—";

  return (
    <div className="max-w-[1560px] space-y-5 pb-16">
      <InstrumentPageHeader
        eyebrow={t("scenarios.eyebrow", "Analysis")}
        title={t("scenarios.title", "Scenario planning")}
        context={
          // Below `sm` the three items STACK, one full-width block each (the
          // walk of 2026-09-26 at 390 px squeezed them into columns narrower
          // than 200 px inside the header's non-wrapping row); from `sm` up
          // they read as one row. The chip keeps its own width inside a
          // block of its own.
          <div
            data-testid="scenarios-header-context"
            className="flex min-w-0 flex-col items-stretch gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2"
          >
            {companyName ? (
              <span data-testid="scenarios-company" className="font-medium text-ink">
                {companyName}
              </span>
            ) : null}
            <span data-testid="scenarios-context">
              {t(
                "scenarios.context",
                "What-if on the forecast of {{period}}. Every figure is computed by the forecast engine.",
                { period: shownLabel },
              )}
            </span>
            <div>
              <Chip tone="neutral" className="whitespace-nowrap" data-testid="scenarios-actuals-chip">
                <Lock size={11} strokeWidth={2} aria-hidden />
                {t("scenarios.actualsLocked", "Actuals never change")}
              </Chip>
            </div>
          </div>
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
            "Each number is produced by the forecast engine from the closing position of {{period}} and the template and levers on this page. The base column is the Forecast page's plan. Nothing here changes your trial balance.",
            { period: shownLabel },
          )}
        </p>
      </div>

      {catalogueQuery.isError || (catalogueQuery.isSuccess && !catalogue) ? (
        <p
          data-testid="scenarios-templates-unavailable"
          className="rounded-xl border border-rule bg-surface px-4 py-3 text-[13px] text-ink-soft"
        >
          {t(
            "scenarios.templates.unavailable",
            "The engine's templates could not be read, so only the base plan is shown.",
          )}
        </p>
      ) : (
        <ScenarioTemplatePicker
          templates={templates}
          selectedId={templateId}
          servedDriverKeys={servedKeys}
          onSelect={setTemplateId}
        />
      )}

      {/* Shown once the base plan is served: a saved scenario's levers are
          sized by the served levers' own shapes before they go back out. */}
      {orgId && held ? (
        <SavedScenarios
          orgId={orgId}
          periodId={periodId}
          periodLabel={held?.basePeriodLabel ?? periodLabel}
          templateId={templateId}
          templateName={templateName}
          overrides={overrides}
          onOpen={onOpenSaved}
        />
      ) : null}

      {pageRefused ? (
        <div
          data-testid="scenarios-refusal"
          className="rounded-xl border border-rule bg-surface px-4 py-3 text-[13px] leading-snug"
        >
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {t("scenarios.refusal.title", "No projection")}
          </span>
          <p className="mt-1 text-ink-soft" data-testid="scenarios-refusal-detail">
            {baseState.kind === "refused" ? say(baseState.sentence) : refusedFallback}
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
  const { t } = useTranslation();
  const onScreen = usePageCompany();
  const pageName = t("scenarios.pageName", "Scenarios");

  if (onScreen.status === "ready") {
    // KEYED BY PERIOD. Everything the engine view holds — the last base plan
    // the server produced, the reader's edits, the selected template and both
    // query observers — is an answer about ONE period of ONE company. A new
    // period (the ?period= stepper, or a workspace switch, which also clears
    // the query cache) mounts a fresh one.
    return (
      <ScenariosEngine
        key={onScreen.period.id}
        periodId={onScreen.period.id as string}
        periodLabel={onScreen.period.label ?? null}
        companyName={onScreen.company?.name ?? null}
        orgId={onScreen.company?.id ?? null}
      />
    );
  }
  return (
    <div className="max-w-[1560px] space-y-5 pb-16">
      <InstrumentPageHeader
        eyebrow={t("scenarios.eyebrow", "Analysis")}
        title={t("scenarios.title", "Scenario planning")}
        context={onScreen.company ? <span>{onScreen.company.name}</span> : undefined}
      />
      {onScreen.status === "loading" ? (
        <p className="px-1 text-[13px] text-ink-mute" data-testid="scenarios-loading">
          {t("scenarios.outcome.loading", "Projecting…")}
        </p>
      ) : (
        <CompanyCards reason={onScreen.status} pageName={pageName} />
      )}
    </div>
  );
}
