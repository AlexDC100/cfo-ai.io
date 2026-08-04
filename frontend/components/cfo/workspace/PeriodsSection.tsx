// PeriodsSection — the Workspace Settings "Perioade" card (2026-08-04 redesign).
//
// A timeline list of the workspace's periods, newest month first, replacing
// the old master-detail block inside the settings surface. Display rules:
//
//   · Rows are DEDUPLICATED by calendar month: several periods sharing one
//     month collapse into a single row carrying an amber "Duplicate" chip and
//     an expandable sublist, so choosing/deleting individual duplicates stays
//     possible while the list never shows the same month twice.
//   · Rows with an implausible date (isImplausiblePeriod — misread Excel
//     serials etc.) keep the existing "Check date" treatment, are never
//     grouped, and are excluded from the "Active" logic.
//   · The app's current `?period=` gets an "Active" chip.
//   · Empty rows (no files) carry an attach affordance that reuses the
//     existing upload flow (uploadDocument + periodEndHint + enqueue).
//
// Every data mutation stays on its existing code path: createEmptyPeriod /
// uploadDocument+enqueue for add, deleteEmptyPeriod / cfoApi.deletePeriod for
// delete, with the same guards (current month is permanent, a workspace keeps
// at least one period).

import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  FileSpreadsheet,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Plus,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { periodQueryKey, useActivePeriod } from "@/lib/activePeriod";
import { forgetPeriodVerdictFor } from "@/lib/dataPresence";
import { useActiveLocale } from "@/lib/locale";
import {
  createEmptyPeriod,
  deleteEmptyPeriod,
  fetchWorkspacePeriodsDirect,
  formatPeriodMonth,
  formatPeriodMonthLoose,
  isCurrentMonthPeriod,
  isImplausiblePeriod,
  type OrgPeriod,
  type OrgPeriodsPayload,
} from "@/lib/orgPeriods";
import { useUploadEnqueue } from "@/hooks/useUploadEnqueue";
import "./wsSetI18n";

// ─── helpers ─────────────────────────────────────────────────────────────────

function monthKeyOf(p: OrgPeriod): string {
  return (p.period_end ?? "").slice(0, 7);
}

interface MonthGroup {
  /** "YYYY-MM" for plausible rows; the period_id for implausible ones. */
  key: string;
  periods: OrgPeriod[];
  implausible: boolean;
}

// ─── section ─────────────────────────────────────────────────────────────────

export function PeriodsSection({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const qc = useQueryClient();
  const activePeriod = useActivePeriod();
  const [urlParams, setUrlParams] = useSearchParams();

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

  // Group by month; implausible rows stay ungrouped (their "month" is noise).
  const groups = useMemo<MonthGroup[]>(() => {
    const out: MonthGroup[] = [];
    const byMonth = new Map<string, MonthGroup>();
    for (const p of periods) {
      if (isImplausiblePeriod(p.period_end)) {
        out.push({ key: p.period_id, periods: [p], implausible: true });
        continue;
      }
      const key = monthKeyOf(p);
      const existing = byMonth.get(key);
      if (existing) existing.periods.push(p);
      else {
        const g: MonthGroup = { key, periods: [p], implausible: false };
        byMonth.set(key, g);
        out.push(g);
      }
    }
    return out;
  }, [periods]);

  const takenMonths = useMemo(
    () => Array.from(new Set(periods.filter((p) => !isImplausiblePeriod(p.period_end)).map(monthKeyOf))).filter(Boolean),
    [periods],
  );

  const [addOpen, setAddOpen] = useState(false);
  /** Attach-mode target: an existing (usually empty) period getting a file. */
  const [attachTarget, setAttachTarget] = useState<OrgPeriod | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OrgPeriod | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const label = (p: OrgPeriod) =>
    formatPeriodMonth(p.period_end, locale) ?? formatPeriodMonthLoose(p.period_end, locale) ?? p.period_label;

  // ── delete (existing flow: guards + optimistic drop + engine/RLS delete) ──
  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    const lbl = label(target);

    if (isCurrentMonthPeriod(target.period_end)) {
      setDeleteTarget(null);
      toast.info(t("ws.currentMonthUndeletable", { label: lbl }));
      return;
    }
    if (periods.length <= 1) {
      setDeleteTarget(null);
      toast.info(t("ws.keepOnePeriod"));
      return;
    }

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
    setDeleteTarget(null);

    // Move the app-wide `?period=` off the deleted row so the sidebar label
    // doesn't keep naming a period that no longer exists.
    if (urlParams.get("period") === target.period_id) {
      const successor = periods.find((p) => p.period_id !== target.period_id) ?? null;
      const nextParams = new URLSearchParams(urlParams);
      if (successor) nextParams.set("period", successor.period_id);
      else nextParams.delete("period");
      setUrlParams(nextParams, { replace: true });
    }

    try {
      if ((target.documents?.length ?? 0) === 0) {
        const errMsg = await deleteEmptyPeriod(target.period_id);
        if (errMsg) throw new Error(errMsg);
        toast.success(t("ws.periodDeleted", { label: lbl }));
      } else {
        const { cfoApi } = await import("@/lib/cfoApi");
        const res = await cfoApi.deletePeriod(target.period_id);
        toast.success(t("ws.periodDeleted", { label: lbl }), {
          description: res.documents_soft_deleted
            ? t("ws.filesMovedToDeleted", { count: res.documents_soft_deleted })
            : undefined,
        });
      }
      void qc.invalidateQueries({ queryKey: scopedKey });
      void qc.invalidateQueries({ queryKey: activeKey });
      void qc.invalidateQueries({ queryKey: ["workspace-docs", orgId] });
    } catch (err) {
      if (prevScoped !== undefined) qc.setQueryData(scopedKey, prevScoped);
      if (prevActive !== undefined) qc.setQueryData(activeKey, prevActive);
      toast.error(t("ws.cantDeletePeriod"), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }

  function renderRow(p: OrgPeriod, opts: { sub?: boolean; implausible?: boolean } = {}) {
    const lbl = label(p);
    const count = (p.documents ?? []).length;
    const bad = opts.implausible ?? isImplausiblePeriod(p.period_end);
    const isActive = !bad && activePeriod.id === p.period_id;
    const cannotDelete = isCurrentMonthPeriod(p.period_end) || periods.length <= 1;
    return (
      <div
        key={p.period_id}
        data-testid={`wsset-period-row-${p.period_id}`}
        className={`flex items-center gap-3 px-4 py-3 ${opts.sub ? "pl-10 bg-bg-2/30" : ""}`}
      >
        <FileSpreadsheet size={17} strokeWidth={1.5} className="shrink-0 text-ink-mute" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-medium tabular-nums text-ink">{lbl}</span>
            {isActive && (
              <span
                data-testid={`wsset-period-active-${p.period_id}`}
                className="inline-flex items-center rounded-full bg-brand/15 text-brand-d px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.08em]"
              >
                {t("wsSet.periods.active")}
              </span>
            )}
            {bad && (
              <span className="inline-flex items-center rounded-full bg-amber-500/15 text-amber-500 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.06em]">
                {t("ws.badDate")}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-mute">
            {count === 0 ? t("ws.noFilesAttached") : t("ws.fileCount", { count })}
          </div>
        </div>
        {count === 0 && (
          <button
            type="button"
            onClick={() => setAttachTarget(p)}
            data-testid={`wsset-period-attach-${p.period_id}`}
            className="shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-rule text-[11.5px] font-medium text-ink-soft hover:text-ink hover:border-rule-strong hover:bg-bg-2/60 transition-colors"
          >
            <Paperclip size={12} strokeWidth={1.75} />
            {t("wsSet.periods.attach")}
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("wsSet.periods.menuAria")}
              data-testid={`wsset-period-menu-${p.period_id}`}
              className="shrink-0 grid place-items-center h-8 w-8 rounded-lg text-ink-mute hover:text-ink hover:bg-bg-2/70 transition-colors"
            >
              <MoreHorizontal size={16} strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem
              disabled={cannotDelete}
              title={
                isCurrentMonthPeriod(p.period_end)
                  ? t("ws.currentMonthKept")
                  : periods.length <= 1
                    ? t("ws.keepOnePeriodTitle")
                    : undefined
              }
              onSelect={() => setDeleteTarget(p)}
              data-testid={`workspace-month-delete-${p.period_id}`}
              className="text-red-500 focus:text-red-500 gap-2"
            >
              <Trash2 size={14} strokeWidth={1.75} />
              {t("ws.deletePeriod")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div data-testid="workspace-months">
      <div className="flex items-start justify-between gap-3 mb-4">
        <p className="text-[12.5px] text-ink-soft leading-relaxed max-w-[52ch]">
          {t("ws.periodsBodyCompact")}
        </p>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          data-testid="workspace-add-month"
          className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors"
        >
          <Plus size={14} strokeWidth={2.25} />
          {t("ws.addPeriod")}
        </button>
      </div>

      {periods.length === 0 ? (
        <div className="rounded-xl border border-dashed border-rule px-5 py-8 text-center text-[12.5px] text-ink-mute">
          {t("wsSet.periods.empty")}
        </div>
      ) : (
        <div className="rounded-xl border border-rule divide-y divide-rule/60 overflow-hidden">
          {groups.map((g) => {
            if (g.periods.length === 1) return renderRow(g.periods[0]!, { implausible: g.implausible });
            // Duplicate month — one visible row, expandable sublist.
            const isOpen = !!expanded[g.key];
            const head = g.periods[0]!;
            const lbl = label(head);
            const total = g.periods.reduce((n, p) => n + (p.documents ?? []).length, 0);
            return (
              <div key={g.key} data-testid={`wsset-period-group-${g.key}`}>
                <button
                  type="button"
                  onClick={() => setExpanded((e) => ({ ...e, [g.key]: !isOpen }))}
                  aria-expanded={isOpen}
                  aria-label={isOpen ? t("wsSet.periods.collapse") : t("wsSet.periods.expand")}
                  data-testid={`wsset-period-group-toggle-${g.key}`}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-2/40 transition-colors"
                >
                  <FileSpreadsheet size={17} strokeWidth={1.5} className="shrink-0 text-ink-mute" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[13px] font-medium tabular-nums text-ink">{lbl}</span>
                      <span
                        data-testid={`wsset-period-duplicate-${g.key}`}
                        className="inline-flex items-center rounded-full bg-amber-500/15 text-amber-500 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.06em]"
                      >
                        {t("wsSet.periods.duplicate")} · {g.periods.length}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-mute">
                      {t("wsSet.periods.duplicateHint", { count: g.periods.length })}
                      {" · "}
                      {total === 0 ? t("ws.noFilesAttached") : t("ws.fileCount", { count: total })}
                    </div>
                  </div>
                  <ChevronDown
                    size={16}
                    strokeWidth={1.75}
                    className={`shrink-0 text-ink-mute transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {isOpen && (
                  <div className="divide-y divide-rule/40 border-t border-rule/40">
                    {g.periods.map((p) => renderRow(p, { sub: true }))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation — same copy + guards as the previous surface. */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-[440px]" data-testid="workspace-period-delete-dialog">
          <DialogHeader>
            <DialogTitle>
              {t("ws.deletePeriodDialogTitle", {
                label: deleteTarget ? label(deleteTarget) : t("ws.thisPeriod"),
              })}
            </DialogTitle>
            <DialogDescription>
              {(deleteTarget?.documents?.length ?? 0) === 0
                ? t("ws.deletePeriodEmptyBody")
                : t("ws.deletePeriodBody")}
            </DialogDescription>
          </DialogHeader>
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
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-red-500/30 bg-red-500/10 text-[13px] font-medium text-red-600 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 size={14} strokeWidth={1.75} />
              {t("ws.deletePeriod")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
      />
    </div>
  );
}

// ─── Add / attach dialog ─────────────────────────────────────────────────────
// Month-year picker ONLY (input type="month", min 2000-01, max Dec of next
// year); duplicate months are blocked outright — a month that exists is
// managed from the list, never re-created. In attach mode the dialog targets
// an EXISTING period: the month is fixed and the file is required; the upload
// carries periodEndHint so the pipeline adopts that same row.
// Data paths unchanged: createEmptyPeriod + uploadDocument/enqueue.

function AddPeriodDialogV2({
  open,
  onOpenChange,
  takenMonths,
  orgId,
  attachPeriod,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  takenMonths: string[];
  orgId: string;
  attachPeriod: OrgPeriod | null;
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
      const now = new Date();
      setMonth(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`);
    }
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
    setBusy(true);
    // Trial-balance convention: period-end is the LAST day of the month.
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    const periodEnd = attachMode
      ? attachPeriod!.period_end ?? `${month}-${String(lastDay).padStart(2, "0")}`
      : `${month}-${String(lastDay).padStart(2, "0")}`;
    const lbl = formatPeriodMonth(periodEnd, locale) ?? formatPeriodMonthLoose(periodEnd, locale) ?? month;

    try {
      if (!attachMode) {
        const created = await createEmptyPeriod(orgId, periodEnd);
        if ("error" in created) throw new Error(created.error);
      }
      refreshPeriodLists();

      if (file) {
        const { uploadDocument, subscribeToDocumentStatus } = await import("@/lib/supabase");
        const { row, error } = await uploadDocument(file, {
          scope: "financial",
          periodEndHint: periodEnd,
        });
        if (!row) throw new Error(error ?? t("errors.uploadFailed"));
        const enq = await uploadEnqueue.enqueue(row.id);
        if (enq.kind !== "queued") {
          onOpenChange(false);
          setBusy(false);
          return;
        }
        toast.success(t("ws.periodAddedAnalyzing", { label: lbl, file: file.name }));
        const unsub = subscribeToDocumentStatus(row.id, (next) => {
          if (next.status === "analyzed") {
            unsub();
            refreshPeriodLists();
            if (next.period_id) {
              void qc.resetQueries({ queryKey: periodQueryKey(next.period_id) });
            }
            toast.success(t("ws.periodReady", { label: lbl }));
          } else if (next.status === "failed") {
            unsub();
            refreshPeriodLists();
            toast.error(t("ws.cantAnalyzeFile"), { description: next.error ?? undefined });
          }
        });
      } else {
        toast.success(t("ws.periodAdded", { label: lbl }), {
          description: t("ws.noFileYet"),
        });
      }
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
                  data-testid="workspace-add-period-month"
                  className="w-full h-10 px-3 rounded-lg border border-rule bg-surface text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
                />
                {!monthValid && month !== "" && (
                  <p className="mt-1.5 text-[11.5px] text-amber-600" data-testid="wsset-add-period-range">
                    {t("wsSet.addPeriod.range", { year: maxYear })}
                  </p>
                )}
                {duplicate && (
                  <p className="mt-1.5 text-[11.5px] text-amber-600" data-testid="workspace-add-period-duplicate">
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
              className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 disabled:opacity-50 transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              data-testid="workspace-add-period-confirm"
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
