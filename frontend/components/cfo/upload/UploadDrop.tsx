// UploadDrop — THE upload component. There is exactly one in the codebase.
//
// Workspace redesign (2026-09-21, owner spec): one upload button, three
// screens, and a file dropped ANYWHERE opens the same confirmation card. So
// every way a file enters the app lives in this module:
//
//   <UploadDrop variant="zone">    Home — the drop zone above the company cards
//   <UploadDrop variant="tile">    Company page — the dashed next-year tile
//   <UploadDropOverlay/>           AppShell — drag-and-drop on any page
//
// all three hand the file to lib/uploadFlow.startUploadFlow, which runs
// identify → confirmation card → commit.
//
// The two primitives underneath — <FilePickerInput> (the only
// `<input type="file">` in the product) and fileDropProps() (the only drag
// handlers) — are exported for the surfaces that still exist while the
// redesign ships behind its preview flag (the current dashboard, the old
// workspace page, Products' sales-file upload, the budget card, the chat
// composer's attach). They are rendered only with the flag OFF (or, for
// Products / budget / chat, carry their own non-financial files); with it ON,
// the three entries above are the only way in. Gate G5
// (components/cfo/upload/__tests__/oneUploadComponent.test.ts) reds on a file
// input or a drop handler anywhere else in frontend/.

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus, UploadCloud } from "lucide-react";

import { cn } from "@/lib/utils";
import { FINANCIAL_UPLOAD_ACCEPT } from "@/lib/uploadAccept";
import { uploadGuideView } from "@/lib/coverage";
import { startUploadFlow, useUploadFlow } from "@/lib/uploadFlow";

// ── Who else may use the primitives ────────────────────────────────────
//
// Every module outside this one that builds a file picker or a drop target
// from the primitives below, and why it may. Gate G5 reds on any other.
//
//   redesign_off  rendered only while `workspace_v2` is OFF for the viewer —
//                 the current dashboard's upload surfaces, the current
//                 workspace page and its periods list. They ARE the "other
//                 upload controls" the redesign deletes: none of them is
//                 mounted with the flag on, and these call sites go when the
//                 redesign is promoted.
//   other_kind    the file is not a company's financial document: a sales
//                 file for Products, a budget for Budget vs Actual, a chat
//                 attachment. The app-wide drop stands down over them.
export const UPLOAD_PRIMITIVE_CONSUMERS: Record<string, "redesign_off" | "other_kind"> = {
  "pages/cfo/FinancialStatements.tsx": "redesign_off",
  "pages/cfo/Workspace.tsx": "redesign_off",
  "components/cfo/workspace/PeriodsSection.tsx": "redesign_off",
  "pages/cfo/Products.tsx": "other_kind",
  "components/cfo/SourceFilesRow.tsx": "other_kind",
  "components/comparison/BudgetUploadCard.tsx": "other_kind",
  "components/cfo/chat/CFOComposer.tsx": "other_kind",
};

// ── Primitives ─────────────────────────────────────────────────────────

type PickerProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  /** The picked files (never empty). */
  onFiles?: (files: File[]) => void;
  /** Raw change event, for callers that also reset `value` themselves. */
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
};

/**
 * The hidden file input. The ref is the <input> itself, so `ref.current.click()`
 * opens the OS picker exactly as before. `value` is cleared after every pick,
 * so choosing the same file twice still fires.
 */
export const FilePickerInput = forwardRef<HTMLInputElement, PickerProps>(function FilePickerInput(
  { onFiles, onChange, className, ...rest },
  ref,
) {
  return (
    <input
      {...rest}
      ref={ref}
      type="file"
      className={className ?? "hidden"}
      onChange={(e) => {
        onChange?.(e);
        const files = e.target.files ? Array.from(e.target.files) : [];
        if (files.length > 0) onFiles?.(files);
        if (!onChange) e.target.value = "";
      }}
    />
  );
});

export interface FileDropOptions {
  onFiles: (files: File[]) => void;
  /** Drag-over highlight on/off. */
  onActiveChange?: (active: boolean) => void;
  disabled?: boolean;
}

/**
 * Drag handlers for a drop target. Spread them on the element:
 * `<div {...fileDropProps({ onFiles, onActiveChange })}>`. They call
 * preventDefault, which also tells the app-wide overlay a local target took
 * this drop (the overlay stands down for a prevented event).
 */
export function fileDropProps({ onFiles, onActiveChange, disabled }: FileDropOptions) {
  return {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (disabled) return;
      e.preventDefault();
      onActiveChange?.(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (disabled) return;
      e.preventDefault();
      onActiveChange?.(true);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (disabled) return;
      // Leaving for a CHILD of the target is not leaving the target.
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) return;
      onActiveChange?.(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (disabled) return;
      e.preventDefault();
      onActiveChange?.(false);
      const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
      if (files.length > 0) onFiles(files);
    },
  };
}

/** True when a drag carries files (not text or a link being dragged). */
function dragHasFiles(e: globalThis.DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes("Files");
}

// ── The component ──────────────────────────────────────────────────────

export interface UploadDropProps {
  variant: "zone" | "tile";
  /** The company on screen — a CUI-less document is routed to it. */
  onScreenOrgId: string | null;
  /** Tile only: the year the tile offers to add. */
  year?: number;
  className?: string;
  /** Optional line under the title (zone). */
  children?: ReactNode;
}

export function UploadDrop({ variant, onScreenOrgId, year, className, children }: UploadDropProps) {
  const { t, i18n } = useTranslation();
  // The formats named under the zone are coverage.json's — the tested ones,
  // and what a scan or a photo needs — never a list typed here ("PDF,
  // Excel, CSV or a photo" offered three things the table calls untested
  // or unavailable).
  const guide = uploadGuideView(i18n.language);
  const zoneHint =
    t("wsV2.drop.zoneHint", { formats: guide.testedFormats }) +
    (guide.aiReader ? `. ${t("wsV2.drop.zoneHintAi", { status: guide.aiReader })}` : "");
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  const flow = useUploadFlow();
  const reading = flow.phase === "identifying" || flow.phase === "committing";

  const take = (files: File[]) => void startUploadFlow(files, onScreenOrgId);
  const drop = fileDropProps({ onFiles: take, onActiveChange: setActive, disabled: reading });
  const open = () => {
    if (!reading) inputRef.current?.click();
  };

  if (variant === "tile") {
    // The input sits BESIDE the tile, not inside it: its programmatic
    // click() bubbles, and inside a clickable tile it would re-open itself.
    return (
      <>
      <FilePickerInput ref={inputRef} accept={FINANCIAL_UPLOAD_ACCEPT} onFiles={take} data-upload-component={variant} />
      <div
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        {...drop}
        data-testid="upload-drop-tile"
        data-upload-component="tile"
        aria-label={year ? t("wsV2.drop.nextYearHint", { year }) : t("wsV2.drop.zoneTitle")}
        className={cn(
          "group relative flex h-full min-h-[112px] w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-3 text-center outline-none transition-colors duration-micro focus-visible:ring-2 focus-visible:ring-ring",
          active ? "border-brand bg-brand-tint" : "border-rule-strong bg-transparent hover:border-brand/60 hover:bg-bg-2",
          reading && "opacity-60",
          className,
        )}
      >
        <span className="grid h-7 w-7 place-items-center rounded-full border border-rule text-ink-soft group-hover:text-ink">
          <Plus size={14} strokeWidth={2} aria-hidden />
        </span>
        <span className="text-[13px] font-medium text-ink tabular-nums">
          {year ? t("wsV2.drop.nextYear", { year }) : t("wsV2.drop.zoneTitle")}
        </span>
        <span className="text-[11px] leading-snug text-ink-mute">
          {year ? t("wsV2.drop.nextYearHint", { year }) : zoneHint}
        </span>
      </div>
      </>
    );
  }

  return (
    <div
      {...drop}
      data-testid="upload-drop-zone"
      data-upload-component="zone"
      className={cn(
        "rounded-md border border-dashed px-5 py-8 sm:py-10 flex flex-col items-center justify-center text-center transition-colors duration-micro",
        active ? "border-brand bg-brand-tint" : "border-rule-strong bg-bg-2/60",
        className,
      )}
    >
      <FilePickerInput ref={inputRef} accept={FINANCIAL_UPLOAD_ACCEPT} onFiles={take} data-upload-component={variant} />
      {reading ? (
        <div className="flex items-center gap-2 text-[13px] text-ink-soft" role="status">
          <Loader2 size={16} className="animate-spin text-brand-dark dark:text-brand-light" aria-hidden />
          {t("wsV2.drop.busy")}
        </div>
      ) : (
        <>
          <UploadCloud size={22} strokeWidth={1.5} className="mb-2 text-ink-soft" aria-hidden />
          <p className="text-[15px] font-semibold text-ink">{t("wsV2.drop.zoneTitle")}</p>
          <p className="mt-1 max-w-[46ch] text-[12.5px] text-ink-soft">{zoneHint}</p>
          {children}
          <button
            type="button"
            onClick={open}
            data-testid="upload-drop-choose"
            className="mt-4 inline-flex h-9 items-center justify-center rounded-sm bg-brand px-4 text-[13px] font-medium text-paper transition-colors duration-micro hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("wsV2.drop.choose")}
          </button>
        </>
      )}
    </div>
  );
}

// ── Drag-and-drop anywhere ─────────────────────────────────────────────

/**
 * App-wide drop: a file dragged over ANY page shows a quiet overlay, and
 * letting go opens the same confirmation card. Listens on window, after every
 * local target: a target that took the drop (preventDefault — the home zone,
 * a year tile, Products' sales-file zone) wins and the overlay stands down.
 */
export function UploadDropOverlay({ onScreenOrgId }: { onScreenOrgId: string | null }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const depth = useRef(0);
  const orgRef = useRef(onScreenOrgId);
  orgRef.current = onScreenOrgId;

  useEffect(() => {
    const onEnter = (e: globalThis.DragEvent) => {
      if (!dragHasFiles(e)) return;
      depth.current += 1;
      if (!e.defaultPrevented) setVisible(true);
    };
    const onOver = (e: globalThis.DragEvent) => {
      if (!dragHasFiles(e)) return;
      if (e.defaultPrevented) {
        // A local target is under the pointer — let it own the highlight.
        setVisible(false);
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setVisible(true);
    };
    const onLeave = (e: globalThis.DragEvent) => {
      if (!dragHasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setVisible(false);
    };
    const onDrop = (e: globalThis.DragEvent) => {
      depth.current = 0;
      setVisible(false);
      if (!dragHasFiles(e) || e.defaultPrevented) return;
      // Without this the browser opens the file in the tab.
      e.preventDefault();
      const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
      if (files.length > 0) void startUploadFlow(files, orgRef.current);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  if (!visible) return null;
  return (
    <div
      aria-hidden
      data-testid="upload-drop-overlay"
      data-upload-component="overlay"
      className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 backdrop-blur-[2px] p-4"
    >
      <div className="flex max-w-[420px] flex-col items-center rounded-md border border-dashed border-brand bg-surface px-8 py-10 text-center">
        <UploadCloud size={26} strokeWidth={1.5} className="mb-3 text-brand-dark dark:text-brand-light" />
        <p className="text-[16px] font-semibold text-ink">{t("wsV2.drop.overlayTitle")}</p>
        <p className="mt-1.5 text-[12.5px] text-ink-soft">{t("wsV2.drop.overlayHint")}</p>
      </div>
    </div>
  );
}
