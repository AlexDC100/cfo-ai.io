// UploadFlowHost — the confirmation card, the live progress and the result
// announcements of the workspace-redesign upload flow. Mounted ONCE, in
// AppShell, only while `workspace_v2` is on for the viewer.
//
// It reads lib/uploadFlow (the store every drop target writes to) and owns
// everything with a side effect the store must not have: navigation, the
// workspace switch, the extra-document dialog, toasts and bell entries.
//
//   card phases    identifying → confirm (⇄ Change) → committing
//                                  ├→ duplicate  "Already uploaded — open it"
//                                  └→ progress   5 live steps naming the company
//   after Analyse  the screen and the header FOLLOW the target company: the
//                  active workspace switches to it and its company page opens
//                  underneath the card (G1 — an Agras file dropped on a
//                  Scandia page lands in Agras, and so does the screen).
//   on done        toast + bell entry; if the card is still following the job,
//                  the analysed company's dashboard opens.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, Check, FileText, Loader2, X } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { ORG_INDUSTRIES, orgIndustryDisplayLabel } from "@/components/cfo/OrgIndustryPills";
import { ExtraDocConfirmDialog } from "@/components/cfo/pricing/ExtraDocConfirmDialog";
import { activateWorkspace, useActiveOrg } from "@/lib/org";
import { formatDateOnly, useActiveLocale } from "@/lib/locale";
import { subscribeToDocumentStatus } from "@/lib/supabase";
import { pushUploadNotice } from "@/lib/uploadNotices";
import {
  ANALYSIS_STEP_COUNT,
  addJob,
  analyseBlocker,
  analyseUpload,
  choiceCompanyName,
  closeUploadFlow,
  followJob,
  isJobDone,
  patchJob,
  retryIdentify,
  returnToConfirm,
  showJobInFlow,
  stepOrdinal,
  updateChoice,
  useAnalysisJobs,
  useUploadFlow,
  type AnalysisJob,
  type FlowChoice,
  type FlowState,
} from "@/lib/uploadFlow";
import type { ExtraDocConfirmation, IdentifyResult } from "@/lib/uploadsApi";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { sourceKey } from "./identitySources";
import { useIndustryCatalog, useIndustryLabel } from "./industryLabel";
import { periodDashboardHref } from "@/lib/dashboardHref";

// ── Navigation helpers ─────────────────────────────────────────────────

/** Where an analysed (or already-uploaded) period opens — one authority,
 *  shared with the sidebar's Dashboard row (lib/dashboardHref). */
export const dashboardHref = periodDashboardHref;

function useOpenCompanyPeriod() {
  const navigate = useNavigate();
  return useCallback(
    async (orgId: string, periodId: string | null, companyName: string | null) => {
      // Switch FIRST, then navigate: the header must never name one company
      // over another company's page, not even for the frame in between.
      await activateWorkspace(orgId, { name: companyName });
      navigate(dashboardHref(orgId, periodId));
    },
    [navigate],
  );
}

// ── Host ───────────────────────────────────────────────────────────────

/** The extra-document dialog's confirm step for a commit: nothing to call —
 *  the repeated commit carries `confirm_extra` and the engine reserves the
 *  extra for the document it then stores. */
const confirmOnCommit = async (): Promise<void> => {};

export function UploadFlowHost() {
  const { t } = useTranslation();
  const flow = useUploadFlow();
  const jobs = useAnalysisJobs();
  const navigate = useNavigate();
  const openPeriod = useOpenCompanyPeriod();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // The plan's extra-document question (402), asked with the existing dialog.
  const [confirmExtra, setConfirmExtra] = useState<ExtraDocConfirmation | null>(null);

  // Latest flow for callbacks fired from subscriptions.
  const flowRef = useRef<FlowState>(flow);
  flowRef.current = flow;

  // ── Job tracking: one status subscription per running analysis ──────
  const subs = useRef(new Map<string, () => void>());
  useEffect(() => {
    for (const job of jobs) {
      if (isJobDone(job) || subs.current.has(job.docId)) continue;
      const unsubscribe = subscribeToDocumentStatus(job.docId, (row) => {
        patchJob(job.docId, {
          status: row.status,
          error: row.error ?? null,
          periodId: row.period_id ?? null,
        });
      });
      subs.current.set(job.docId, unsubscribe);
    }
    for (const [docId, unsubscribe] of subs.current) {
      const job = jobs.find((j) => j.docId === docId);
      if (!job || isJobDone(job)) {
        unsubscribe();
        subs.current.delete(docId);
      }
    }
  }, [jobs]);
  useEffect(
    () => () => {
      for (const unsubscribe of subs.current.values()) unsubscribe();
      subs.current.clear();
    },
    [],
  );

  // ── Announce each finished job exactly once ──────────────────────────
  useEffect(() => {
    for (const job of jobs) {
      if (!isJobDone(job) || job.announced) continue;
      patchJob(job.docId, { announced: true });
      const done = job.status === "analyzed";
      // A new year exists now: the company's tiles and cards re-read it.
      if (done) {
        void queryClient.invalidateQueries({ queryKey: ["company-years", job.orgId] });
        void queryClient.invalidateQueries({ queryKey: ["company-directory"] });
        // …and so do the period lists the dashboard reads (its stepper, and
        // the comparison's "previous year": a balance uploaded from here used
        // to stay "missing" there until a reload — the client never refetches
        // on mount). Same two families the dashboard's own upload refreshes.
        void queryClient.invalidateQueries({ queryKey: ["periods-with-documents"] });
        void queryClient.invalidateQueries({ queryKey: ["org-periods"] });
      }
      pushUploadNotice({
        id: job.docId,
        kind: done ? "done" : "failed",
        companyName: job.companyName,
        orgId: job.orgId,
        periodId: job.periodId,
        filename: job.filename,
        error: job.error,
      });
      const following = flowRef.current.phase === "progress" && flowRef.current.jobDocId === job.docId;
      if (done) {
        toast.success(t("wsV2.toast.done", { company: job.companyName }), {
          description: t("wsV2.toast.doneBody", { file: job.filename }),
          action: following
            ? undefined
            : {
                label: t("wsV2.toast.open"),
                onClick: () => void openPeriod(job.orgId, job.periodId, job.companyName),
              },
        });
        if (following) {
          closeUploadFlow();
          void openPeriod(job.orgId, job.periodId, job.companyName);
        }
      } else {
        toast.error(t("wsV2.toast.failed", { company: job.companyName }), {
          description: job.error ?? undefined,
        });
      }
    }
  }, [jobs, openPeriod, queryClient, t]);

  // ── Analyse ──────────────────────────────────────────────────────────
  const startJob = useCallback(
    async (docId: string, orgId: string, companyName: string, created: boolean) => {
      const file = flowRef.current.file;
      addJob({ docId, orgId, companyName, filename: file?.name ?? "" });
      followJob(docId);
      // The screen and the header follow the file to its company.
      await activateWorkspace(orgId, { name: companyName, listChanged: created });
      navigate(`/workspace/${encodeURIComponent(orgId)}`);
    },
    [navigate],
  );

  const onAnalyse = useCallback(async (opts: { confirmExtra?: boolean } = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await analyseUpload(opts);
      if (outcome.kind === "queued") {
        // A created company is a new row in the list; an adopted workspace
        // is renamed — either way the list is re-read.
        await startJob(outcome.docId, outcome.orgId, outcome.companyName, outcome.created || outcome.adopted);
        return;
      }
      if (outcome.kind === "needs_confirmation") {
        // Nothing was stored: the meter asked first. The same dialog as every
        // other upload asks the user; a confirmed answer sends the commit
        // again (see onExtraConfirmed).
        setConfirmExtra(outcome.confirmation);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, startJob]);

  const onExtraConfirmed = useCallback(() => {
    setConfirmExtra(null);
    // The same commit again, carrying the answer: the engine grants the
    // extra to the document this commit stores (there is no document yet
    // for /api/plan/confirm-extra-doc to grant it to).
    void onAnalyse({ confirmExtra: true });
  }, [onAnalyse]);
  const onExtraClosed = useCallback(() => {
    setConfirmExtra(null);
    returnToConfirm({ code: "cancelled", message: null });
  }, []);

  const open = flow.phase !== "idle";
  const followedJob = flow.phase === "progress" ? jobs.find((j) => j.docId === flow.jobDocId) ?? null : null;

  return (
    <>
      {confirmExtra && (
        <ExtraDocConfirmDialog
          open
          // No stored document to grant the extra to: the confirmation
          // rides on the repeated commit (onExtraConfirmed).
          confirmWith={confirmOnCommit}
          onClose={onExtraClosed}
          onConfirmed={onExtraConfirmed}
          planKey={confirmExtra.planKey}
          docsUsed={confirmExtra.docsUsed}
          docsIncluded={confirmExtra.docsIncluded}
          extraDocEur={confirmExtra.extraDocEur}
          serverMessage={confirmExtra.message || undefined}
        />
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && flow.phase !== "committing") closeUploadFlow();
        }}
      >
        <DialogContent
          className="w-[calc(100vw-24px)] max-w-[520px] gap-0 rounded-md border-rule bg-surface p-0 outline-none focus:outline-none focus-visible:outline-none sm:rounded-md"
          data-testid="upload-card"
          data-phase={flow.phase}
          // Radix would focus the first tabbable — the close cross — and ring
          // it. The card's one primary action should draw the eye instead.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // A drag-and-drop landing outside the card must not close it.
            if (flow.phase === "committing") e.preventDefault();
          }}
        >
          {flow.phase === "identifying" && <ReadingView fileName={flow.file?.name ?? ""} />}
          {(flow.phase === "confirm" || flow.phase === "committing") && flow.result && flow.choice && (
            <ConfirmView
              flow={flow}
              result={flow.result}
              choice={flow.choice}
              saving={flow.phase === "committing" || busy}
              onAnalyse={() => void onAnalyse()}
            />
          )}
          {flow.phase === "duplicate" && flow.duplicate && (
            <DuplicateView
              fileName={flow.file?.name ?? ""}
              companyName={flow.duplicate.companyName}
              onOpen={() => {
                const d = flow.duplicate!;
                closeUploadFlow();
                void openPeriod(d.orgId, d.periodId, d.companyName);
              }}
            />
          )}
          {flow.phase === "error" && <ErrorView flow={flow} />}
          {flow.phase === "progress" && (
            <ProgressView
              job={followedJob}
              onOpen={(job) => {
                closeUploadFlow();
                void openPeriod(job.orgId, job.periodId, job.companyName);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <JobChips jobs={jobs} hidden={flow.phase === "progress"} />
    </>
  );
}

// ── Industries ─────────────────────────────────────────────────────────

interface IndustryOption {
  key: string;
  label: string;
}

/**
 * The industries the card offers, from the SAME catalog the engine labels a
 * new company's industry from (`industry_profiles`, GET /api/industry/
 * profiles), in the reader's language. When the catalog cannot be read the
 * workspace industries stand in, so Change never offers an empty list.
 */
function useIndustryOptions(
  docKey: string | null,
  docLabel: string | null,
  /** The target company's own industry, when the card shows it: it must be
   *  one of the options, or the form could not show what the card says. */
  companyKey: string | null = null,
  companyLabel: string | null = null,
): IndustryOption[] {
  const { i18n } = useTranslation();
  const ro = (i18n.language ?? "").startsWith("ro");
  const catalog = useIndustryCatalog();
  return useMemo(() => {
    const profiles = catalog ?? [];
    const list: IndustryOption[] =
      profiles.length > 0
        ? profiles
            .map((p) => ({ key: p.key, label: (ro ? p.display_name_ro : null) || p.display_name || p.key }))
            .sort((a, b) => a.label.localeCompare(b.label))
        : ORG_INDUSTRIES.map((i) => ({ key: i.key, label: orgIndustryDisplayLabel(i.key) }));
    if (docKey && !list.some((i) => i.key === docKey)) list.unshift({ key: docKey, label: docLabel ?? docKey });
    if (companyKey && companyLabel && !list.some((i) => i.key === companyKey)) {
      list.unshift({ key: companyKey, label: companyLabel });
    }
    return list;
  }, [catalog, ro, docKey, docLabel, companyKey, companyLabel]);
}

// ── Views ──────────────────────────────────────────────────────────────

function CardHeader({ title, fileName }: { title: string; fileName?: string }) {
  return (
    <div className="border-b border-rule-soft px-5 pb-3 pt-5 pr-12">
      <DialogTitle className="text-[16px] font-semibold leading-snug text-ink">{title}</DialogTitle>
      {fileName ? (
        <DialogDescription asChild>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-ink-mute">
            <FileText size={13} strokeWidth={1.75} className="shrink-0" aria-hidden />
            <span className="truncate" data-testid="upload-card-file">{fileName}</span>
          </p>
        </DialogDescription>
      ) : (
        <DialogDescription className="sr-only">{title}</DialogDescription>
      )}
    </div>
  );
}

function ReadingView({ fileName }: { fileName: string }) {
  const { t } = useTranslation();
  return (
    <>
      <CardHeader title={t("wsV2.card.readingTitle")} fileName={fileName} />
      <div className="flex items-center gap-3 px-5 py-8" role="status" data-testid="upload-card-reading">
        <Loader2 size={18} className="animate-spin text-brand-dark dark:text-brand-light" aria-hidden />
        <p className="text-[13px] text-ink-soft">{t("wsV2.card.readingHint")}</p>
      </div>
    </>
  );
}

/** One identified field: label · value · where it came from. */
function FieldRow({
  label,
  value,
  from,
  badge,
  testid,
}: {
  label: string;
  value: string | null;
  from: string | null;
  badge?: React.ReactNode;
  testid: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-0.5 py-2.5 sm:grid-cols-[112px_1fr] sm:gap-3" data-testid={testid}>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute sm:pt-0.5">{label}</dt>
      <dd className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-[14px] font-medium", value ? "text-ink" : "text-ink-mute")} data-testid={`${testid}-value`}>
            {value ?? t("wsV2.card.notFound")}
          </span>
          {badge}
        </div>
        {from && value && (
          <p className="mt-0.5 text-[11.5px] text-ink-mute" data-testid={`${testid}-from`}>
            {from}
          </p>
        )}
      </dd>
    </div>
  );
}

function ConfirmView({
  flow,
  result,
  choice,
  saving,
  onAnalyse,
}: {
  flow: FlowState;
  result: IdentifyResult;
  choice: FlowChoice;
  saving: boolean;
  onAnalyse: () => void;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const { org: activeOrg, orgs } = useActiveOrg();
  const [changing, setChanging] = useState(false);
  const { identity, target } = result;
  const src = identity.sources;
  const blocker = analyseBlocker(choice);

  // Open "Change" by itself when the document leaves a required field blank.
  useEffect(() => {
    if (blocker) setChanging(true);
    // Only on arrival — once open, the user decides when it closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const companyName = choiceCompanyName(choice);
  const chosen = result.companies.find((c) => c.org_id === choice.orgId) ?? null;
  const cui = choice.mode === "new" ? choice.newCui : chosen?.cui ?? identity.cui;

  // Where each value came from — only what the engine SAID. A field it gave
  // no origin for shows none; the card never guesses one.
  const fromPhrase = (signal: string | null | undefined, field?: string) =>
    signal && signal !== "none" ? t(sourceKey(signal, field)) : null;
  const companyFrom = choice.edited.company
    ? t("wsV2.from.user")
    : target.reason === "on_screen_company"
      ? t("wsV2.from.on_screen_company")
      : fromPhrase(src.company_name?.signal ?? src.cui?.signal);
  const cuiFrom = choice.edited.company
    ? choice.mode === "new"
      ? t("wsV2.from.user")
      : t("wsV2.from.company_settings")
    : identity.cui
      ? fromPhrase(src.cui?.signal)
      : t("wsV2.from.company_settings");
  const periodFrom = choice.edited.period ? t("wsV2.from.user") : fromPhrase(src.period_end?.signal, "period_end");
  // The document names no industry and the file goes to a company that
  // already has one: that company keeps it, so the card says so — the
  // company's own industry, "from your company's settings". Words only:
  // a key the catalog cannot name is not shown.
  const targetOrg = choice.mode === "existing" ? orgs.find((o) => o.id === choice.orgId) ?? null : null;
  const companyIndustry = useIndustryLabel(targetOrg?.industry_key ?? null, targetOrg?.industry_display_name ?? null);
  const keepsCompanyIndustry =
    !choice.edited.industry && !choice.industryKey && !choice.industryLabel && !!companyIndustry;
  const industryFrom = choice.edited.industry
    ? t("wsV2.from.user")
    : keepsCompanyIndustry
      ? t("wsV2.from.company_settings")
      : fromPhrase(src.industry_key?.signal ?? src.industry_label?.signal ?? src.caen_code?.signal);

  const periodValue = choice.periodEnd
    ? t("wsV2.card.periodValue", {
        date: formatDateOnly(choice.periodEnd, { day: "numeric", month: "long", year: "numeric" }),
      })
    : null;
  void locale; // re-render on language change (formatDateOnly reads the active locale)
  const industries = useIndustryOptions(
    identity.industry_key,
    identity.industry_label,
    keepsCompanyIndustry ? targetOrg?.industry_key ?? null : null,
    keepsCompanyIndustry ? companyIndustry : null,
  );
  const industryValue = choice.industryKey
    ? industries.find((i) => i.key === choice.industryKey)?.label ?? choice.industryLabel ?? null
    : keepsCompanyIndustry
      ? companyIndustry
      : choice.industryLabel;

  const otherThanOnScreen =
    choice.mode === "existing" &&
    !choice.edited.company &&
    target.reason === "cui_match" &&
    !!flow.onScreenOrgId &&
    choice.orgId !== flow.onScreenOrgId &&
    activeOrg?.id === flow.onScreenOrgId;
  // The plan's company cap (402 workspace_cap_reached): said in words while
  // the file is still headed for a NEW company — never "We couldn't save
  // the file". Choosing one of the user's companies clears it.
  const capReached = flow.error?.code === "cap" && choice.mode === "new" ? flow.error.cap ?? null : null;

  return (
    <>
      <CardHeader title={t("wsV2.card.title")} fileName={flow.file?.name} />
      <div className="max-h-[min(70vh,640px)] overflow-y-auto px-5 py-3 chat-scroll">
        {/* One note at most — the most important thing to read first. */}
        {choice.mode === "new" && target.reason === "adopt_empty_workspace" ? (
          <Note tone="accent" testid="upload-card-adopt-note">{t("wsV2.card.adoptNote")}</Note>
        ) : choice.mode === "new" ? (
          <Note tone="accent" testid="upload-card-new-note">{t("wsV2.card.newCompanyNote")}</Note>
        ) : target.reason === "on_screen_company" && !choice.edited.company ? (
          <Note tone="neutral" testid="upload-card-nocui-note">
            {t("wsV2.card.noCuiNote", { company: companyName })}
          </Note>
        ) : otherThanOnScreen ? (
          <Note tone="neutral" testid="upload-card-other-note">
            {t("wsV2.card.otherCompanyNote", { company: companyName })}
          </Note>
        ) : null}
        {flow.extraFilesIgnored > 0 && (
          <p className="mb-2 text-[11.5px] text-ink-mute">
            {t("wsV2.card.extraFiles", { count: flow.extraFilesIgnored + 1 })}
          </p>
        )}

        <dl className="divide-y divide-rule-soft">
          <FieldRow
            testid="upload-card-company"
            label={t("wsV2.card.company")}
            value={companyName || null}
            from={companyFrom}
            badge={
              choice.mode === "new" ? (
                <span
                  data-testid="upload-card-new-badge"
                  className="inline-flex h-5 items-center rounded-full bg-brand-tint px-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-brand-dark dark:text-brand-light"
                >
                  {t("wsV2.card.newCompany")}
                </span>
              ) : null
            }
          />
          <FieldRow testid="upload-card-cui" label={t("wsV2.card.cui")} value={cui} from={cuiFrom} />
          <FieldRow testid="upload-card-period" label={t("wsV2.card.period")} value={periodValue} from={periodFrom} />
          <FieldRow testid="upload-card-industry" label={t("wsV2.card.industry")} value={industryValue ?? null} from={industryFrom} />
        </dl>

        {changing && (
          <ChangePanel
            result={result}
            choice={choice}
            industries={industries}
            shownIndustryKey={keepsCompanyIndustry ? targetOrg?.industry_key ?? null : null}
          />
        )}

        {blocker && !changing && (
          <p className="mt-2 text-[12px] text-caution" data-testid="upload-card-blocker">
            {blocker === "period" ? t("wsV2.card.pickPeriod") : t("wsV2.card.pickCompany")}
          </p>
        )}
        {capReached && (
          <div
            className="mt-2 rounded-sm bg-caution-tint px-3 py-2.5 text-[12.5px] leading-snug text-ink"
            role="alert"
            data-testid="upload-card-cap"
          >
            <p className="flex items-start gap-1.5">
              <AlertCircle size={14} className="mt-px shrink-0 text-caution" aria-hidden />
              <span data-testid="upload-card-cap-body">
                {t("wsV2.cap.body", { count: capReached.count })} {t("wsV2.cap.hint")}
              </span>
            </p>
            <div className="mt-2 flex flex-wrap gap-2 pl-5">
              <button
                type="button"
                onClick={() => setChanging(true)}
                data-testid="upload-card-cap-choose"
                className="inline-flex h-8 items-center justify-center rounded-sm border border-rule bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-micro hover:bg-bg-2"
              >
                {t("wsV2.cap.choose")}
              </button>
              <Link
                to="/pricing"
                onClick={closeUploadFlow}
                data-testid="upload-card-cap-upgrade"
                className="inline-flex h-8 items-center justify-center rounded-sm bg-brand px-3 text-[12.5px] font-medium text-paper transition-colors duration-micro hover:bg-brand-dark"
              >
                {t("wsV2.cap.upgrade")}
              </Link>
            </div>
          </div>
        )}
        {flow.error && flow.error.code !== "cap" && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] text-alert" role="alert" data-testid="upload-card-error">
            <AlertCircle size={14} className="mt-px shrink-0" aria-hidden />
            <span>
              {flow.error.code === "commit"
                ? t("wsV2.errors.commit")
                : flow.error.code === "cancelled"
                  ? t("wsV2.errors.cancelled")
                  : flow.error.message ?? t("wsV2.errors.commit")}
            </span>
          </p>
        )}
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-rule-soft px-5 py-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={() => setChanging((v) => !v)}
          disabled={saving}
          data-testid="upload-card-change"
          aria-expanded={changing}
          className="inline-flex h-9 items-center justify-center rounded-sm border border-rule px-4 text-[13px] font-medium text-ink transition-colors duration-micro hover:bg-bg-2 disabled:opacity-40"
        >
          {changing ? t("wsV2.card.done") : t("wsV2.card.change")}
        </button>
        <button
          type="button"
          onClick={onAnalyse}
          disabled={saving || !!blocker || !!capReached}
          data-testid="upload-card-analyse"
          className="inline-flex h-9 items-center justify-center gap-2 rounded-sm bg-brand px-5 text-[13px] font-medium text-paper transition-colors duration-micro hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {saving ? t("wsV2.card.saving") : t("wsV2.card.analyse")}
        </button>
      </div>
    </>
  );
}

function Note({ tone, testid, children }: { tone: "accent" | "neutral"; testid: string; children: React.ReactNode }) {
  return (
    <p
      data-testid={testid}
      className={cn(
        "mb-2 rounded-sm px-3 py-2 text-[12.5px] leading-snug",
        tone === "accent" ? "bg-brand-tint text-ink" : "bg-bg-2 text-ink-soft",
      )}
    >
      {children}
    </p>
  );
}

// ── Change ─────────────────────────────────────────────────────────────

const lastDayOfMonth = (year: number, month1: number): string => {
  const d = new Date(Date.UTC(year, month1, 0));
  return d.toISOString().slice(0, 10);
};

function ChangePanel({
  result,
  choice,
  industries,
  shownIndustryKey,
}: {
  result: IdentifyResult;
  choice: FlowChoice;
  industries: IndustryOption[];
  /** The company's own industry the card shows ("from your company's
   *  settings") while the user has chosen none: the form starts from it. */
  shownIndustryKey: string | null;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const { orgs } = useActiveOrg();

  // The identify answer lists my companies (with their CUIs); the live
  // workspace list is the fallback when it came back empty.
  const companies = useMemo(() => {
    if (result.companies.length > 0) return result.companies;
    return orgs.map((o) => ({ org_id: o.id, name: o.name, cui: null as string | null }));
  }, [result.companies, orgs]);

  const now = new Date();
  const periodDate = choice.periodEnd ? new Date(`${choice.periodEnd}T00:00:00Z`) : null;
  const month = periodDate ? periodDate.getUTCMonth() + 1 : 12;
  const year = periodDate ? periodDate.getUTCFullYear() : now.getUTCFullYear() - 1;
  const years = useMemo(() => {
    const top = now.getUTCFullYear();
    const out: number[] = [];
    for (let y = top; y >= top - 12; y--) out.push(y);
    if (!out.includes(year)) out.push(year);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);
  const monthNames = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) =>
        new Date(Date.UTC(2000, i, 1)).toLocaleDateString(locale, { month: "long", timeZone: "UTC" }),
      ),
    [locale],
  );

  const setPeriod = (y: number, m: number) =>
    updateChoice({ periodEnd: lastDayOfMonth(y, m), edited: { ...choice.edited, period: true } });

  const field = "h-9 w-full rounded-sm border border-rule bg-surface px-2.5 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40";
  const label = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute";

  return (
    <div className="mt-3 space-y-4 rounded-md border border-rule bg-bg-2/60 p-3.5" data-testid="upload-card-change-panel">
      <fieldset>
        <legend className={label}>{t("wsV2.change.company")}</legend>
        <div className="space-y-1" role="radiogroup">
          {companies.map((c) => {
            const selected = choice.mode === "existing" && choice.orgId === c.org_id;
            return (
              <label
                key={c.org_id}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-[13px] transition-colors duration-micro",
                  selected ? "bg-brand-tint" : "hover:bg-bg-2",
                )}
              >
                <input
                  type="radio"
                  name="upload-company"
                  checked={selected}
                  onChange={() =>
                    updateChoice({
                      mode: "existing",
                      orgId: c.org_id,
                      orgName: c.name,
                      edited: { ...choice.edited, company: true },
                    })
                  }
                  data-testid={`upload-change-company-${c.org_id}`}
                  className="accent-brand"
                />
                <span className="min-w-0 flex-1 truncate text-ink">{c.name}</span>
                {c.cui && <span className="shrink-0 font-mono text-[11px] text-ink-mute">{c.cui}</span>}
              </label>
            );
          })}
          <label
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-[13px] transition-colors duration-micro",
              choice.mode === "new" ? "bg-brand-tint" : "hover:bg-bg-2",
            )}
          >
            <input
              type="radio"
              name="upload-company"
              checked={choice.mode === "new"}
              onChange={() =>
                updateChoice({
                  mode: "new",
                  orgId: null,
                  edited: { ...choice.edited, company: true },
                })
              }
              data-testid="upload-change-company-new"
              className="accent-brand"
            />
            <span className="text-ink">{t("wsV2.change.newCompany")}</span>
          </label>
        </div>
        {choice.mode === "new" && (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_160px]">
            <label className="block">
              <span className={label}>{t("wsV2.change.newName")}</span>
              <input
                type="text"
                value={choice.newName}
                onChange={(e) => updateChoice({ newName: e.currentTarget.value, edited: { ...choice.edited, company: true } })}
                data-testid="upload-change-new-name"
                className={field}
              />
            </label>
            <label className="block">
              <span className={label}>{t("wsV2.change.newCui")}</span>
              <input
                type="text"
                inputMode="numeric"
                value={choice.newCui ?? ""}
                onChange={(e) =>
                  updateChoice({ newCui: e.currentTarget.value.trim() || null, edited: { ...choice.edited, company: true } })
                }
                data-testid="upload-change-new-cui"
                className={cn(field, "font-mono")}
              />
            </label>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className={label}>{t("wsV2.change.period")}</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="sr-only">{t("wsV2.change.month")}</span>
            <select
              value={choice.periodEnd ? month : ""}
              onChange={(e) => setPeriod(year, Number(e.currentTarget.value))}
              data-testid="upload-change-month"
              className={field}
            >
              {!choice.periodEnd && <option value="">{t("wsV2.change.month")}</option>}
              {monthNames.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="sr-only">{t("wsV2.change.year")}</span>
            <select
              value={choice.periodEnd ? year : ""}
              onChange={(e) => setPeriod(Number(e.currentTarget.value), month)}
              data-testid="upload-change-year"
              className={cn(field, "tabular-nums")}
            >
              {!choice.periodEnd && <option value="">{t("wsV2.change.year")}</option>}
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      <label className="block">
        <span className={label}>{t("wsV2.change.industry")}</span>
        <select
          // The value the card shows: the choice, else the company's own
          // industry (live walkthrough, 2026-09-26: the form read "Not set"
          // under a summary naming the company's industry). Showing it sends
          // nothing — only a change the user makes is a choice.
          value={choice.industryKey ?? shownIndustryKey ?? ""}
          onChange={(e) => {
            const key = e.currentTarget.value || null;
            const hit = industries.find((i) => i.key === key);
            updateChoice({
              industryKey: key,
              industryLabel: hit?.label ?? null,
              edited: { ...choice.edited, industry: true },
            });
          }}
          data-testid="upload-change-industry"
          className={field}
        >
          {/* An upload cannot clear a company's industry, so "Not set" is not
              offered over one — it would read as a choice that does nothing. */}
          {!(choice.mode === "existing" && shownIndustryKey) && (
            <option value="">{t("wsV2.change.industryNone")}</option>
          )}
          {industries.map((i) => (
            <option key={i.key} value={i.key}>
              {i.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// ── Duplicate / error ──────────────────────────────────────────────────

function DuplicateView({
  fileName,
  companyName,
  onOpen,
}: {
  fileName: string;
  companyName: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <CardHeader title={t("wsV2.duplicate.title")} fileName={fileName} />
      <div className="px-5 py-5" data-testid="upload-card-duplicate">
        <p className="text-[13px] leading-relaxed text-ink-soft">
          {t("wsV2.duplicate.body", { company: companyName })}
        </p>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-rule-soft px-5 py-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={closeUploadFlow}
          className="inline-flex h-9 items-center justify-center rounded-sm border border-rule px-4 text-[13px] font-medium text-ink hover:bg-bg-2"
        >
          {t("wsV2.card.close")}
        </button>
        <button
          type="button"
          onClick={onOpen}
          data-testid="upload-card-duplicate-open"
          className="inline-flex h-9 items-center justify-center rounded-sm bg-brand px-5 text-[13px] font-medium text-paper hover:bg-brand-dark"
        >
          {t("wsV2.duplicate.open")}
        </button>
      </div>
    </>
  );
}

function ErrorView({ flow }: { flow: FlowState }) {
  const { t } = useTranslation();
  const code = flow.error?.code;
  // A file no reader opens: the title says so, and the body is the ENGINE's
  // sentence — what the file really is and what fixes it — in the reader's
  // language (one upload policy: engine/api/_upload_type).
  const wrongKind = code === "wrong_kind" ? t("wsV2.errors.wrongKindTitle") : null;
  const message =
    wrongKind ??
    (code === "unsupported"
      ? t("wsV2.errors.unsupported")
      : flow.error?.message && /failed to fetch|networkerror|load failed/i.test(flow.error.message)
        ? t("wsV2.errors.offline")
        : t("wsV2.errors.identify"));
  const final = code === "unsupported" || code === "wrong_kind";
  return (
    <>
      <CardHeader title={message} fileName={flow.file?.name} />
      <div className="px-5 py-5" data-testid="upload-card-error-view" data-error-code={code}>
        <p className="flex items-start gap-2 text-[13px] text-ink-soft">
          <AlertCircle size={15} className="mt-px shrink-0 text-alert" aria-hidden />
          <span>
            {code === "unsupported"
              ? t("wsV2.errors.unsupported")
              : code === "wrong_kind"
                ? flow.error?.message ?? t("wsV2.errors.identify")
                : flow.error?.message ?? message}
          </span>
        </p>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-rule-soft px-5 py-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={closeUploadFlow}
          className={cn(
            "inline-flex h-9 items-center justify-center rounded-sm px-4 text-[13px] font-medium",
            final ? "bg-brand text-paper hover:bg-brand-dark" : "border border-rule text-ink hover:bg-bg-2",
          )}
        >
          {t("wsV2.card.close")}
        </button>
        {!final && (
          <button
            type="button"
            onClick={retryIdentify}
            data-testid="upload-card-retry"
            className="inline-flex h-9 items-center justify-center rounded-sm bg-brand px-5 text-[13px] font-medium text-paper hover:bg-brand-dark"
          >
            {t("wsV2.card.tryAgain")}
          </button>
        )}
      </div>
    </>
  );
}

// ── Progress ───────────────────────────────────────────────────────────

export function ProgressView({ job, onOpen }: { job: AnalysisJob | null; onOpen: (job: AnalysisJob) => void }) {
  const { t } = useTranslation();
  if (!job) {
    return (
      <>
        <CardHeader title={t("wsV2.card.readingTitle")} />
        <div className="px-5 py-8">
          <Loader2 size={18} className="animate-spin text-brand-dark dark:text-brand-light" aria-hidden />
        </div>
      </>
    );
  }
  const failed = job.status === "failed";
  const done = job.status === "analyzed";
  // The step on screen: the running one, or — failed — the one the document
  // was on when it failed (the earlier steps stay done).
  const ordinal = failed ? Math.min(job.failedStep ?? 0, ANALYSIS_STEP_COUNT - 1) : stepOrdinal(job.status);
  const current = Math.min(ordinal + 1, ANALYSIS_STEP_COUNT);
  const title = failed
    ? t("wsV2.progress.failedTitle", { company: job.companyName })
    : done
      ? t("wsV2.progress.doneTitle", { company: job.companyName })
      : t("wsV2.progress.title", { company: job.companyName });

  return (
    <>
      <CardHeader title={title} fileName={job.filename} />
      <div className="px-5 py-4" data-testid="upload-card-progress" data-status={job.status}>
        {!failed && !done && (
          <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute" data-testid="upload-progress-step">
            {t("wsV2.progress.step", { n: current, total: ANALYSIS_STEP_COUNT })}
          </p>
        )}
        <ol className="space-y-2.5">
          {Array.from({ length: ANALYSIS_STEP_COUNT }, (_, i) => {
            const stepDone = done || i < ordinal;
            const running = !failed && !done && i === ordinal;
            const broke = failed && i === ordinal;
            return (
              <li
                key={i}
                className="flex items-center gap-3 text-[13px]"
                data-testid={`upload-progress-step-${i}`}
                data-state={stepDone ? "done" : running ? "running" : broke ? "failed" : "waiting"}
              >
                <span
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full border",
                    stepDone && "border-brand bg-brand-tint text-brand-dark dark:text-brand-light",
                    running && "border-brand text-brand-dark dark:text-brand-light",
                    broke && "border-alert/50 bg-alert-tint text-alert",
                    !stepDone && !running && !broke && "border-rule text-ink-mute",
                  )}
                >
                  {stepDone ? (
                    <Check size={13} strokeWidth={2.5} aria-hidden />
                  ) : running ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden />
                  ) : broke ? (
                    <X size={13} strokeWidth={2.5} aria-hidden />
                  ) : (
                    <span className="font-mono text-[10.5px] tabular-nums">{i + 1}</span>
                  )}
                </span>
                <span className={cn(stepDone || running ? "text-ink" : "text-ink-mute", running && "font-medium")}>
                  {t(`wsV2.progress.steps.${i}`)}
                </span>
              </li>
            );
          })}
        </ol>
        {failed && job.error && (
          <p className="mt-4 rounded-sm bg-alert-tint px-3 py-2 text-[12.5px] text-alert" role="alert">
            {job.error}
          </p>
        )}
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-rule-soft px-5 py-3 sm:flex-row sm:justify-end">
        {done ? (
          <button
            type="button"
            onClick={() => onOpen(job)}
            data-testid="upload-progress-open"
            className="inline-flex h-9 items-center justify-center rounded-sm bg-brand px-5 text-[13px] font-medium text-paper hover:bg-brand-dark"
          >
            {t("wsV2.progress.open")}
          </button>
        ) : (
          <button
            type="button"
            onClick={closeUploadFlow}
            data-testid="upload-progress-background"
            className="inline-flex h-9 items-center justify-center rounded-sm border border-rule px-4 text-[13px] font-medium text-ink hover:bg-bg-2"
          >
            {failed ? t("wsV2.card.close") : t("wsV2.progress.background")}
          </button>
        )}
      </div>
    </>
  );
}

/** Running analyses while the card is closed — one quiet chip each. */
function JobChips({ jobs, hidden }: { jobs: AnalysisJob[]; hidden: boolean }) {
  const { t } = useTranslation();
  const running = jobs.filter((j) => !isJobDone(j));
  if (hidden || running.length === 0) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-32px)] flex-col items-end gap-2"
      data-testid="upload-job-chips"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {running.map((job) => (
        <button
          key={job.docId}
          type="button"
          onClick={() => showJobInFlow(job.docId)}
          data-testid="upload-job-chip"
          className="inline-flex max-w-full items-center gap-2 rounded-full border border-rule bg-surface px-3.5 py-2 text-[12.5px] text-ink shadow-md transition-colors hover:bg-bg-2"
        >
          <Loader2 size={13} className="shrink-0 animate-spin text-brand-dark dark:text-brand-light" aria-hidden />
          <span className="truncate">
            {t("wsV2.progress.chip", {
              company: job.companyName,
              n: Math.min(stepOrdinal(job.status) + 1, ANALYSIS_STEP_COUNT),
              total: ANALYSIS_STEP_COUNT,
            })}
          </span>
        </button>
      ))}
    </div>
  );
}
