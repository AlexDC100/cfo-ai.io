// THE ARTIFACTS — 2/8 TABLE. Comparison and detail.
//
// The ledger conventions this table keeps, and why each is not a style
// choice:
//
//   MONO TABULAR NUMERALS, RIGHT-ALIGNED. Every figure goes through
//   `<Amount>`, which owns the face and the lining figures. Columns of
//   numbers are read by scanning the decimal point; a proportional face
//   makes that scan impossible and a mixed magnitude makes it a lie.
//   `<AmountGroup>` on the card gives the whole artifact one scale.
//
//   THE DOUBLE HAIRLINE UNDER A TOTAL. In a ledger it means "this line
//   is the sum of the lines above". Rendered as two rules rather than a
//   bold weight, because bold means emphasis and this means arithmetic.
//
//   EXPAND TO ACCOUNT LEVEL. A row that names accounts can open to show
//   them. The codes are the EVIDENCE's own (the spec guard refuses any
//   code the evidence never mentioned), so opening a row is reading
//   provenance, not reading a model's recollection of a chart of
//   accounts.
//
//   ABSENT IS NOT ZERO. A `null` cell renders the missing glyph. There
//   is no code path in this file that turns an unresolved fact into a
//   zero, which is why an incomplete table looks incomplete.
//
// Sorting reorders ROWS and never touches a cell, so it cannot change a
// figure — which is why it is applied here at render time from the
// refine state rather than by rewriting the spec.

import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";

import "./artifactI18n";
import { ArtifactFigure } from "./ArtifactFigure";
import { artifactLabel } from "./artifactI18n";
import type { TableSpec } from "./artifactSpec";
import {
  figuresOf,
  precisionDigits,
  resolveTable,
  type ResolvedCell,
  type ResolvedRow,
  type ResolvedTable,
} from "./artifactResolve";
import type { RefineState } from "./artifactRefine";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

function Cell({ cell, digits }: { cell: ResolvedCell; digits: number | undefined }) {
  const f = cell.figure;
  return (
    <ArtifactFigure
      figure={f}
      fractionDigits={digits}
      signed={cell.role === "delta"}
      // Semantic red is RESERVED. It appears on a delta that is negative
      // — a movement the reader has to notice — and nowhere else. A
      // negative level (accumulated losses, a credit balance) is not an
      // alert; it is a fact, and colouring it would spend the one signal
      // this palette has.
      className={cell.role === "delta" && f.present && f.value < 0 ? "text-alert" : "text-ink"}
    />
  );
}

function Row({
  row,
  depth,
  digits,
  colCount,
}: {
  row: ResolvedRow;
  depth: number;
  digits: number | undefined;
  colCount: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const expandable = row.accounts.length > 0 || row.children.length > 0;

  return (
    <Fragment>
      <tr data-testid="artifact-row" className="border-b border-rule-soft last:border-0">
        <th
          scope="row"
          className="py-1.5 pr-3 text-left text-[12px] font-normal text-ink-soft"
          style={{ paddingLeft: `${depth * 14}px` }}
        >
          {expandable ? (
            <button
              type="button"
              data-testid="artifact-row-expand"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-left hover:text-ink"
            >
              <span aria-hidden="true" className="text-ink-mute">
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </span>
              {artifactLabel(t, row.label)}
            </button>
          ) : (
            artifactLabel(t, row.label)
          )}
        </th>
        {row.cells.map((cell, i) => (
          <td key={i} className="py-1.5 pl-3 text-right align-baseline">
            <Cell cell={cell} digits={digits} />
          </td>
        ))}
      </tr>
      {open && row.accounts.length > 0 && (
        <tr data-testid="artifact-row-accounts">
          <td colSpan={colCount} className="pb-1.5 pl-6 pr-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-mute">
              {t("artifact.table.accounts")}&nbsp;
            </span>
            <span className="font-mono text-[11px] tabular-nums text-ink-soft">
              {row.accounts.join(" · ")}
            </span>
          </td>
        </tr>
      )}
      {open &&
        row.children.map((child, i) => (
          <Row key={i} row={child} depth={depth + 1} digits={digits} colCount={colCount} />
        ))}
    </Fragment>
  );
}

/** Comparator over the FIRST value column. Rows whose first cell is
 *  absent sort last in both directions — an absence has no magnitude,
 *  and giving it one (zero) would put it in the middle of the ranking
 *  as if it were a small number. */
function sortRows(rows: ResolvedRow[], order: "asc" | "desc" | "source"): ResolvedRow[] {
  if (order === "source") return rows;
  const keyed = rows.map((r, i) => {
    const first = r.cells[0];
    return { r, i, v: first && first.figure.present ? first.figure.value : null };
  });
  keyed.sort((a, b) => {
    if (a.v === null && b.v === null) return a.i - b.i;
    if (a.v === null) return 1;
    if (b.v === null) return -1;
    return order === "asc" ? a.v - b.v : b.v - a.v;
  });
  return keyed.map((k) => k.r);
}

export interface TableArtifactProps {
  table: ResolvedTable;
  refine?: RefineState;
}

export function TableArtifact({ table, refine }: TableArtifactProps) {
  const { t } = useTranslation();
  const digits = precisionDigits(table.precision);
  const order = refine?.sort?.order ?? "source";
  const rows = useMemo(() => sortRows(table.rows.slice(), order), [table.rows, order]);
  const colCount = table.columns.length;

  if (rows.length === 0) {
    return (
      <p data-testid="artifact-table-empty" className="py-4 text-[12px] text-ink-soft">
        {t("artifact.table.empty")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table
        data-testid="artifact-table"
        className="w-full min-w-[360px] border-collapse text-[12px]"
      >
        <thead>
          <tr className="border-b border-rule">
            {table.columns.map((c, i) => (
              <th
                key={i}
                scope="col"
                className={`py-1.5 font-mono text-[10px] font-normal uppercase tracking-[0.06em] text-ink-mute ${
                  c.role === "label" ? "pr-3 text-left" : "pl-3 text-right"
                }`}
              >
                {artifactLabel(t, c.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <Row key={i} row={row} depth={0} digits={digits} colCount={colCount} />
          ))}
        </tbody>
        {table.totalRow && (
          // The ledger double hairline: two rules, not a bold weight.
          // It means "sum of the above", which is arithmetic, not
          // emphasis.
          <tfoot
            data-testid="artifact-table-total"
            className="border-t border-double border-t-[3px] border-rule-strong"
          >
            <tr>
              <th scope="row" className="py-1.5 pr-3 text-left text-[12px] font-medium text-ink">
                {artifactLabel(t, table.totalRow.label) || t("artifact.table.total")}
              </th>
              {table.totalRow.cells.map((cell, i) => (
                <td key={i} className="py-1.5 pl-3 text-right align-baseline font-medium">
                  <Cell cell={cell} digits={digits} />
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export function tableFrom(spec: TableSpec, evidence: CapsuleEvidence, trust: string | null = null) {
  const { artifact, table } = resolveTable(spec, evidence, trust);
  return { artifact, table, figures: figuresOf(table) };
}
