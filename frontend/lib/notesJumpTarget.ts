// Where the dashboard's "N notes" pill (`notes-jump-pill`,
// FinancialStatements.tsx `NotesJumpPill`) scrolls to.
//
// The statement tabs render a `statement-notes-*` section; the OVERVIEW,
// where the pill is mounted, does not — it renders the recommendations
// section instead (`overview-recommendations`). The pill used to look only
// for the first, so on the Overview `querySelector` returned null and a
// click did nothing: a dead button on the live demo path. A statement-notes
// section still wins when one is on the page.
export function notesJumpTarget(root: ParentNode = document): Element | null {
  return (
    root.querySelector('[data-testid^="statement-notes-"]') ??
    root.querySelector('[data-testid="overview-recommendations"]')
  );
}
