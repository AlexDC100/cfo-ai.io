// PeriodsSection — the Workspace Settings "Perioade" card (2026-08-04 redesign,
// v3 the same day after operator feedback: filenames not counts, row click sets
// the active period, every row gets Edit/Delete via a kebab, corrupt dates
// quarantined, duplicates differentiated by their files).
//
// A vertical timeline of the workspace's periods, newest month first:
//
//   · Row = month-year label + status chip ("3 fișiere" / muted-amber
//     "Fără fișiere") + accent dot + "Activ" on the app-active period + a
//     kebab menu (Set active / Attach file / Rename / Delete). Files are
//     listed BY NAME under the label (≤3 lines, then "+N"); the doc that
//     pickActiveSourceDoc() resolves to carries an "Activ" badge once
//     analyzed. The only exposed per-row control is a subtle "Attach" link
//     on empty rows.
//   · ROW CLICK sets that period active (?period=<id>) — same mental model
//     as the rest of the app. Dropping a file on a row opens the CONFIRM
//     STEP (AttachConfirmDialog); only what the human confirms there is
//     uploaded, and only that becomes `periodEndHint`.
//   · Months sharing one calendar month render as a flat group: an
//     explanatory header, then sub-rows whose PRIMARY identity is their main
//     document's filename (the month lives in the header only).
//   · Rows with an implausible date (isImplausiblePeriod — misread Excel
//     serials etc.) are QUARANTINED into an amber "Needs attention" group at
//     the bottom. They never navigate, never show "Activ", never offer
//     attach; their kebab offers Rename (the actual fix) and Delete.
//   · Delete: WITH files → confirm dialog listing the files that go with it
//     (engine soft-delete path); EMPTY → instant, no modal, 5s undo toast
//     (undo re-creates the same month via createEmptyPeriod). Deleting the
//     active period auto-switches ?period= to the most recent remaining one.
//     The old "current month is permanent" / "keep one period" guards are
//     gone (2026-08-04 operator decision); note useEnsureCurrentPeriod
//     re-creates a current-month container app-wide.
//   · Rename = month-year picker (2000 → next year). Picking an occupied
//     month prompts a merge: this period's files move to the existing month
//     (documents.period_id update, same RLS path as every doc patch) and the
//     empty shell is deleted.
//
// Data mutations stay on existing code paths: createEmptyPeriod /
// updatePeriodEnd / deleteEmptyPeriod (direct RLS), cfoApi.deletePeriod
// (engine soft-delete), uploadDocument + enqueue for attach.
//
// ─── PERIOD-ASSIGNMENT FIX (2026-08-30) — why the confirm step exists ────
// `documents.period_end_hint` is a CONFIRMATION channel. The engine's
// stage_persist ranks it ABOVE its own (correct) detection, deliberately,
// because the hint is supposed to mean "a human confirmed that THIS
// document belongs to THIS month". This file used to fill it with the DROP
// TARGET's date — `periodEndHint: p.period_end` — a number read off a row,
// never off the document. So the engine discarded correct detections: the
// production audit found "Carniprod Trial Balance 2025.xlsx" stored under
// 2017-12 with hint=2017-12-31, and one month holding two different
// companies' books. Every mismatched row carried `hint == stored`, which is
// the signature of this bug.
//
// THE RULE NOW: no upload from this file may carry a periodEndHint that did
// not come back from AttachConfirmDialog's result. The drop target is an
// entry point, not evidence. Pinned by
// __tests__/attachConfirm.test.tsx ("only a confirmed month may become a
// hint"), which fails on the pre-fix shape.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import {
  CalendarDays,
  Check,
  FileSpreadsheet,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { periodQueryKey, useActivePeriod } from "@/lib/activePeriod";
import { pickActiveSourceDoc } from "@/lib/activeSourceDoc";
import { forgetPeriodVerdictFor } from "@/lib/dataPresence";
import { formatDateTime, useActiveLocale } from "@/lib/locale";
import {
  createEmptyPeriod,
  deleteEmptyPeriod,
  fetchWorkspacePeriodsDirect,
  formatPeriodMonth,
  formatPeriodMonthLoose,
  isImplausiblePeriod,
  updatePeriodEnd,
  type OrgPeriod,
  type OrgPeriodDocument,
  type OrgPeriodsPayload,
} from "@/lib/orgPeriods";
import { getSupabase } from "@/lib/supabase";
import { useUploadEnqueue } from "@/hooks/useUploadEnqueue";
import {
  AttachConfirmDialog,
  type AttachConfirmResult,
  type AttachContext,
  type AttachMode,
} from "./AttachConfirmDialog";
// ── PERIOD FILING — correction path + honest display (2026-08-30) ──────
// The confirm step above stops NEW uploads being misfiled. These pieces
// fix the rows already in the database, and make a wrong one visible in
// the first place:
//   · PeriodFileRow      per-file role (this period's SOURCE vs an
//                        ATTACHMENT, read from the engine's own pointer)
//                        + BOTH dates + the "Move to another period…" menu
//   · PeriodFilingChip   the engine's persisted verdict when a period's
//                        date disagrees with its document — read, never
//                        recomputed here
//   · MoveFileDialog     the correction itself, grounded in what the
//                        engine reads off the document
import { MoveFileDialog, type MoveTarget } from "./MoveFileDialog";
import { PeriodFileRow } from "./PeriodFileRow";
import {
  PeriodFilingChip,
  PeriodFilingReviewDialog,
  type ReviewTarget,
} from "./PeriodFilingReview";
import {
  resolveSourceDocumentId,
  usePeriodFiling,
  verdictAppliesTo,
} from "./periodFiling";
import "./wsSetI18n";

// ─── helpers ─────────────────────────────────────────────────────────────────

function monthKeyOf(p: OrgPeriod): string {
  return (p.period_end ?? "").slice(0, 7);
}

/** Trial-balance convention: a period's date is the LAST day of its month. */
function lastDayIso(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${monthKey}-${String(last).padStart(2, "0")}`;
}

/** The month the add dialog should offer: the most recent month (walking
 *  backwards from the current one) that this workspace doesn't have yet. */
function nextMissingMonth(taken: string[]): string {
  const set = new Set(taken);
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1;
  for (let i = 0; i < 48; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (!set.has(key)) return key;
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

interface MonthGroup {
  /** "YYYY-MM" */
  key: string;
  periods: OrgPeriod[];
}

/** A file waiting on the confirm step. Every route into an upload —
 *  drop, kebab attach, add-with-file, replace — becomes one of these, so
 *  there is exactly ONE place a periodEndHint can be born. */
interface ConfirmRequest {
  file: File;
  mode: AttachMode;
  context: AttachContext | null;
  replacing: OrgPeriodDocument | null;
}

const rowMotion = {
  layout: true,
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.18 },
} as const;

// ─── section ─────────────────────────────────────────────────────────────────

export function PeriodsSection({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const qc = useQueryClient();
  const activePeriod = useActivePeriod();
  const [urlParams, setUrlParams] = useSearchParams();
  const uploadEnqueue = useUploadEnqueue();

  const scoped = useQuery({
    queryKey: ["org-periods", orgId],
    queryFn: () => fetchWorkspacePeriodsDirect(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  const periods = useMemo(
    () =>
      (scoped.data?.periods ?? [])
        .slice()
        .sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? "")),
    [scoped.data],
  );

  // Valid months group by calendar month (list order stays newest-first);
  // implausible rows are QUARANTINED into a separate bottom sub-group —
  // their "month" is noise, so they never join the timeline.
  const { timeline, quarantine } = useMemo(() => {
    const timeline: MonthGroup[] = [];
    const quarantine: OrgPeriod[] = [];
    const byMonth = new Map<string, MonthGroup>();
    for (const p of periods) {
      if (isImplausiblePeriod(p.period_end)) {
        quarantine.push(p);
        continue;
      }
      const key = monthKeyOf(p);
      const existing = byMonth.get(key);
      if (existing) existing.periods.push(p);
      else {
        const g: MonthGroup = { key, periods: [p] };
        byMonth.set(key, g);
        timeline.push(g);
      }
    }
    return { timeline, quarantine };
  }, [periods]);

  const takenMonths = useMemo(
    () =>
      Array.from(
        new Set(periods.filter((p) => !isImplausiblePeriod(p.period_end)).map(monthKeyOf)),
      ).filter(Boolean),
    [periods],
  );

  const [addOpen, setAddOpen] = useState(false);
  /** Attach-mode target: an existing period getting a file. */
  const [attachTarget, setAttachTarget] = useState<OrgPeriod | null>(null);
  /** Confirm dialog target — only periods WITH files reach it. */
  const [deleteTarget, setDeleteTarget] = useState<OrgPeriod | null>(null);
  const [renameTarget, setRenameTarget] = useState<OrgPeriod | null>(null);
  /** Row currently hovered by a file drag — drop-target feedback. */
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [attachBusyId, setAttachBusyId] = useState<string | null>(null);
  /** The file waiting on the confirm step — the ONLY road to an upload. */
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  /** "Replace file" picks a file through this hidden input; the row + doc
   *  it was invoked from wait here until the picker resolves. */
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const replaceTargetRef = useRef<{ period: OrgPeriod; doc: OrgPeriodDocument } | null>(null);
  // ── period filing ──────────────────────────────────────────────────────
  /** The engine's own record per period: which file its numbers come from,
   *  and its verdict on the period's date. Absent for pre-2026-08-30 rows
   *  — the chip renders nothing there rather than an invented all-clear. */
  const filing = usePeriodFiling(orgId);
  const filingFor = (p: OrgPeriod) => filing.data?.[p.period_id];
  /** The file the user asked to re-file. */
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  /** The period whose date verdict the user opened. */
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);

  const label = (p: OrgPeriod) =>
    formatPeriodMonth(p.period_end, locale) ?? formatPeriodMonthLoose(p.period_end, locale) ?? p.period_label;
  const monthLabelOf = (monthKey: string) =>
    formatPeriodMonth(`${monthKey}-15`, locale) ?? monthKey;

  const refreshPeriodLists = () => {
    void qc.invalidateQueries({ queryKey: ["org-periods", orgId] });
    void qc.invalidateQueries({ queryKey: ["org-periods"] });
    void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
    void qc.invalidateQueries({ queryKey: ["workspace-docs", orgId] });
    // The filing facts (analysis source + the engine's date verdict) move
    // whenever a period does — a move rewrites both ends.
    void qc.invalidateQueries({ queryKey: ["period-filing", orgId] });
  };

  // ── set active (row click) — the app-wide `?period=` param ──────────────
  function setActive(p: OrgPeriod) {
    if (urlParams.get("period") === p.period_id) return;
    const next = new URLSearchParams(urlParams);
    next.set("period", p.period_id);
    setUrlParams(next);
  }

  // ── delete (existing data paths; guards removed 2026-08-04) ─────────────
  /** Optimistic cache drop + `?period=` auto-switch to the most recent
   *  remaining period. Returns a restore fn for the error path. */
  function dropFromCaches(target: OrgPeriod) {
    const dropPeriod = (payload: OrgPeriodsPayload | null | undefined) => {
      if (!payload) return payload;
      return {
        ...payload,
        active_period_id:
          payload.active_period_id === target.period_id ? null : payload.active_period_id,
        periods: payload.periods.filter((p) => p.period_id !== target.period_id),
      };
    };
    const scopedKey = ["org-periods", orgId];
    const activeKey = ["periods-with-documents"];
    const prevScoped = qc.getQueryData<OrgPeriodsPayload | null>(scopedKey);
    const prevActive = qc.getQueryData<OrgPeriodsPayload | null>(activeKey);
    qc.setQueryData<OrgPeriodsPayload | null>(scopedKey, dropPeriod);
    qc.setQueryData<OrgPeriodsPayload | null>(activeKey, dropPeriod);
    qc.removeQueries({ queryKey: ["period-documents", target.period_id] });
    forgetPeriodVerdictFor(target.period_id);

    // Move the app-wide `?period=` off the deleted row: most recent remaining
    // plausible period first, any remaining period second.
    if (urlParams.get("period") === target.period_id) {
      const rest = periods.filter((p) => p.period_id !== target.period_id);
      const successor =
        rest.find((p) => !isImplausiblePeriod(p.period_end)) ?? rest[0] ?? null;
      const nextParams = new URLSearchParams(urlParams);
      if (successor) nextParams.set("period", successor.period_id);
      else nextParams.delete("period");
      setUrlParams(nextParams, { replace: true });
    }

    return () => {
      if (prevScoped !== undefined) qc.setQueryData(scopedKey, prevScoped);
      if (prevActive !== undefined) qc.setQueryData(activeKey, prevActive);
    };
  }

  /** Empty period → instant delete, no modal, 5s undo toast. Undo re-creates
   *  the same month via the existing create path (new row id — that IS the
   *  undo for an empty container). */
  async function deleteEmptyNow(target: OrgPeriod) {
    const lbl = label(target);
    const restore = dropFromCaches(target);
    try {
      const errMsg = await deleteEmptyPeriod(target.period_id);
      if (errMsg) throw new Error(errMsg);
      refreshPeriodLists();
      const periodEnd = target.period_end;
      toast.success(t("ws.periodDeleted", { label: lbl }), {
        duration: 5000,
        action: periodEnd
          ? {
              label: t("wsSet.periods.undo"),
              onClick: () => {
                void createEmptyPeriod(orgId, periodEnd).then((res) => {
                  if ("error" in res) {
                    toast.error(t("ws.cantAddPeriod"), { description: res.error });
                  } else {
                    refreshPeriodLists();
                    toast.success(t("wsSet.periods.restored", { label: lbl }));
                  }
                });
              },
            }
          : undefined,
      });
    } catch (err) {
      restore();
      toast.error(t("ws.cantDeletePeriod"), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }

  /** Period WITH files → confirm dialog (files are listed there), then the
   *  engine soft-delete path. */
  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    const lbl = label(target);
    const restore = dropFromCaches(target);
    setDeleteTarget(null);
    try {
      const { cfoApi } = await import("@/lib/cfoApi");
      const res = await cfoApi.deletePeriod(target.period_id);
      toast.success(t("ws.periodDeleted", { label: lbl }), {
        description: res.documents_soft_deleted
          ? t("ws.filesMovedToDeleted", { count: res.documents_soft_deleted })
          : undefined,
      });
      refreshPeriodLists();
    } catch (err) {
      restore();
      toast.error(t("ws.cantDeletePeriod"), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }

  function requestDelete(p: OrgPeriod) {
    if ((p.documents?.length ?? 0) > 0) setDeleteTarget(p);
    else void deleteEmptyNow(p);
  }

  // ── rename / merge ───────────────────────────────────────────────────────
  async function performRename(p: OrgPeriod, monthKey: string): Promise<boolean> {
    const err = await updatePeriodEnd(p.period_id, lastDayIso(monthKey));
    if (err) {
      toast.error(t("wsSet.periods.cantRename"), { description: err });
      return false;
    }
    refreshPeriodLists();
    void qc.resetQueries({ queryKey: periodQueryKey(p.period_id) });
    toast.success(t("wsSet.periods.renamed", { month: monthLabelOf(monthKey) }));
    return true;
  }

  /** Renaming onto an occupied month: move this period's files to the
   *  existing period for that month (documents.period_id — the same direct
   *  RLS update every doc patch uses), then delete the empty shell. */
  async function performMerge(p: OrgPeriod, monthKey: string): Promise<boolean> {
    const target = periods.find(
      (x) =>
        x.period_id !== p.period_id &&
        !isImplausiblePeriod(x.period_end) &&
        monthKeyOf(x) === monthKey,
    );
    if (!target) return performRename(p, monthKey); // month freed meanwhile
    const sb = getSupabase();
    if (!sb) {
      toast.error(t("wsSet.periods.cantRename"));
      return false;
    }
    try {
      for (const d of p.documents ?? []) {
        const { error } = await sb
          .from("documents")
          .update({ period_id: target.period_id })
          .eq("id", d.id);
        if (error) throw new Error(error.message);
      }
      const errMsg = await deleteEmptyPeriod(p.period_id);
      if (errMsg) throw new Error(errMsg);
      if (urlParams.get("period") === p.period_id) {
        const nextParams = new URLSearchParams(urlParams);
        nextParams.set("period", target.period_id);
        setUrlParams(nextParams, { replace: true });
      }
      forgetPeriodVerdictFor(p.period_id);
      qc.removeQueries({ queryKey: ["period-documents", p.period_id] });
      refreshPeriodLists();
      void qc.resetQueries({ queryKey: periodQueryKey(target.period_id) });
      toast.success(t("wsSet.periods.merged", { month: monthLabelOf(monthKey) }));
      return true;
    } catch (err) {
      toast.error(t("wsSet.periods.cantRename"), {
        description: err instanceof Error ? err.message : undefined,
      });
      return false;
    }
  }

  // ── attach / replace — via the confirm step, never directly ─────────────

  /** Dropping a file on a row (or picking one from its kebab) no longer
   *  uploads anything. It opens the confirm step with the row as CONTEXT;
   *  the month comes from the document, and the human confirms it. */
  function requestAttach(p: OrgPeriod, file: File, reason: AttachContext["reason"]) {
    if (!p.period_end || isImplausiblePeriod(p.period_end)) return;
    setConfirmReq({
      file,
      mode: "attach",
      context: { periodId: p.period_id, periodEnd: p.period_end, reason },
      replacing: null,
    });
  }

  /** Kebab → "Replace file": open the OS picker, then the same confirm
   *  step with the replaced document shown. */
  function requestReplace(p: OrgPeriod) {
    const docs = p.documents ?? [];
    const doc = pickActiveSourceDoc(docs) ?? docs[0] ?? null;
    if (!doc) return;
    replaceTargetRef.current = { period: p, doc };
    replaceInputRef.current?.click();
  }

  /**
   * The ONE upload path. `result` came back from AttachConfirmDialog, so
   * `result.periodEnd` is a month a human confirmed against THIS
   * document's own evidence — the only thing `period_end_hint` is allowed
   * to carry. Passing a row's date here would re-introduce the bug this
   * whole part exists to fix.
   */
  async function runConfirmedAttach(req: ConfirmRequest, result: AttachConfirmResult) {
    const file = req.file;
    const lbl =
      formatPeriodMonth(result.periodEnd, locale) ??
      formatPeriodMonthLoose(result.periodEnd, locale) ??
      result.periodEnd;
    setAttachBusyId(result.periodId ?? req.context?.periodId ?? "pending");
    try {
      // A month with no period yet: create the container first, so the
      // hint below adopts that row instead of minting a sibling.
      if (!result.periodId) {
        const created = await createEmptyPeriod(orgId, result.periodEnd);
        if ("error" in created) throw new Error(created.error);
        refreshPeriodLists();
      }
      const { uploadDocument, subscribeToDocumentStatus } = await import("@/lib/supabase");
      const { row, error } = await uploadDocument(file, {
        scope: "financial",
        // ── THE FIX ──────────────────────────────────────────────────
        // Human-confirmed, document-derived. Never `p.period_end`.
        periodEndHint: result.periodEnd,
      });
      if (!row) throw new Error(error ?? t("errors.uploadFailed"));
      const enq = await uploadEnqueue.enqueue(row.id);
      if (enq.kind !== "queued") return;
      toast.success(t("ws.periodAddedAnalyzing", { label: lbl, file: file.name }));
      const unsub = subscribeToDocumentStatus(row.id, (next) => {
        if (next.status === "analyzed") {
          unsub();
          refreshPeriodLists();
          if (next.period_id) void qc.resetQueries({ queryKey: periodQueryKey(next.period_id) });
          toast.success(t("ws.periodReady", { label: lbl }));
        } else if (next.status === "failed") {
          unsub();
          refreshPeriodLists();
          toast.error(t("ws.cantAnalyzeFile"), { description: next.error ?? undefined });
        }
      });
      refreshPeriodLists();
    } catch (err) {
      toast.error(t("ws.cantAnalyzeFile"), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAttachBusyId(null);
    }
  }

  function dropHandlers(p: OrgPeriod) {
    if (isImplausiblePeriod(p.period_end)) return {};
    return {
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragOverId(p.period_id);
        }
      },
      onDragLeave: () =>
        setDragOverId((cur) => (cur === p.period_id ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDragOverId(null);
        const f = e.dataTransfer.files?.[0];
        if (f) requestAttach(p, f, "dropped");
      },
    };
  }

  // ── row pieces ───────────────────────────────────────────────────────────

  /** File list under a row — one PeriodFileRow per file (≤3, then "+N").
   *
   *  Each row states its ROLE and both of its dates, and carries the menu
   *  that re-files it. The role comes from the engine's declared
   *  `source_document_id`; `pickActiveSourceDoc` survives only as the
   *  fallback for periods written before that pointer was surfaced, and
   *  the badge is suppressed entirely in that case — a guess must not be
   *  dressed as a fact, which is precisely how one month ended up
   *  silently presenting two companies' books as one analysis.
   *
   *  Empty rows return the invitation to attach rather than nothing. */
  function renderFileList(p: OrgPeriod, opts: { noActive?: boolean } = {}) {
    const docs = p.documents ?? [];
    if (docs.length === 0) {
      if (opts.noActive) return null;
      return (
        <div
          data-testid={`pf-empty-${p.period_id}`}
          className="mt-1 text-[11px] text-ink-mute"
        >
          {t("pf.noFiles")}
        </div>
      );
    }
    const facts = filingFor(p);
    const heuristic = pickActiveSourceDoc(docs);
    const heuristicId = heuristic?.status === "analyzed" ? heuristic.id : null;
    const { id: sourceId, declared } = resolveSourceDocumentId(
      facts,
      docs.map((d) => d.id),
      heuristicId,
    );
    // Show roles only when there is a distinction to draw AND the engine
    // actually declared the source.
    const showRole = !opts.noActive && declared && docs.length > 1;
    const activeId = opts.noActive ? null : sourceId;
    // Source first so its badge is never hidden behind the "+N" overflow.
    const ordered = activeId
      ? [
          ...docs.filter((d) => d.id === activeId),
          ...docs.filter((d) => d.id !== activeId),
        ]
      : docs;
    const shown = ordered.slice(0, 3);
    const extra = ordered.length - shown.length;
    return (
      <div className="mt-1 space-y-0.5 min-w-0">
        {shown.map((d) => (
          <div key={d.id} data-testid={`wsset-period-file-${d.id}`}>
            <PeriodFileRow
              orgId={orgId}
              file={d}
              isSource={d.id === activeId}
              showRole={showRole}
              // The record describes the period's analysis source and
              // nothing else. Attaching it to a sibling would put words in
              // a document's mouth.
              detection={
                verdictAppliesTo(facts, d.id)
                  ? facts?.period_detection ?? null
                  : null
              }
              onMove={(file) =>
                setMoveTarget({
                  id: file.id,
                  name: file.filename ?? file.id,
                  currentMonth: (p.period_end ?? "").slice(0, 7) || null,
                })
              }
              onChanged={refreshPeriodLists}
            />
          </div>
        ))}
        {extra > 0 && (
          <div
            data-testid={`wsset-period-more-files-${p.period_id}`}
            className="pl-[18px] text-[11px] text-ink-mute"
          >
            {t("wsSet.periods.moreFiles", { count: extra })}
          </div>
        )}
      </div>
    );
  }

  /** Open the date review for a period, aimed at the file the engine's
   *  record actually describes. */
  function openReview(p: OrgPeriod) {
    const facts = filingFor(p);
    if (!facts) return;
    const docs = p.documents ?? [];
    const doc =
      docs.find((d) => d.id === facts.source_document_id) ??
      pickActiveSourceDoc(docs) ??
      docs[0] ??
      null;
    if (!doc) return;
    setReviewTarget({
      facts,
      documentId: doc.id,
      documentName: doc.filename ?? doc.id,
    });
  }

  /** Status chip: "N files" / muted-amber "No files". */
  function renderStatusChip(p: OrgPeriod) {
    const count = (p.documents ?? []).length;
    return count === 0 ? (
      <span className="inline-flex items-center rounded-full bg-caution-tint text-caution px-1.5 py-px text-[10px] font-medium">
        {t("wsSet.periods.noFiles")}
      </span>
    ) : (
      <span className="inline-flex items-center rounded-full bg-bg-2/70 text-ink-mute px-1.5 py-px text-[10px] font-medium tabular-nums">
        {t("ws.fileCount", { count })}
      </span>
    );
  }

  /** The kebab. Quarantined rows get Rename + Delete only (renaming onto a
   *  real month IS the fix); valid rows get the full set. */
  function renderKebab(p: OrgPeriod, opts: { bad?: boolean } = {}) {
    const isActive = activePeriod.id === p.period_id;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("wsSet.periods.menuAria")}
            data-testid={`wsset-period-menu-${p.period_id}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="shrink-0 grid place-items-center h-8 w-8 rounded-lg text-ink-mute hover:text-ink hover:bg-bg-2/70 transition-colors"
          >
            <MoreHorizontal size={16} strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[190px]">
          {!opts.bad && (
            <>
              <DropdownMenuItem
                disabled={isActive}
                onSelect={() => setActive(p)}
                data-testid={`wsset-period-setactive-${p.period_id}`}
                className="gap-2"
              >
                <Check size={14} strokeWidth={1.75} />
                {t("wsSet.periods.setActive")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setAttachTarget(p)}
                data-testid={`wsset-period-attach-${p.period_id}`}
                className="gap-2"
              >
                <Paperclip size={14} strokeWidth={1.75} />
                {t("wsSet.periods.attach")}
              </DropdownMenuItem>
              {(p.documents ?? []).length > 0 && (
                <DropdownMenuItem
                  onSelect={() => requestReplace(p)}
                  data-testid={`wsset-period-replace-${p.period_id}`}
                  className="gap-2"
                >
                  <RefreshCw size={14} strokeWidth={1.75} />
                  {t("attachConfirm.menuReplace")}
                </DropdownMenuItem>
              )}
            </>
          )}
          <DropdownMenuItem
            onSelect={() => setRenameTarget(p)}
            data-testid={`wsset-period-rename-${p.period_id}`}
            className="gap-2"
          >
            <Pencil size={14} strokeWidth={1.75} />
            {t("wsSet.periods.rename")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => requestDelete(p)}
            data-testid={`workspace-month-delete-${p.period_id}`}
            className="text-alert focus:text-alert gap-2"
          >
            <Trash2 size={14} strokeWidth={1.75} />
            {t("ws.deletePeriod")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  /** A valid (plausible-date) period row. Click = set active. */
  function renderPeriodRow(p: OrgPeriod) {
    const lbl = label(p);
    const count = (p.documents ?? []).length;
    const isActive = activePeriod.id === p.period_id;
    const isDrop = dragOverId === p.period_id;
    return (
      <motion.div
        {...rowMotion}
        key={p.period_id}
        role="button"
        tabIndex={0}
        aria-label={t("wsSet.periods.setActiveAria", { month: lbl })}
        onClick={() => setActive(p)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setActive(p);
          }
        }}
        {...dropHandlers(p)}
        data-testid={`wsset-period-row-${p.period_id}`}
        data-active={isActive ? "true" : "false"}
        className={`group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors duration-300 ${
          isDrop
            ? "bg-brand/[0.08] ring-1 ring-inset ring-brand/50"
            : isActive
              ? "bg-brand/[0.05] hover:bg-brand/[0.07]"
              : "hover:bg-bg-2/40"
        }`}
      >
        <CalendarDays size={16} strokeWidth={1.5} className="shrink-0 text-ink-mute" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {isActive && (
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_6px_rgba(92,211,197,0.7)]"
              />
            )}
            <span className="text-[13px] font-medium tabular-nums text-ink">{lbl}</span>
            {isActive && (
              <span
                data-testid={`wsset-period-active-${p.period_id}`}
                className="inline-flex items-center rounded-full bg-brand/15 text-brand-d px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.08em]"
              >
                {t("wsSet.periods.active")}
              </span>
            )}
            {renderStatusChip(p)}
            {/* The engine's verdict on this period's date, when it made
                one. Silent otherwise — no record is not an all-clear. */}
            <PeriodFilingChip facts={filingFor(p)} onReview={() => openReview(p)} />
            {isDrop && (
              <span className="text-[10.5px] font-medium text-brand-d">
                {t("wsSet.periods.dropToAttach")}
              </span>
            )}
          </div>
          {renderFileList(p)}
        </div>
        {attachBusyId === p.period_id && (
          <Loader2 size={14} className="shrink-0 animate-spin text-ink-mute" />
        )}
        {count === 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setAttachTarget(p);
            }}
            data-testid={`wsset-period-attach-link-${p.period_id}`}
            className="shrink-0 text-[11.5px] font-medium text-ink-mute underline decoration-rule underline-offset-2 hover:text-ink transition-colors"
          >
            {t("wsSet.periods.attach")}
          </button>
        )}
        {renderKebab(p)}
      </motion.div>
    );
  }

  /** A sub-row inside a duplicate-month group. The month lives in the group
   *  header, so the row's PRIMARY identity is its files — and this is the
   *  shape the audited failure takes (one month, two companies' books), so
   *  the file rows go here in full: role, both dates, and the move menu.
   *  Click = set active. */
  function renderDupSubRow(p: OrgPeriod) {
    const docs = p.documents ?? [];
    const activeDoc = pickActiveSourceDoc(docs);
    const mainDoc = activeDoc ?? docs[0] ?? null;
    const isActive = activePeriod.id === p.period_id;
    const isDrop = dragOverId === p.period_id;
    // Upload date used to live on this line; it now sits on the file row
    // NEXT TO the document's own date, where the two can be told apart.
    const uploaded = mainDoc?.uploaded_at
      ? formatDateTime(mainDoc.uploaded_at, { dateStyle: "medium" })
      : "";
    return (
      <motion.div
        {...rowMotion}
        key={p.period_id}
        role="button"
        tabIndex={0}
        aria-label={t("wsSet.periods.setActiveAria", { month: label(p) })}
        onClick={() => setActive(p)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setActive(p);
          }
        }}
        {...dropHandlers(p)}
        data-testid={`wsset-period-row-${p.period_id}`}
        data-active={isActive ? "true" : "false"}
        className={`group flex items-center gap-3 pl-8 pr-4 py-3 cursor-pointer transition-colors duration-300 ${
          isDrop
            ? "bg-brand/[0.08] ring-1 ring-inset ring-brand/50"
            : isActive
              ? "bg-brand/[0.05] hover:bg-brand/[0.07]"
              : "hover:bg-bg-2/40"
        }`}
      >
        <FileSpreadsheet size={15} strokeWidth={1.5} className="shrink-0 text-ink-mute" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            {isActive && (
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_6px_rgba(92,211,197,0.7)] shrink-0"
              />
            )}
            <span
              title={mainDoc?.filename ?? undefined}
              className={`truncate max-w-[36ch] text-[12.5px] font-medium ${mainDoc ? "text-ink" : "text-ink-mute"}`}
            >
              {mainDoc?.filename ?? t("wsSet.periods.noFile")}
            </span>
            {isActive && (
              <span
                data-testid={`wsset-period-active-${p.period_id}`}
                className="shrink-0 inline-flex items-center rounded-full bg-brand/15 text-brand-d px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.08em]"
              >
                {t("wsSet.periods.active")}
              </span>
            )}
            <PeriodFilingChip facts={filingFor(p)} onReview={() => openReview(p)} />
          </div>
          {docs.length > 1 ? (
            renderFileList(p)
          ) : (
            uploaded && (
              <div className="mt-0.5 text-[11px] text-ink-mute truncate">
                {t("pf.uploaded", { date: uploaded })}
              </div>
            )
          )}
        </div>
        {/* One-file sub-rows keep the filename as their title, so the file
            row would only echo it — the move menu is reached from the
            period kebab instead. */}
        {docs.length === 1 && mainDoc && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMoveTarget({
                id: mainDoc.id,
                name: mainDoc.filename ?? mainDoc.id,
                currentMonth: (p.period_end ?? "").slice(0, 7) || null,
              });
            }}
            data-testid={`pf-subrow-move-${p.period_id}`}
            className="shrink-0 text-[11.5px] font-medium text-ink-mute underline decoration-rule underline-offset-2 hover:text-ink transition-colors"
          >
            {t("pf.move")}
          </button>
        )}
        {attachBusyId === p.period_id && (
          <Loader2 size={14} className="shrink-0 animate-spin text-ink-mute" />
        )}
        {docs.length === 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setAttachTarget(p);
            }}
            data-testid={`wsset-period-attach-link-${p.period_id}`}
            className="shrink-0 text-[11.5px] font-medium text-ink-mute underline decoration-rule underline-offset-2 hover:text-ink transition-colors"
          >
            {t("wsSet.periods.attach")}
          </button>
        )}
        {renderKebab(p)}
      </motion.div>
    );
  }

  /** A quarantined (implausible-date) row — inert (no set-active, no attach,
   *  no "Activ"); its kebab carries Rename (the fix) and Delete. */
  function renderQuarantineRow(p: OrgPeriod) {
    return (
      <motion.div
        {...rowMotion}
        key={p.period_id}
        data-testid={`wsset-period-row-${p.period_id}`}
        className="flex items-center gap-3 px-4 py-3"
      >
        <CalendarDays size={16} strokeWidth={1.5} className="shrink-0 text-caution" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-medium tabular-nums text-ink">{label(p)}</span>
            <span
              data-testid={`wsset-period-baddate-${p.period_id}`}
              className="inline-flex items-center rounded-full bg-caution-tint text-caution px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.06em]"
            >
              {t("ws.badDate")}
            </span>
            {renderStatusChip(p)}
          </div>
          {renderFileList(p, { noActive: true })}
        </div>
        {renderKebab(p, { bad: true })}
      </motion.div>
    );
  }

  const deleteFiles = deleteTarget?.documents ?? [];

  return (
    <MotionConfig reducedMotion="user">
    <div data-testid="workspace-months">
      <div className="flex items-start justify-between gap-3 mb-4">
        <p className="text-[12.5px] text-ink-soft leading-relaxed max-w-[52ch]">
          {t("wsSet.periods.help")}
        </p>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          data-testid="workspace-add-month"
          className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-sm bg-brand text-paper text-[12.5px] font-medium hover:bg-brand-dark transition-colors duration-micro"
        >
          <Plus size={14} strokeWidth={2.25} />
          {t("ws.addPeriod")}
        </button>
      </div>

      {periods.length === 0 ? (
        <div className="rounded-xl border border-dashed border-rule px-5 py-10 flex flex-col items-center gap-3 text-center">
          <p className="text-[12.5px] text-ink-mute">{t("wsSet.periods.empty")}</p>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            data-testid="wsset-period-empty-cta"
            className="inline-flex items-center gap-1.5 h-8 px-4 rounded-sm bg-brand text-paper text-[12.5px] font-medium hover:bg-brand-dark transition-colors duration-micro"
          >
            <Plus size={14} strokeWidth={2.25} />
            {t("wsSet.periods.emptyCta")}
          </button>
        </div>
      ) : (
        <>
          {timeline.length > 0 && (
            <div className="rounded-xl border border-rule divide-y divide-rule/60 overflow-hidden">
              <AnimatePresence initial={false}>
                {timeline.map((g) => {
                  if (g.periods.length === 1) return renderPeriodRow(g.periods[0]!);
                  // Duplicate month — flat group: an explanatory header, then
                  // every sub-period differentiated by its file names.
                  const lbl = label(g.periods[0]!);
                  return (
                    <motion.div {...rowMotion} key={g.key} data-testid={`wsset-period-group-${g.key}`}>
                      <div className="px-4 pt-3 pb-2 bg-bg-2/30">
                        <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                          <span className="h-1.5 w-1.5 rounded-full bg-caution shrink-0" aria-hidden />
                          <span data-testid={`wsset-period-duplicate-${g.key}`}>
                            {t("wsSet.periods.dupTitle", { month: lbl, count: g.periods.length })}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-ink-mute">
                          {t("wsSet.periods.dupGuidance")}
                        </p>
                      </div>
                      <div className="divide-y divide-rule/40 border-t border-rule/40">
                        <AnimatePresence initial={false}>
                          {g.periods.map((p) => renderDupSubRow(p))}
                        </AnimatePresence>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}

          {quarantine.length > 0 && (
            <div
              data-testid="wsset-period-quarantine"
              className="mt-4 rounded-xl border border-caution/30 bg-caution-tint overflow-hidden"
            >
              <div className="px-4 pt-3 pb-2 border-b border-caution/20">
                <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-caution">
                  {t("wsSet.periods.needsAttention")}
                </div>
                <p className="mt-0.5 text-[11px] text-ink-mute leading-relaxed">
                  {t("wsSet.periods.needsAttentionHint")}
                </p>
              </div>
              <div className="divide-y divide-caution/15">
                <AnimatePresence initial={false}>
                  {quarantine.map((p) => renderQuarantineRow(p))}
                </AnimatePresence>
              </div>
            </div>
          )}
        </>
      )}

      {/* Delete confirmation — periods WITH files only; lists the files that
          go with the period (they move to Recently deleted). */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-[440px]" data-testid="workspace-period-delete-dialog">
          <DialogHeader>
            <DialogTitle>
              {t("ws.deletePeriodDialogTitle", {
                label: deleteTarget ? label(deleteTarget) : t("ws.thisPeriod"),
              })}
            </DialogTitle>
            <DialogDescription>{t("ws.deletePeriodBody")}</DialogDescription>
          </DialogHeader>
          {deleteFiles.length > 0 && (
            <ul className="rounded-lg border border-rule bg-bg-2/30 px-3 py-2 space-y-1 max-h-40 overflow-y-auto">
              {deleteFiles.map((d) => (
                <li key={d.id} className="flex items-center gap-1.5 min-w-0 text-[12px] text-ink-soft">
                  <FileSpreadsheet size={12} strokeWidth={1.5} className="shrink-0 text-ink-mute" />
                  <span className="truncate" title={d.filename ?? undefined}>
                    {d.filename ?? d.id}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              data-testid="workspace-period-delete-confirm"
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-alert/30 bg-alert-tint text-[12.5px] font-medium text-alert hover:border-alert/50 transition-colors duration-micro"
            >
              <Trash2 size={14} strokeWidth={1.75} />
              {t("ws.deletePeriod")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RenamePeriodDialog
        period={renameTarget}
        takenMonths={takenMonths}
        monthLabelOf={monthLabelOf}
        onClose={() => setRenameTarget(null)}
        onRename={performRename}
        onMerge={performMerge}
      />

      {/* ── the correction path ──────────────────────────────────────────
          Both of these re-file ONE document under a month the user
          confirmed for it, through the engine's move endpoint. Neither
          touches `financial_periods` directly: the engine re-runs the
          pipeline for both ends and audits itself for orphaned analysis
          before it answers. */}
      <MoveFileDialog
        orgId={orgId}
        target={moveTarget}
        onClose={() => setMoveTarget(null)}
        onMoved={refreshPeriodLists}
      />
      <PeriodFilingReviewDialog
        orgId={orgId}
        target={reviewTarget}
        onClose={() => setReviewTarget(null)}
        onMoved={refreshPeriodLists}
        onChooseMonth={(rt) => {
          // The review hands off to the picker rather than dead-ending —
          // especially in the "date unknown" case, where the engine has
          // no month to offer and only a person can supply one.
          setReviewTarget(null);
          setMoveTarget({
            id: rt.documentId,
            name: rt.documentName,
            currentMonth: (rt.facts.period_end ?? "").slice(0, 7) || null,
          });
        }}
      />

      <AddPeriodDialogV2
        open={addOpen || !!attachTarget}
        onOpenChange={(o) => {
          if (!o) {
            setAddOpen(false);
            setAttachTarget(null);
          }
        }}
        takenMonths={takenMonths}
        orgId={orgId}
        attachPeriod={attachTarget}
        onNeedsConfirm={(req) => {
          setAddOpen(false);
          setAttachTarget(null);
          setConfirmReq(req);
        }}
      />

      {/* "Replace file" file picker — invisible; the confirm step is what
          the user actually sees. */}
      <input
        ref={replaceInputRef}
        type="file"
        accept=".pdf,.xlsx,.xls,.csv"
        className="hidden"
        data-testid="wsset-period-replace-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          const target = replaceTargetRef.current;
          e.target.value = "";
          replaceTargetRef.current = null;
          if (!f || !target) return;
          setConfirmReq({
            file: f,
            mode: "replace",
            context: {
              periodId: target.period.period_id,
              periodEnd: target.period.period_end,
              reason: "replacing",
            },
            replacing: target.doc,
          });
        }}
      />

      {/* THE CONFIRM STEP — the only source of a periodEndHint. */}
      <AttachConfirmDialog
        open={!!confirmReq}
        mode={confirmReq?.mode ?? "attach"}
        file={confirmReq?.file ?? null}
        periods={periods}
        context={confirmReq?.context ?? null}
        replacing={confirmReq?.replacing ?? null}
        onCancel={() => setConfirmReq(null)}
        onConfirm={(result) => {
          const req = confirmReq;
          setConfirmReq(null);
          if (req) void runConfirmedAttach(req, result);
        }}
      />
      {uploadEnqueue.dialog}
    </div>
    </MotionConfig>
  );
}

// ─── Rename / merge dialog ───────────────────────────────────────────────────
// Month-year picker only (2000-01 → Dec of next year). Choosing a month the
// workspace already has flips the dialog into a merge prompt: move this
// period's files into the existing month and delete the shell, or cancel.

function RenamePeriodDialog({
  period,
  takenMonths,
  monthLabelOf,
  onClose,
  onRename,
  onMerge,
}: {
  period: OrgPeriod | null;
  takenMonths: string[];
  monthLabelOf: (monthKey: string) => string;
  onClose: () => void;
  onRename: (p: OrgPeriod, monthKey: string) => Promise<boolean>;
  onMerge: (p: OrgPeriod, monthKey: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const [month, setMonth] = useState("");
  const [busy, setBusy] = useState(false);
  const [mergePrompt, setMergePrompt] = useState(false);

  const maxYear = new Date().getFullYear() + 1;
  const minMonth = "2000-01";
  const maxMonth = `${maxYear}-12`;
  const open = !!period;
  const ownMonth = period ? (period.period_end ?? "").slice(0, 7) : "";

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setMergePrompt(false);
    setMonth(/^\d{4}-\d{2}$/.test(ownMonth) && ownMonth >= minMonth && ownMonth <= maxMonth ? ownMonth : "");
  }, [open, ownMonth, maxMonth]);

  if (!period) return null;

  const monthValid = /^\d{4}-\d{2}$/.test(month) && month >= minMonth && month <= maxMonth;
  const unchanged = monthValid && month === ownMonth;
  const occupied = monthValid && !unchanged && takenMonths.includes(month);
  const canSubmit = monthValid && !unchanged && !busy;
  const currentLabel =
    formatPeriodMonth(period.period_end, locale) ??
    formatPeriodMonthLoose(period.period_end, locale) ??
    period.period_label;

  async function submit() {
    if (!canSubmit || !period) return;
    if (occupied && !mergePrompt) {
      setMergePrompt(true);
      return;
    }
    setBusy(true);
    const ok = occupied ? await onMerge(period, month) : await onRename(period, month);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]" data-testid="wsset-period-rename-dialog">
        <DialogHeader>
          <DialogTitle>
            {mergePrompt
              ? t("wsSet.periods.mergeTitle", { month: monthLabelOf(month) })
              : t("wsSet.periods.renameTitle", { month: currentLabel })}
          </DialogTitle>
          <DialogDescription>
            {mergePrompt
              ? t("wsSet.periods.mergeBody", { month: monthLabelOf(month) })
              : t("wsSet.periods.renameDesc")}
          </DialogDescription>
        </DialogHeader>

        {!mergePrompt && (
          <div>
            <label
              htmlFor="wsset-rename-period-month"
              className="block text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute mb-1.5"
            >
              {t("ws.periodLabel")}
            </label>
            <input
              id="wsset-rename-period-month"
              type="month"
              value={month}
              min={minMonth}
              max={maxMonth}
              onChange={(e) => setMonth(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) void submit();
              }}
              data-testid="wsset-period-rename-month"
              className="w-full h-8 px-3 rounded-sm border border-rule bg-surface text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/50"
            />
            {!monthValid && month !== "" && (
              <p className="mt-1.5 text-[11.5px] text-caution">
                {t("wsSet.addPeriod.range", { year: maxYear })}
              </p>
            )}
            {occupied && (
              <p className="mt-1.5 text-[11.5px] text-caution" data-testid="wsset-period-rename-occupied">
                {t("wsSet.addPeriod.duplicateBlocked", { month: monthLabelOf(month) })}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={() => (mergePrompt ? setMergePrompt(false) : onClose())}
            disabled={busy}
            className="inline-flex items-center h-8 px-3.5 rounded-sm border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors duration-micro"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            data-testid={mergePrompt ? "wsset-period-merge-confirm" : "wsset-period-rename-confirm"}
            className="inline-flex items-center gap-1.5 h-8 px-4 rounded-sm bg-brand text-paper text-[12.5px] font-medium hover:bg-brand-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-micro"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {mergePrompt
              ? t("wsSet.periods.mergeConfirm", { month: monthLabelOf(month) })
              : occupied
                ? t("wsSet.periods.mergeConfirm", { month: monthLabelOf(month) })
                : t("wsSet.periods.rename")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add / attach dialog ─────────────────────────────────────────────────────
// Month-year picker ONLY (input type="month", min 2000-01, max Dec of next
// year), pre-selected to the next missing month; Enter confirms; duplicate
// months are blocked outright — a month that exists is managed from the list,
// never re-created.
//
// FILE-LESS ONLY (2026-08-30). Creating an EMPTY period from a typed month is
// still this dialog's job — a container has no document to disagree with. But
// the moment a FILE is staged, the month stops being a container name and
// becomes a claim about that document's contents, and this dialog has not read
// it. So it hands the file to the confirm step (`onNeedsConfirm`) with the
// typed month as CONTEXT, and never uploads. It used to upload with
// `periodEndHint: periodEnd` — the typed month — which is the same
// UI-state-as-confirmation defect the drop path had.

function AddPeriodDialogV2({
  open,
  onOpenChange,
  takenMonths,
  orgId,
  attachPeriod,
  onNeedsConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  takenMonths: string[];
  orgId: string;
  attachPeriod: OrgPeriod | null;
  onNeedsConfirm: (req: ConfirmRequest) => void;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const qc = useQueryClient();
  const uploadEnqueue = useUploadEnqueue();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [month, setMonth] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const attachMode = !!attachPeriod;
  const maxYear = new Date().getFullYear() + 1;
  const minMonth = "2000-01";
  const maxMonth = `${maxYear}-12`;

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setBusy(false);
    setDragging(false);
    if (attachPeriod?.period_end) {
      setMonth(attachPeriod.period_end.slice(0, 7));
    } else {
      setMonth(nextMissingMonth(takenMonths));
    }
    // takenMonths is intentionally read once per open — reshuffling the
    // preselection while the dialog is open would fight the user's input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attachPeriod]);

  const monthValid =
    /^\d{4}-\d{2}$/.test(month) && month >= minMonth && month <= maxMonth;
  const duplicate = !attachMode && monthValid && takenMonths.includes(month);
  const monthLabel = formatPeriodMonth(`${month}-15`, locale) ?? month;
  const canSubmit = attachMode
    ? !!file && !busy
    : monthValid && !duplicate && !busy;

  const refreshPeriodLists = () => {
    void qc.invalidateQueries({ queryKey: ["org-periods", orgId] });
    void qc.invalidateQueries({ queryKey: ["org-periods"] });
    void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
    void qc.invalidateQueries({ queryKey: ["workspace-docs", orgId] });
  };

  async function submit() {
    if (!canSubmit) return;
    const periodEnd = attachMode
      ? attachPeriod!.period_end ?? lastDayIso(month)
      : lastDayIso(month);

    // A staged file goes to the confirm step, which reads the document and
    // asks the human. Nothing is created or uploaded here — creating the
    // container first would leave an empty month behind whenever the
    // document turns out to cover a different one.
    if (file) {
      onNeedsConfirm({
        file,
        mode: "attach",
        context: {
          periodId: attachPeriod?.period_id ?? null,
          periodEnd,
          reason: "chosen",
        },
        replacing: null,
      });
      return;
    }

    setBusy(true);
    const lbl = formatPeriodMonth(periodEnd, locale) ?? formatPeriodMonthLoose(periodEnd, locale) ?? month;
    try {
      if (!attachMode) {
        const created = await createEmptyPeriod(orgId, periodEnd);
        if ("error" in created) throw new Error(created.error);
      }
      refreshPeriodLists();
      toast.success(t("ws.periodAdded", { label: lbl }), {
        description: t("ws.noFileYet"),
      });
      onOpenChange(false);
      setBusy(false);
    } catch (err) {
      toast.error(t("ws.cantAddPeriod"), {
        description: err instanceof Error ? err.message : undefined,
      });
      setBusy(false);
    }
  }

  return (
    <>
      {uploadEnqueue.dialog}
      <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
        <DialogContent className="sm:max-w-[480px]" data-testid="workspace-add-period-dialog">
          <DialogHeader>
            <DialogTitle>
              {attachMode
                ? t("wsSet.addPeriod.attachTitle", { month: monthLabel })
                : t("ws.addPeriodDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {attachMode ? t("wsSet.addPeriod.attachDesc") : t("ws.addPeriodDialogDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!attachMode && (
              <div>
                <label
                  htmlFor="wsset-add-period-month"
                  className="block text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute mb-1.5"
                >
                  {t("ws.periodLabel")}
                </label>
                <input
                  id="wsset-add-period-month"
                  type="month"
                  value={month}
                  min={minMonth}
                  max={maxMonth}
                  onChange={(e) => setMonth(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmit) void submit();
                  }}
                  data-testid="workspace-add-period-month"
                  className="w-full h-8 px-3 rounded-sm border border-rule bg-surface text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/50"
                />
                {!monthValid && month !== "" && (
                  <p className="mt-1.5 text-[11.5px] text-caution" data-testid="wsset-add-period-range">
                    {t("wsSet.addPeriod.range", { year: maxYear })}
                  </p>
                )}
                {duplicate && (
                  <p className="mt-1.5 text-[11.5px] text-caution" data-testid="workspace-add-period-duplicate">
                    {t("wsSet.addPeriod.duplicateBlocked", { month: monthLabel })}
                  </p>
                )}
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setFile(f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
              data-testid="workspace-add-period-file"
              className={`w-full flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
                dragging
                  ? "border-brand/60 bg-brand/[0.06]"
                  : "border-rule hover:border-rule-strong hover:bg-bg-2/40"
              }`}
            >
              {file ? (
                <>
                  <FileSpreadsheet size={22} strokeWidth={1.5} className="text-ink-mute" />
                  <span className="text-[12.5px] font-medium text-ink max-w-full truncate">
                    {file.name}
                  </span>
                  <span className="text-[11px] text-ink-mute">{t("ws.chooseDifferentFile")}</span>
                </>
              ) : (
                <>
                  <UploadCloud size={22} strokeWidth={1.5} className="text-ink-mute" />
                  <span className="text-[12.5px] font-medium text-ink">
                    {t("ws.dropTrialBalance")}
                  </span>
                  {!attachMode && (
                    <span className="text-[11px] text-ink-mute">{t("ws.attachLater")}</span>
                  )}
                </>
              )}
            </button>
          </div>

          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="inline-flex items-center h-8 px-3.5 rounded-sm border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2 disabled:opacity-50 transition-colors duration-micro"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              data-testid="workspace-add-period-confirm"
              className="inline-flex items-center gap-1.5 h-8 px-4 rounded-sm bg-brand text-paper text-[12.5px] font-medium hover:bg-brand-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-micro"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {busy
                ? file
                  ? t("upload.uploading")
                  : t("ws.creating")
                : attachMode
                  ? t("wsSet.periods.attach")
                  : t("ws.addPeriod")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
