// "Source files" — the row of uploaded-file tiles that sits under a surface's
// pills row, showing which files back what's on screen for the active month.
//
// Extracted from Products (2026-07-26), where it started life nested inside
// DatasetPills. It's a sibling of the pills rather than part of them because
// the surfaces that need it don't line up with the surfaces that have pills:
// the Dashboard has its own month pills and needs this independently, and
// Workspace needs it with no add-pill at all.
//
// Presentation notes worth keeping:
//   · Tiles are a FIXED width in a wrapping row, not grid tracks. A grid sized
//     each card to its column, so a handful of files rendered as very wide
//     cards around a small icon.
//   · Card chrome (border + fill) appears on HOVER only; at rest the tiles read
//     as a clean file strip.
//   · The filename truncates at rest and scrolls its overflow into view on
//     hover via the shared `.hover-marquee` utility (index.css) — names that
//     already fit never move.
//
// Data-agnostic on purpose: callers map their own rows (SKU datasets on
// Products, `documents` rows on Dashboard/Workspace) into SourceFileItem and
// supply the open handler, so this component never learns either schema.

import { useRef, useState, type ReactNode } from "react";

import { ArrowUp, Cloud, FileSpreadsheet, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface SourceFileItem {
  /** Stable key. */
  id: string;
  /** Filename shown on the tile — falls back to any human label the caller has. */
  filename: string;
  /** ISO timestamp; rendered as a short date. Omit when unknown (no date line). */
  uploadedAt?: string | null;
  /** Marks the file currently driving the surface. Only affects the hover tint,
   *  since the resting state is deliberately chrome-free. */
  isActive?: boolean;
  /** Open/preview this file. Callers resolve their own signed URL. */
  onOpen: () => void;
}

export function SourceFilesRow({
  files,
  heading,
  testid = "source-files",
  trailing,
  trailingHeading,
}: {
  files: SourceFileItem[];
  /** `null` renders no heading — for callers that supply their own section
   *  header above the tiles. Omitted → the translated "Source files". */
  heading?: string | null;
  testid?: string;
  /** Sits to the RIGHT of the tiles, on the same wrapping row — Products puts
   *  its upload dropzone here so "the files backing this month" and "add
   *  another" read as one strip. */
  trailing?: ReactNode;
  /** Label shown on the heading line, right-aligned above `trailing` — e.g.
   *  "Replace or add files" over Products' dropzone. */
  trailingHeading?: string;
}) {
  const { t, i18n } = useTranslation();
  const resolvedHeading = heading === undefined ? t("files.sourceFiles") : heading;
  const dateLocale = i18n.language?.startsWith("ro") ? "ro-RO" : "en-GB";
  // Nothing uploaded for this scope → render nothing at all. An empty heading
  // reads as a broken section; the surface's own upload affordance is the
  // thing that should be drawing the eye when there are no files. A `trailing`
  // slot IS such an affordance, so it keeps the row alive on its own.
  if (files.length === 0 && !trailing) return null;

  return (
    <div data-testid={testid}>
      {/* Heading only — the "· <month>" suffix was dropped (2026-07-26 per
          operator); the surface already says which month is open. */}
      {(resolvedHeading !== null || trailingHeading) && (
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-mute">
            {resolvedHeading}
          </div>
          {trailingHeading && (
            <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-mute">
              {trailingHeading}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-stretch gap-2">
        {files.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={f.onOpen}
            data-testid="source-file"
            aria-pressed={f.isActive}
            title={f.filename}
            className={`group flex-1 min-w-[116px] max-w-[50%] flex flex-col items-center justify-center text-center gap-1.5 rounded-lg border border-transparent bg-transparent px-2 py-3 transition-colors ${
              f.isActive
                ? "hover:border-brand/40 hover:bg-brand/[0.06]"
                : "hover:border-rule-strong hover:bg-bg-2/70"
            }`}
          >
            <FileSpreadsheet size={26} strokeWidth={1.5} className="text-ink-mute" />
            <div className="hover-marquee w-full text-[11.5px] font-medium text-ink">
              <span>{f.filename}</span>
            </div>
            {f.uploadedAt && (
              <div className="w-full text-[10.5px] text-ink-mute truncate">
                {new Date(f.uploadedAt).toLocaleDateString(dateLocale, { dateStyle: "medium", timeZone: "UTC" })}
              </div>
            )}
          </button>
        ))}
        {/* "or" between the existing files and the add affordance — they're
            alternatives, not a sequence (2026-07-26 per operator). */}
        {trailing && files.length > 0 && (
          <span className="self-center shrink-0 px-1 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-mute">
            {t("common.or")}
          </span>
        )}
        {trailing}
      </div>
    </div>
  );
}

/**
 * The file tiles' twin: same footprint, dashed and interactive. Click to
 * browse or drop a file straight on it. Lives here rather than in a page so
 * Products and the Dashboard can't drift apart — they differ only in which
 * extensions they accept and what happens to the chosen file.
 */
export function AddFileTile({
  accept,
  onFile,
  label,
  hint,
  title,
  testid = "source-files-add",
  variant = "tile",
}: {
  /** `accept` for the hidden input (e.g. ".xlsx,.xls,.csv"). */
  accept: string;
  /** Chosen or dropped file. The caller decides whether that means "upload
   *  now" (Products) or "stage it and confirm the month" (Dashboard). */
  onFile: (file: File) => void;
  label?: string;
  hint?: string;
  title?: string;
  testid?: string;
  /** "tile" matches a file card's footprint; "wide" stretches across the
   *  row's remaining width as a proper dropzone (Products, 2026-07-26). */
  variant?: "tile" | "wide";
}) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t("files.addFile");
  const resolvedHint = hint ?? t("files.dropOrBrowse");
  const resolvedTitle = title ?? t("files.addFileTitle");
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        data-testid={`${testid}-input`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          // Reset so re-picking the same file fires onChange again.
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        data-testid={testid}
        title={resolvedTitle}
        className={
          variant === "wide"
            ? `
              group relative flex-1 min-w-[240px] self-stretch overflow-hidden
              rounded-2xl border-2 border-dashed backdrop-blur-sm
              px-5 py-2
              flex flex-col items-center justify-center text-center
              transition-all duration-150
              ${drag
                ? "border-brand bg-brand/10 ring-2 ring-inset ring-brand/30 shadow-[0_0_0_4px_rgba(92,211,197,0.08)]"
                : "border-rule/80 bg-gradient-to-br from-bg-2/30 via-surface/60 to-surface/40 hover:border-rule-strong hover:from-bg-2/50"}
            `
            : `
              group flex w-[116px] shrink-0 flex-col items-center justify-center text-center gap-1.5
              rounded-lg border border-dashed px-2 py-3 transition-colors
              ${drag
                ? "border-brand bg-brand/[0.1]"
                : "border-rule-strong bg-transparent hover:border-brand/60 hover:bg-brand/[0.05]"}
            `
        }
      >
        {variant === "wide" ? (
          <>
            {/* Same composition as the empty-state dropzone: atmospheric
                glow, oversized upload mark pinned bottom-left and clipped by
                the card (opacity on the WRAPPER so overlapping strokes never
                stack), title + hint above it. */}
            <div aria-hidden className="pointer-events-none absolute -top-16 -right-10 h-40 w-40 rounded-full bg-brand/8 blur-3xl" />
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-16 -left-10 text-ink opacity-[0.08]"
            >
              <Cloud size={220} strokeWidth={1} />
              <ArrowUp
                size={80}
                strokeWidth={2.5}
                className="absolute left-1/2 top-[62%] -translate-x-1/2 -translate-y-1/2"
              />
            </div>
            <div className="relative flex items-center justify-center gap-4">
              <div className="text-left">
                <h3 className="text-[13.5px] font-semibold text-ink">
                  {drag ? t("files.dropToUpload") : resolvedLabel}
                </h3>
                <p className="text-[11.5px] text-ink-soft mt-0.5">{resolvedHint}</p>
              </div>
              {/* Import reads as the explicit action next to the drop copy —
                  it's a <span> because the whole zone is already a button. */}
              <span className="shrink-0 inline-flex items-center justify-center h-9 px-3.5 rounded-lg border border-brand/40 ask-ai-anim-fill [animation-duration:10s] text-ink text-[12.5px] font-medium group-hover:border-brand/60 transition-colors">
                {t("files.import")}
              </span>
            </div>
          </>
        ) : (
          <>
            <span className={`grid place-items-center h-[26px] w-[26px] shrink-0 rounded-full transition-colors ${
              drag ? "bg-brand text-bg" : "bg-brand/15 text-brand-d group-hover:bg-brand group-hover:text-bg"
            }`}>
              <Plus size={15} strokeWidth={2.5} />
            </span>
            <div className="w-full text-[11.5px] font-medium text-ink">{resolvedLabel}</div>
            <div className="w-full text-[10.5px] text-ink-mute truncate">{resolvedHint}</div>
          </>
        )}
      </button>
    </>
  );
}
