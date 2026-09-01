// THE ARTIFACTS — THE DISPATCHER. One entry point, eight bodies.
//
// A host hands this component a RAW model-authored spec and the evidence
// the facts gateway returned. Everything after that is mechanical:
//
//     guardArtifactSpec → refused?  render the refusal, draw nothing
//                       → accepted? resolve, render, cite, export
//
// THE REFUSAL IS A FIRST-CLASS RENDER, and that is the point of routing
// every artifact through here. A spec that names a fact the retrieval
// did not return is not "mostly fine with a missing bar" — it is a
// composition built on something that is not there, and the honest
// output is a card that says so. Half-drawing it would produce the one
// thing this whole lane exists to prevent: an authoritative-looking
// picture with an unsourced number in it.

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import "./artifactI18n";
import type { Finding } from "@/lib/findings";
import {
  ARTIFACT_EXPORT_VERSION,
  buildCsv,
  citationFor,
  csvBlob,
  exportFilename,
  requestArtifactExport,
  saveBlob,
  sheetFromTable,
  cellFrom,
  type ArtifactExportRequest,
  type ArtifactExportFormat,
} from "@/lib/artifactExport";

import { ArtifactCard, type ArtifactActions } from "./ArtifactCard";
import {
  guardArtifactSpec,
  type ArtifactSpec,
  type ChartSpec,
  type ComparisonSpec,
  type DocumentSpec,
  type FindingSpec,
  type ScenarioSpec,
  type SlideSpec,
  type SpreadsheetSpec,
  type TableSpec,
} from "./artifactSpec";
import { SCENARIO_REGISTRY } from "./artifactScenario";
import { figuresOf, type ResolvedFigure } from "./artifactResolve";
import { chartFrom, ChartArtifact } from "./ChartArtifact";
import { tableFrom, TableArtifact } from "./TableArtifact";
import { spreadsheetFrom, SpreadsheetArtifact } from "./SpreadsheetArtifact";
import { slideDeckFrom, SlideArtifact } from "./SlideArtifact";
import { DocumentArtifact, documentExportSections, documentFrom } from "./DocumentArtifact";
import { ScenarioArtifact, scenarioFrom } from "./ScenarioArtifact";
import { comparisonFrom, ComparisonArtifact } from "./ComparisonArtifact";
import { FindingArtifact, findingFrom } from "./FindingArtifact";
import {
  currentVersion,
  newHistory,
  type ArtifactHistory,
  type RefinePlan,
} from "./artifactRefine";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

export interface ArtifactProps {
  /** The model's spec, straight off the wire — parsed here, not before. */
  spec: unknown;
  evidence: CapsuleEvidence;
  /** Engine trust verdict, verbatim, for the citation footer. */
  trust?: string | null;
  /** The engine's own finding row, for a `finding` artifact. */
  finding?: Finding | null;
  onRetrieve?: (ask: string, plan: RefinePlan) => void;
  onPin?: (spec: ArtifactSpec) => void;
  pinned?: boolean;
}

/** What the host renders when the composition was refused. Carries the
 *  reason but never the figures — a refusal that showed the numbers it
 *  refused to trust would be the artifact with extra steps. */
export function ArtifactRefused() {
  const { t } = useTranslation();
  return (
    <section
      data-testid="artifact-refused"
      className="rounded-md border border-caution/40 bg-caution-tint px-4 py-3"
    >
      <h3 className="text-[13px] font-semibold text-caution">{t("artifact.refused.title")}</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
        {t("artifact.refused.body")}
      </p>
    </section>
  );
}

export function Artifact({
  spec: raw,
  evidence,
  trust = null,
  finding = null,
  onRetrieve,
  onPin,
  pinned,
}: ArtifactProps) {
  const guard = useMemo(
    () => guardArtifactSpec(raw, evidence, SCENARIO_REGISTRY),
    [raw, evidence],
  );

  const accepted = guard.ok ? (raw as ArtifactSpec) : null;
  const [history, setHistory] = useState<ArtifactHistory | null>(() =>
    accepted ? newHistory(accepted) : null,
  );
  const [exporting, setExporting] = useState(false);

  const spec = history ? currentVersion(history).spec : accepted;
  const refine = history ? currentVersion(history).refine : {};

  const built = useMemo(() => {
    if (!spec) return null;
    if (spec.kind === "chart") return { kind: "chart" as const, ...chartFrom(spec as ChartSpec, evidence, trust) };
    if (spec.kind === "table") return { kind: "table" as const, ...tableFrom(spec as TableSpec, evidence, trust) };
    if (spec.kind === "spreadsheet")
      return { kind: "spreadsheet" as const, ...spreadsheetFrom(spec as SpreadsheetSpec, evidence, trust) };
    if (spec.kind === "slide")
      return { kind: "slide" as const, ...slideDeckFrom(spec as SlideSpec, evidence, trust) };
    if (spec.kind === "comparison")
      return { kind: "comparison" as const, ...comparisonFrom(spec as ComparisonSpec, evidence, trust) };
    if (spec.kind === "document")
      return {
        kind: "document" as const,
        artifact: documentFrom(spec as DocumentSpec, evidence, trust),
        figures: [] as ResolvedFigure[],
      };
    if (spec.kind === "scenario")
      return {
        kind: "scenario" as const,
        artifact: scenarioFrom(spec as ScenarioSpec, evidence, trust),
        figures: [] as ResolvedFigure[],
      };
    return {
      kind: "finding" as const,
      artifact: findingFrom(spec as FindingSpec, evidence, trust),
      figures: [] as ResolvedFigure[],
    };
  }, [spec, evidence, trust]);

  const doExport = useCallback(
    async (format: ArtifactExportFormat) => {
      if (!spec || !built) return;
      const citation = citationFor(built.artifact.citation);
      const request: ArtifactExportRequest = {
        version: ARTIFACT_EXPORT_VERSION,
        format,
        title: spec.title,
        citation,
      };
      if (built.kind === "spreadsheet") {
        request.sheets = built.spreadsheet.sheets.map((s) =>
          sheetFromTable(s.table, s.name, s.liveTotals),
        );
      } else if (built.kind === "table") {
        request.sheets = [sheetFromTable(built.table, spec.title)];
      } else if (built.kind === "slide") {
        request.slides = built.deck.slides.map((slide) => ({
          heading: slide.heading,
          blocks: slide.blocks.map((block) => {
            if (block.block === "metrics") {
              return {
                block: "metrics",
                metrics: block.metrics.map((m) => ({ label: m.label, cell: cellFrom(m.figure) })),
              };
            }
            if (block.block === "table") {
              return {
                block: "table",
                columns: block.table.columns.map((c) => ({ label: c.label, role: c.role })),
                rows: sheetFromTable(block.table, slide.heading).rows,
              };
            }
            return { block: block.block, lines: block.lines };
          }),
        }));
      } else if (built.kind === "document") {
        request.sections = documentExportSections(spec as DocumentSpec, evidence);
      }

      // CSV never leaves the browser — it needs no engine, so it is the
      // one export that still works with the backend stopped.
      if (format === "csv") {
        const sheet = request.sheets?.[0];
        if (!sheet) return;
        saveBlob(
          csvBlob(buildCsv(sheet, citation, spec.title)),
          exportFilename(spec.title, citation, "csv"),
        );
        return;
      }

      setExporting(true);
      try {
        const blob = await requestArtifactExport(request);
        saveBlob(blob, exportFilename(spec.title, citation, format));
      } finally {
        setExporting(false);
      }
    },
    [spec, built, evidence],
  );

  if (!accepted || !spec || !built) return <ArtifactRefused />;

  const exportFormat: ArtifactExportFormat | null =
    built.kind === "spreadsheet" || built.kind === "table"
      ? "xlsx"
      : built.kind === "slide"
        ? "pptx"
        : built.kind === "document"
          ? "docx"
          : null;

  const actions: ArtifactActions = {
    exporting,
    pinned,
    onExport: exportFormat ? () => void doExport(exportFormat) : undefined,
    onPin: onPin ? () => onPin(spec) : undefined,
  };

  return (
    <ArtifactCard
      artifact={built.artifact}
      history={history ?? undefined}
      onHistoryChange={setHistory}
      onRetrieve={onRetrieve}
      actions={actions}
      figures={built.figures}
    >
      {built.kind === "chart" && <ChartArtifact chart={built.chart} />}
      {built.kind === "table" && <TableArtifact table={built.table} refine={refine} />}
      {built.kind === "spreadsheet" && <SpreadsheetArtifact spreadsheet={built.spreadsheet} />}
      {built.kind === "slide" && <SlideArtifact deck={built.deck} />}
      {built.kind === "comparison" && <ComparisonArtifact comparison={built.comparison} />}
      {built.kind === "document" && (
        <DocumentArtifact spec={spec as DocumentSpec} evidence={evidence} />
      )}
      {built.kind === "scenario" && (
        <ScenarioArtifact spec={spec as ScenarioSpec} evidence={evidence} />
      )}
      {built.kind === "finding" && (
        <FindingArtifact spec={spec as FindingSpec} evidence={evidence} finding={finding} />
      )}
    </ArtifactCard>
  );
}

/** Exported for the gate: every figure an accepted spec would render.
 *  Used to assert that a rendered artifact's figure count matches the
 *  spec's reference count — a census that finds nothing is a broken
 *  gate, so the gate needs a number to compare against. */
export function figureCensus(spec: ArtifactSpec, evidence: CapsuleEvidence): number {
  if (spec.kind === "chart") return figuresOf(chartFrom(spec, evidence).chart).length;
  if (spec.kind === "table") return figuresOf(tableFrom(spec, evidence).table).length;
  if (spec.kind === "spreadsheet") return spreadsheetFrom(spec, evidence).figures.length;
  if (spec.kind === "slide") return slideDeckFrom(spec, evidence).figures.length;
  if (spec.kind === "comparison") return figuresOf(comparisonFrom(spec, evidence).comparison).length;
  return 0;
}
