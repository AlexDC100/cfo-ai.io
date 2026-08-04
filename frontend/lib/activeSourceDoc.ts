// pickActiveSourceDoc — the ONE definition of "the document backing the
// current analysis" for a period: the most recently analyzed non-SKU
// document. Shared by the Dashboard's source-credit line and the
// Workspace hub's "Activ" badge (2026-08-04 source-line fix) so the two
// surfaces can never disagree about which file the numbers came from.

export interface ActiveSourceCandidate {
  id: string;
  status?: string | null;
  scope?: string | null;
  /** Prefer updated_at (analysis completion) over created_at (upload). */
  updated_at?: string | null;
  created_at?: string | null;
  uploaded_at?: string | null;
}

export function pickActiveSourceDoc<T extends ActiveSourceCandidate>(
  docs: readonly T[] | null | undefined,
): T | null {
  const rows = docs ?? [];
  const stamp = (d: ActiveSourceCandidate) =>
    d.updated_at ?? d.uploaded_at ?? d.created_at ?? "";
  const analyzed = rows
    .filter((d) => d.status === "analyzed" && d.scope !== "sku")
    .sort((a, b) => stamp(b).localeCompare(stamp(a)));
  return analyzed[0] ?? rows.filter((d) => d.scope !== "sku")[0] ?? null;
}
