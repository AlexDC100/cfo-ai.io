// FORECAST — the cockpit (owner-approved spec, 2026-09-21).
//
// Apple-simple: four numbers, one chart, sliders. Tables are the appendix,
// never the first thing you see. Top to bottom:
//
//   1. the case switch — Bază · Optimist · Pesimist (the ENGINE's cases, each
//      with its sourced basis), then the reader's own saved cases (per
//      company, gate F6), and "save my case";
//   2. the four numbers a bank asks for — EBITDA in the final year with its
//      margin against today's, cumulative free cash flow, the lowest cash or
//      "Necesar de finanțare X · <lună>", and DSCR in year one against the
//      bank's threshold, coloured by the engine's verdict;
//   3. the engine's one plain-language sentence about the result;
//   4. one chart — EBITDA bars and the cash line over five years, the funding
//      gap shaded where cash would have gone below zero;
//   5. the bridge from the base case, when the case is not the base;
//   6. the sliders, each with its basis beneath, the rest behind "Mai multe";
//   7. collapsed below: the full projected P&L, balance sheet and cash flow,
//      year 0 beside them, the model's conventions and what it does not model.
//
// ── THE PAGE DOES NO MATH ───────────────────────────────────────────────
//
// Every number above is served by the engine that also produces the report
// the bank receives: every slider move is a debounced request to POST
// /api/forecast/{id}/cockpit (components/forecast/cockpit/useCockpit.ts —
// latest response wins), and the page paints the answer — the four numbers
// and the sentence arrive already formatted by the engine. A client-side
// cascade is the exact defect that broke Scenarios (a recession with cash at
// −107.6M). The opaque `CockpitMinor` (lib/forecastCockpit.ts) makes `a + b`
// over two served amounts a compile error, and cockpitNoMoneyMath.test.ts
// greps these sources for arithmetic on an amount.
//
// "Prezintă" opens the same served view full screen for a meeting (Esc
// exits); "Exportă pentru bancă" asks the engine for the export's data (POST
// .../cockpit/export) and renders it — with an assumptions page and the
// statements — through the CFO Report's PDF pipeline.
//
// With no company open, or a company with no analysed year, the page says so
// in one sentence and offers the user's companies. It carries no upload
// control: the company page owns uploads.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, Presentation } from "lucide-react";

import { PageHeader as InstrumentPageHeader } from "@/components/instrument/Panel";
import { CompanyCards } from "@/components/cfo/CompanyCards";
import { CaseBridge } from "@/components/forecast/cockpit/CaseBridge";
import { CaseSwitch, type ActiveCase } from "@/components/forecast/cockpit/CaseSwitch";
import { CockpitAppendix } from "@/components/forecast/cockpit/CockpitAppendix";
import { CockpitChart } from "@/components/forecast/cockpit/CockpitChart";
import { HeadlineNumbers } from "@/components/forecast/cockpit/HeadlineNumbers";
import { LeverSliders } from "@/components/forecast/cockpit/LeverSliders";
import { PresentMode } from "@/components/forecast/cockpit/PresentMode";
import { compactMoney, fullMoney } from "@/components/forecast/cockpit/format";
import { useCockpit } from "@/components/forecast/cockpit/useCockpit";
import { useToast } from "@/hooks/use-toast";
import type { ActivePeriod } from "@/lib/activePeriod";
import { cfoApi } from "@/lib/cfoApi";
import { usePageCompany } from "@/lib/pageCompany";
import { useActiveLocale } from "@/lib/locale";
import { useServedText } from "@/lib/forecastSentences";
import {
  BASE_CASE_ID,
  pick,
  SAVED_CASE_PREFIX,
  withLever,
  type CockpitLever,
  type CockpitRequest,
} from "@/lib/forecastCockpit";
import {
  deleteForecastCase,
  loadForecastCases,
  saveForecastCase,
  type SavedForecastCase,
} from "@/lib/forecastCases";
import { buildBankExportHtml } from "@/lib/forecastBankExport";
import { exactDecimal } from "@/lib/forecastFacts";
import { requestReportPdf, saveReportPdf } from "@/lib/reportPdf";

export default function Forecast() {
  const { t } = useTranslation();
  const onScreen = usePageCompany();
  const pageName = t("forecast.eyebrow", "Forecast");
  if (onScreen.status === "ready") {
    return (
      <ForecastCockpit
        key={onScreen.period.id}
        period={onScreen.period}
        companyName={onScreen.company?.name ?? null}
        orgId={onScreen.company?.id ?? null}
      />
    );
  }
  return (
    <div className="space-y-4 pb-16">
      <InstrumentPageHeader
        eyebrow={pageName}
        title={t("forecast.cockpit.title", "Five-year plan")}
        context={onScreen.company ? <span>{onScreen.company.name}</span> : undefined}
      />
      {onScreen.status === "loading" ? (
        <p className="px-1 text-[13px] text-ink-mute" data-testid="forecast-loading">
          {t("forecast.loading", "Projecting…")}
        </p>
      ) : (
        <CompanyCards reason={onScreen.status} pageName={pageName} />
      )}
    </div>
  );
}

function ForecastCockpit({
  period,
  companyName,
  orgId,
}: {
  period: ActivePeriod;
  companyName: string | null;
  orgId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const locale = useActiveLocale();
  const say = useServedText();
  const { toast } = useToast();
  const projectedLabel = t("forecast.projected", "projected");

  const [active, setActive] = useState<ActiveCase>({ kind: "engine", id: BASE_CASE_ID });
  const [request, setRequest] = useState<CockpitRequest>({ caseId: BASE_CASE_ID, levers: {} });
  // The served scale of every lever, read off the last answer in the same
  // render (no effect lag): the request carries a moved slider as an exact
  // decimal at its own scale.
  const scalesRef = useRef<ReadonlyMap<string, number>>(new Map());
  const scaleOf = useCallback((id: string) => scalesRef.current.get(id) ?? null, []);
  const state = useCockpit(period.id as string, request, scaleOf);
  const answer = state.shown;
  const cockpit = answer?.cockpit ?? null;
  const scales = useMemo(() => {
    const next = new Map(scalesRef.current);
    for (const l of cockpit?.levers ?? []) next.set(l.id, l.scale);
    return next;
  }, [cockpit]);
  scalesRef.current = scales;

  // ── saved cases (gate F6): this company's, and only this company's ──
  const [saved, setSaved] = useState<readonly SavedForecastCase[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSaved([]);
    if (!orgId) return undefined;
    loadForecastCases(orgId)
      .then((list) => {
        if (live) setSaved(list);
      })
      .catch(() => {
        if (live) setSaved([]);
      });
    return () => {
      live = false;
    };
  }, [orgId]);

  const onEngineCase = (id: string) => {
    setActive({ kind: "engine", id });
    setRequest({ caseId: id, levers: {} });
  };
  const onSavedCase = (c: SavedForecastCase) => {
    // The ENGINE reads the saved lever set from this company's own prefs row;
    // the page names it and sends no lever of its own.
    setActive({ kind: "saved", id: c.id });
    setRequest({ caseId: `${SAVED_CASE_PREFIX}${c.id}`, levers: {} });
  };
  const onMove = (lever: CockpitLever, ticks: number) => {
    setRequest((r) => ({ ...r, levers: withLever(r.levers, lever, ticks) }));
  };
  const onReset = (lever: CockpitLever) => {
    setRequest((r) => ({ ...r, levers: withLever(r.levers, lever, null) }));
  };
  const onResetAll = () => setRequest((r) => ({ ...r, levers: {} }));

  const onSave = async (name: string) => {
    if (!orgId || !cockpit) return;
    setSaving(true);
    setSaveError(null);
    try {
      // THE WHOLE LEVER SET the reader is looking at: what the case they
      // started from sets (the engine's own decimals — for a saved case, its
      // stored set), then every slider they moved on top.
      const set: Record<string, string | readonly string[]> = {};
      if (active.kind === "engine") {
        const served = cockpit.cases.find((c) => c.id === active.id);
        for (const [id, values] of Object.entries(served?.levers ?? {})) set[id] = values;
      } else {
        const own = saved.find((s) => s.id === active.id);
        for (const [id, values] of Object.entries(own?.levers ?? {})) set[id] = values;
      }
      for (const [id, ticks] of Object.entries(request.levers)) {
        const scale = scales.get(id);
        if (scale) set[id] = exactDecimal(ticks, scale);
      }
      const list = await saveForecastCase(orgId, {
        name,
        caseId: active.kind === "engine" ? active.id : (saved.find((s) => s.id === active.id)?.caseId ?? ""),
        levers: set,
        periodLabel: cockpit.basePeriodLabel || period.label || null,
      });
      setSaved(list);
      const mine = list[list.length - 1];
      if (mine) onSavedCase(mine);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const onDelete = async (c: SavedForecastCase) => {
    if (!orgId) return;
    try {
      const list = await deleteForecastCase(orgId, c.id);
      setSaved(list);
      if (active.kind === "saved" && active.id === c.id) onEngineCase(BASE_CASE_ID);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const caseName = useMemo(() => {
    if (active.kind === "saved") return saved.find((s) => s.id === active.id)?.name ?? "";
    const served = cockpit?.cases.find((c) => c.id === active.id);
    return served ? pick(served.label, lang) : cockpit ? pick(cockpit.caseLabel, lang) : "";
  }, [active, saved, cockpit, lang]);
  const caseBasis = useMemo(() => {
    if (!cockpit || active.kind !== "engine") return "";
    return pick(cockpit.cases.find((c) => c.id === active.id)?.basis, lang);
  }, [cockpit, active, lang]);

  const currency = cockpit?.currency ?? "RON";
  const compact = useMemo(() => compactMoney(currency, locale), [currency, locale]);
  const full = useMemo(() => fullMoney(currency, locale), [currency, locale]);

  // ── present mode and the bank export ──
  const [presenting, setPresenting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const closePresent = useCallback(() => setPresenting(false), []);
  const onExport = async () => {
    if (!answer) return;
    setExporting(true);
    try {
      // The export's DATA is the engine's, for the very request on screen.
      const payload = await cfoApi.forecastCockpitExport(period.id as string, answer.body);
      const html = buildBankExportHtml({
        payload,
        companyName: companyName ?? "",
        lang,
        locale,
        t,
        format: full,
      });
      const pdf = await requestReportPdf(html, {
        company: companyName ?? answer.cockpit.companyName ?? "",
        period: `${caseName} · ${answer.cockpit.basePeriodLabel}`,
      });
      saveReportPdf(pdf);
    } catch (err) {
      // THE SERVER'S OWN SENTENCE (a 401 or a 503 the reader can act on),
      // never a generic "export failed".
      toast({
        title: t("forecast.cockpit.export.failed", "The PDF could not be produced"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const dirty = Object.keys(request.levers).length > 0;
  const refusedId =
    state.refusal && cockpit?.levers.some((l) => l.id === state.refusal?.field)
      ? state.refusal.field
      : null;
  const showBridge = !!cockpit && (cockpit.caseId !== BASE_CASE_ID || cockpit.caseModified);
  const baseLabel = pick(cockpit?.cases.find((c) => c.id === BASE_CASE_ID)?.label, lang) || BASE_CASE_ID;

  if (presenting && cockpit && answer) {
    return (
      <PresentMode
        cockpit={cockpit}
        companyName={companyName ?? cockpit.companyName ?? ""}
        caseName={caseName}
        positions={request.levers}
        format={compact}
        locale={locale}
        lang={lang}
        projectedLabel={projectedLabel}
        answerKey={answer.key}
        exporting={exporting}
        onExport={() => void onExport()}
        onClose={closePresent}
      />
    );
  }

  return (
    <div
      className="space-y-5 pb-16"
      data-testid="forecast-cockpit"
      data-recomputing={state.recomputing ? "true" : "false"}
      data-round-trip-ms={answer ? String(answer.roundTripMs) : undefined}
      data-recompute-ms={cockpit?.recomputeMs ?? undefined}
    >
      <InstrumentPageHeader
        eyebrow={t("forecast.eyebrow", "Forecast")}
        title={t("forecast.cockpit.title", "Five-year plan")}
        context={companyName ? <span data-testid="forecast-company">{companyName}</span> : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="cockpit-export"
              disabled={!cockpit || exporting}
              onClick={() => void onExport()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rule px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-bg-2 disabled:opacity-50"
            >
              <FileDown size={14} strokeWidth={2} aria-hidden />
              {exporting
                ? t("forecast.cockpit.export.working", "Preparing the PDF…")
                : t("forecast.cockpit.export.button", "Export for the bank")}
            </button>
            <button
              type="button"
              data-testid="cockpit-present-open"
              data-primary-action="true"
              disabled={!cockpit}
              onClick={() => setPresenting(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-brand-d disabled:opacity-50"
            >
              <Presentation size={14} strokeWidth={2} aria-hidden />
              {t("forecast.cockpit.present.button", "Present")}
            </button>
          </div>
        }
      />

      {/* NOT DISMISSIBLE: every figure on this page is a projection, and the
          reader is told which actual year it stands on — the ENGINE's base
          period, the workspace's until it answers. */}
      <p
        data-testid="forecast-banner"
        className="rounded-lg border border-caution/40 bg-caution/5 px-3 py-2 text-[12.5px] leading-snug text-ink-soft"
      >
        <span className="font-medium text-ink">
          {t("forecast.banner.eyebrow", "Every figure on this page is a projection")}
        </span>
        {" · "}
        {t("forecast.cockpit.banner", "◇ marks a projected figure. The plan stands on the closing position of {{period}}.", {
          period: cockpit?.basePeriodLabel || period.label || "—",
        })}
      </p>

      {!answer && !state.refusal && !state.contractError ? (
        <p className="px-1 text-[13px] text-ink-mute" data-testid="forecast-loading">
          {t("forecast.loading", "Projecting…")}
        </p>
      ) : null}

      {!answer && state.refusal ? (
        <div
          data-testid="forecast-refusal"
          className="rounded-xl border border-rule bg-surface px-4 py-3 text-[13px] leading-snug"
        >
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {t("forecast.refused", "No projection")}
          </span>
          {/* THE ENGINE'S OWN SENTENCE, in the reader's language. */}
          <p className="mt-1 text-ink-soft" data-testid="forecast-refusal-detail">
            {say(state.refusal.text)}
          </p>
        </div>
      ) : null}

      {state.contractError ? (
        <div
          data-testid="forecast-contract-error"
          className="rounded-xl border border-alert/40 bg-alert/5 px-4 py-3 text-[13px] text-alert"
        >
          {state.contractError}
        </div>
      ) : null}

      {cockpit && answer ? (
        <>
          <div className="space-y-1.5">
            <CaseSwitch
              cases={cockpit.cases}
              saved={saved}
              active={active}
              lang={lang}
              canSave={!!orgId}
              dirty={dirty}
              saving={saving}
              saveError={saveError}
              onEngineCase={onEngineCase}
              onSavedCase={onSavedCase}
              onSave={(name) => void onSave(name)}
              onDelete={(c) => void onDelete(c)}
            />
            {caseBasis ? (
              <p data-testid="cockpit-case-basis" className="px-1 text-[12px] leading-snug text-ink-mute">
                {caseBasis}
              </p>
            ) : null}
          </div>

          {state.stale && state.refusal ? (
            <p
              data-testid="forecast-stale-notice"
              className="rounded-lg border border-alert/40 bg-alert/5 px-4 py-2 text-[12.5px] leading-snug text-ink"
            >
              <span data-testid="cockpit-refusal-sentence">{say(state.refusal.text)}</span>{" "}
              {t(
                "forecast.cockpit.stale",
                "Every figure below is still the last projection the engine produced; move the slider back or reset it.",
              )}
            </p>
          ) : null}

          <div
            className={`space-y-4 transition-opacity duration-overlay ${state.recomputing ? "opacity-80" : "opacity-100"}`}
          >
            <HeadlineNumbers cockpit={cockpit} lang={lang} projectedLabel={projectedLabel} answerKey={answer.key} />
            <p
              key={answer.key}
              data-testid="cockpit-sentence"
              className="cockpit-settle px-1 text-[15px] leading-snug text-ink sm:text-[16px]"
            >
              {pick(cockpit.sentence, lang)}
            </p>
            <CockpitChart
              bars={cockpit.chart.ebitda}
              cash={cockpit.chart.cash}
              format={compact}
              projectedLabel={projectedLabel}
              lang={lang}
              answerKey={answer.key}
            />
            {showBridge ? (
              <CaseBridge
                yearOne={cockpit.bridge.yearOne}
                horizon={cockpit.bridge.horizon}
                fromLabel={baseLabel}
                lang={lang}
                format={compact}
                projectedLabel={projectedLabel}
              />
            ) : null}
          </div>

          <LeverSliders
            levers={cockpit.levers}
            positions={request.levers}
            locale={locale}
            lang={lang}
            onMove={onMove}
            onReset={onReset}
            onResetAll={onResetAll}
            refusedId={refusedId}
          />

          <details data-testid="forecast-appendix-details" className="group rounded-xl border border-rule bg-surface">
            <summary className="cursor-pointer list-none px-4 py-3 text-[13px] font-medium text-ink-soft hover:text-ink">
              <span className="mr-1.5 inline-block transition-transform group-open:rotate-90" aria-hidden>
                ›
              </span>
              {t("forecast.cockpit.appendix", "Full projected statements — profit and loss, balance sheet, cash flow")}
            </summary>
            <div className="border-t border-rule px-3 py-4 sm:px-4">
              <CockpitAppendix
                cockpit={cockpit}
                period={period}
                locale={locale}
                lang={lang}
                format={full}
                projectedLabel={projectedLabel}
              />
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}
