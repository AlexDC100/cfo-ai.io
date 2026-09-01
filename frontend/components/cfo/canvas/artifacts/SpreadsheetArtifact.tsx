// THE ARTIFACTS — 3/8 SPREADSHEET. A workbook, with the provenance.
//
// On screen this is a preview: the sheets rendered as tables so the
// reader can check the shape before downloading. The FILE is built by
// the engine (`src/engine/api/_artifact_export.py`), and the division is
// deliberate rather than incidental.
//
// The frontend bundles SheetJS. Building the workbook here would be one
// import and no round trip — and it would produce a file with the
// numbers and none of their provenance, because a cell comment carrying
// a source cell and a snapshot is exactly the thing a quick client-side
// writer does not do. A spreadsheet that leaves this product without its
// provenance is the artifact this product exists to replace, so the
// export goes where the comments can be written.
//
// LIVE FORMULAS, WHEN THEY ARE FAITHFUL. The builder writes the total as
// a real `=SUM(...)` — skipping nested detail rows so a parent and its
// children are never added together — but ONLY when that sum reproduces
// the total the engine served. When it does not, the SERVED figure is
// written static and the cell comment says why the formula was withheld.
// The alternative is a workbook whose total is the spreadsheet's opinion
// rather than the engine's, and that file is the one that gets forwarded
// to a bank.

import { useTranslation } from "react-i18next";

import "./artifactI18n";
import { artifactLabel } from "./artifactI18n";
import type { SpreadsheetSpec } from "./artifactSpec";
import {
  citationFrom,
  figuresOf,
  resolveTable,
  type ResolvedArtifact,
  type ResolvedFigure,
  type ResolvedTable,
} from "./artifactResolve";
import { TableArtifact } from "./TableArtifact";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

export interface ResolvedSpreadsheet {
  kind: "spreadsheet";
  sheets: Array<{ name: string; table: ResolvedTable; liveTotals: boolean }>;
}

export function SpreadsheetArtifact({ spreadsheet }: { spreadsheet: ResolvedSpreadsheet }) {
  const { t } = useTranslation();
  return (
    <div data-testid="artifact-spreadsheet" className="space-y-4">
      {spreadsheet.sheets.map((sheet, i) => (
        <div key={i} data-testid="artifact-spreadsheet-sheet">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
            {artifactLabel(t, sheet.name)}
          </div>
          <TableArtifact table={sheet.table} />
        </div>
      ))}
    </div>
  );
}

export function spreadsheetFrom(
  spec: SpreadsheetSpec,
  evidence: CapsuleEvidence,
  trust: string | null = null,
): { artifact: ResolvedArtifact; spreadsheet: ResolvedSpreadsheet; figures: ResolvedFigure[] } {
  const sheets = spec.sheets.map((sheet) => {
    const { table } = resolveTable(
      {
        version: spec.version,
        kind: "table",
        title: sheet.name,
        columns: sheet.columns,
        rows: sheet.rows,
        totalRow: sheet.totalRow,
      },
      evidence,
      trust,
    );
    return { name: sheet.name, table, liveTotals: sheet.liveTotals !== false };
  });
  const spreadsheet: ResolvedSpreadsheet = { kind: "spreadsheet", sheets };
  return {
    artifact: { spec, citation: citationFrom(evidence, trust), unresolved: [] },
    spreadsheet,
    figures: figuresOf(spreadsheet),
  };
}
