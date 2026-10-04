// ComparisonSurface — the three pieces of comparison markup the dashboard
// renders, each over the ONE composition (lib/comparisonSurface.ts):
//
//   <ComparisonControlsBar>   which prior, which columns — in the sticky bar;
//   <ComparisonNotes>         the no-prior notice and the request's outcome,
//                             below the sticky bar;
//   <StatementComparison>     a statement view's comparison provider.
//
// The page renders these and nothing else of the comparison; the gate
// (singleYearShare.test.tsx) renders these very components, so a condition
// changed here is a condition the laws exercise. Nothing is computed.
import type { ReactNode } from "react";

import { ComparativeProvider } from "@/components/cfo/ComparativeCells";
import {
  ComparativesControls,
  ComparativesNoPriorNote,
  ComparisonOutcomeNote,
} from "@/components/cfo/ComparativesPanel";
import { statementComparisonOf, type ComparisonSurface, type StatementTab } from "@/lib/comparisonSurface";

/** The controls. On every comparison tab with a period loaded — the picker
 *  when the company has another period, the column boxes the tab can use
 *  (`ComparativesControls` renders nothing when it has neither). */
export function ComparisonControlsBar({ surface }: { surface: ComparisonSurface }) {
  if (!surface.controlsShown || !surface.statements) return null;
  return (
    <ComparativesControls
      periods={surface.periods}
      currentId={surface.currentId}
      currentEnd={surface.currentEnd}
      autoPick={surface.autoPick}
      priorId={surface.priorId}
      currency={surface.statements.currency}
      columns={surface.tab !== "overview"}
      share={surface.shareOffer}
      outcome={surface.outcome}
      priorIsEarlier={surface.priorIsEarlier}
    />
  );
}

/** The sentence for a comparison that is on and compares nothing, and the
 *  comparison REQUEST's outcome (refused, failed with "try again", still on
 *  its way, or a comparison period that is the later one) — the two never
 *  show together: with no prior nothing was asked. */
export function ComparisonNotes({
  surface,
  uploadHref,
  onRetry,
  retrying = false,
}: {
  surface: ComparisonSurface;
  /** Where a balance is uploaded (the workspace). */
  uploadHref: string;
  /** Ask for the comparison again — the failed state's one action. */
  onRetry: () => void;
  retrying?: boolean;
}) {
  if (!surface.notesShown) return null;
  return (
    <>
      <ComparativesNoPriorNote
        periods={surface.periods}
        currentId={surface.currentId}
        currentEnd={surface.currentEnd}
        priorId={surface.priorId}
        uploadHref={uploadHref}
      />
      <ComparisonOutcomeNote
        note={surface.note}
        doc={surface.doc}
        onRetry={onRetry}
        retrying={retrying}
        verdicts={surface.verdictsOnTab}
      />
    </>
  );
}

/** One statement tab's comparison provider: the document, the reader's
 *  columns, and — where the tab's share column can be painted — the period's
 *  own share block (`statementComparisonOf`). */
export function StatementComparison({
  surface,
  statement,
  children,
}: {
  surface: ComparisonSurface;
  statement: StatementTab;
  children: ReactNode;
}) {
  const props = statementComparisonOf(surface, statement);
  return (
    <ComparativeProvider
      doc={props.doc}
      columns={props.columns}
      statement={props.statement}
      currency={surface.statements?.currency ?? "RON"}
      commonSize={props.commonSize}
    >
      {children}
    </ComparativeProvider>
  );
}
