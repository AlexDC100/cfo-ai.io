// ARTIFACT EXPORT — the wire between a resolved artifact and a file.
//
// ── What crosses the wire, and what deliberately does not ────────────
//
// The export payload carries RESOLVED FIGURES — value, integer minor
// units, declared unit, currency, and the provenance the facts gateway
// attached. It does NOT carry the model's spec, and it does not carry
// prose for the builder to interpret. Two reasons, and the second is the
// one that matters:
//
//   1. The builder must not re-derive. A workbook that recomputed a
//      total from the cells it was handed would produce a second
//      authority for the same figure, and the day the two disagree the
//      file is the one the reader forwards to their bank.
//   2. A digit that reaches a cell must already have passed the parse.
//      By shipping resolved figures only, the export path inherits the
//      numeral law for free: there is no field in `ArtifactExportRequest`
//      that a model-authored number could travel in.
//
// ── Provenance survives the export ───────────────────────────────────
//
// Every money cell carries its source and snapshot, and the engine
// builder writes them as a CELL COMMENT. That is the whole point of
// building the workbook server-side rather than with the bundled
// SheetJS: a spreadsheet that leaves this product with the numbers but
// without their provenance is exactly the artifact this product exists
// to replace.
//
// ── CSV is local, on purpose ─────────────────────────────────────────
//
// CSV needs no engine and no library, so it is built here and works with
// the backend fully stopped — the same posture `chat-llm` established.
// It is also the honest fallback when the engine is unreachable: a CSV
// with the figures beats a spinner, and it says in its own header rows
// which period and snapshot it came from.

import type {
  ResolvedFigure,
  ResolvedRow,
  ResolvedTable,
  ArtifactCitation,
} from "@/components/cfo/canvas/artifacts/artifactResolve";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

export type ArtifactExportFormat = "xlsx" | "pptx" | "docx" | "csv";

// ══════════════════════════════════════════════════════════════════════
// WIRE SHAPES — mirrored one field at a time in _artifact_export.py
// ══════════════════════════════════════════════════════════════════════

export const ARTIFACT_EXPORT_VERSION = "ax1";

export interface ExportProvenance {
  source?: string;
  method?: string;
  snapshot?: string;
}

export interface ExportCell {
  /** Null is a TYPED ABSENCE — the builder writes the missing glyph,
   *  never a zero and never an empty cell that reads as zero in a SUM. */
  value: number | null;
  minor: number | null;
  unit: string | null;
  currency: string | null;
  fact: string | null;
  periodLabel: string | null;
  provenance: ExportProvenance | null;
}

export interface ExportRow {
  label: string;
  cells: ExportCell[];
  accounts: string[];
  /** Nested detail, flattened by the builder with an indent level. */
  depth: number;
}

export interface ExportSheet {
  name: string;
  columns: Array<{ label: string; role: string }>;
  rows: ExportRow[];
  totalRow: ExportRow | null;
  /** Ask the builder to write the total as a live SUM() over the rows
   *  above rather than a static value. The builder decides whether it
   *  CAN — a total over a non-contiguous or nested range is written
   *  static, and says so in the cell comment. */
  liveTotals: boolean;
}

export interface ExportCitation {
  periods: string[];
  snapshots: string[];
  sources: string[];
  currency: string | null;
  trust: string | null;
  incomplete: boolean;
}

export interface ExportSlide {
  heading: string;
  blocks: Array<{
    block: string;
    lines?: string[];
    metrics?: Array<{ label: string; cell: ExportCell }>;
    columns?: Array<{ label: string; role: string }>;
    rows?: ExportRow[];
  }>;
}

export interface ExportSection {
  heading: string;
  /** Already-resolved prose: placeholders replaced with NATIVE-currency
   *  renderings. A document that left the product with `{{money:x}}` in
   *  it would be worse than one with a number. */
  paragraphs: string[];
}

export interface ArtifactExportRequest {
  version: string;
  format: ArtifactExportFormat;
  title: string;
  citation: ExportCitation;
  sheets?: ExportSheet[];
  slides?: ExportSlide[];
  sections?: ExportSection[];
}

// ══════════════════════════════════════════════════════════════════════
// BUILDING THE PAYLOAD FROM RESOLVED ARTIFACTS
// ══════════════════════════════════════════════════════════════════════

export function cellFrom(figure: ResolvedFigure): ExportCell {
  if (!figure.present) {
    return {
      value: null,
      minor: null,
      unit: null,
      currency: null,
      fact: figure.fact,
      periodLabel: null,
      provenance: null,
    };
  }
  return {
    value: figure.value,
    minor: figure.minor,
    unit: figure.unit,
    currency: figure.currency,
    fact: figure.fact,
    periodLabel: figure.periodLabel,
    provenance: figure.provenance
      ? {
          source: figure.provenance.source,
          method: figure.provenance.method,
          snapshot: figure.provenance.snapshot,
        }
      : null,
  };
}

/** Flatten a resolved row tree. Children are emitted immediately after
 *  their parent with an incremented depth, which is how the workbook
 *  gets an outline and the CSV gets an indent — and why a SUM over "the
 *  rows above" has to know about nesting (see `liveTotals`). */
export function flattenRows(rows: readonly ResolvedRow[], depth = 0, out: ExportRow[] = []): ExportRow[] {
  for (const row of rows) {
    out.push({
      label: row.label,
      cells: row.cells.map((c) => cellFrom(c.figure)),
      accounts: row.accounts.slice(),
      depth,
    });
    if (row.children.length > 0) flattenRows(row.children, depth + 1, out);
  }
  return out;
}

export function sheetFromTable(
  table: ResolvedTable,
  name: string,
  liveTotals = true,
): ExportSheet {
  return {
    name,
    columns: table.columns.map((c) => ({ label: c.label, role: c.role })),
    rows: flattenRows(table.rows),
    totalRow: table.totalRow
      ? {
          label: table.totalRow.label,
          cells: table.totalRow.cells.map((c) => cellFrom(c.figure)),
          accounts: table.totalRow.accounts.slice(),
          depth: 0,
        }
      : null,
    liveTotals,
  };
}

export function citationFor(citation: ArtifactCitation): ExportCitation {
  return {
    periods: citation.periods.map((p) => p.label).filter(Boolean),
    snapshots: citation.snapshots.slice(),
    sources: citation.sources.slice(),
    currency: citation.currency,
    trust: citation.trust,
    incomplete: citation.incomplete,
  };
}

// ══════════════════════════════════════════════════════════════════════
// CSV — local, deterministic, engine-free
// ══════════════════════════════════════════════════════════════════════

/** RFC-4180 quoting. A label containing a comma, a quote or a newline is
 *  quoted and its quotes doubled; everything else is emitted bare. */
export function csvField(value: string): string {
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** The missing glyph, spelled once. An empty CSV cell reads as zero in
 *  every spreadsheet that opens it, which is the ABSENT-IS-NOT-ZERO law
 *  broken by omission. */
export const CSV_MISSING = "n/a";

/**
 * Build a CSV for one sheet, native units, with a provenance header.
 *
 * Deliberately NOT locale-formatted: a CSV is a machine handoff, so
 * numbers are emitted with a dot decimal and no grouping. The locale
 * rendering lives on screen and in the .xlsx, where a cell format can
 * carry it without destroying the value.
 */
export function buildCsv(sheet: ExportSheet, citation: ExportCitation, title: string): string {
  const lines: string[] = [];
  lines.push(csvField(title));
  if (citation.periods.length) lines.push(`${csvField("Period")},${csvField(citation.periods.join(" | "))}`);
  if (citation.snapshots.length) lines.push(`${csvField("Snapshot")},${csvField(citation.snapshots.join(" | "))}`);
  if (citation.sources.length) lines.push(`${csvField("Source")},${csvField(citation.sources.join(" | "))}`);
  if (citation.currency) lines.push(`${csvField("Currency")},${csvField(citation.currency)}`);
  if (citation.trust) lines.push(`${csvField("Trust")},${csvField(citation.trust)}`);
  if (citation.incomplete) lines.push(csvField("Partial — the retrieval reported a gap"));
  lines.push("");
  lines.push(sheet.columns.map((c) => csvField(c.label)).join(","));

  const emit = (row: ExportRow) => {
    const label = `${"  ".repeat(row.depth)}${row.label}`;
    const cells = row.cells.map((c) => (c.value === null ? CSV_MISSING : String(c.value)));
    lines.push([csvField(label), ...cells.map(csvField)].join(","));
  };
  for (const row of sheet.rows) emit(row);
  if (sheet.totalRow) emit(sheet.totalRow);
  return lines.join("\r\n");
}

// ══════════════════════════════════════════════════════════════════════
// THE CALL
// ══════════════════════════════════════════════════════════════════════

export class ArtifactExportError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ArtifactExportError";
    this.status = status;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const { getSupabase, currentOrgId } = await import("@/lib/supabase");
    const sb = getSupabase();
    if (!sb) return headers;
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data.session?.user?.id) {
      const orgId = await currentOrgId();
      if (orgId) headers["X-Org-Id"] = orgId;
    }
  } catch {
    /* supabase not loaded — proceed unauthenticated */
  }
  return headers;
}

/** POST the payload, get bytes back. Binary, so it bypasses `cfoApi`'s
 *  JSON `call()` wrapper rather than teaching that wrapper a second
 *  response shape. */
export async function requestArtifactExport(
  request: ArtifactExportRequest,
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch(`${API_URL}/api/artifacts/export`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* keep the status line */
    }
    throw new ArtifactExportError(detail, res.status);
  }
  return await res.blob();
}

/** Filename, deterministic and filesystem-safe. No clock — the period
 *  and the artifact title are what identify the file, and a timestamp
 *  would make two exports of the same artifact look like two artifacts. */
export function exportFilename(
  title: string,
  citation: ExportCitation,
  format: ArtifactExportFormat,
): string {
  const slug = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60);
  const base = slug(title) || "artifact";
  const period = citation.periods.length ? `_${slug(citation.periods.join("_"))}` : "";
  return `${base}${period}.${format}`;
}

/** Hand the blob to the browser. Kept here rather than in a component so
 *  the whole export path is testable without a DOM tree. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously races the click in
  // WebKit and produces a zero-byte download.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function csvBlob(text: string): Blob {
  // BOM so Excel opens UTF-8 correctly; without it Romanian diacritics
  // in account names arrive mojibaked on a default Windows install.
  return new Blob([`\uFEFF${text}`], { type: "text/csv;charset=utf-8" });
}
