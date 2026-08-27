// Workspace.tsx — workspace hub + first-run onboarding.
//
// The tab styling mirrors the Dashboard's pre-upload hero (Sparkles eyebrow,
// large semibold headline with a teal accent, supporting paragraph) via the
// shared `PageHeader` in `hero` mode.
//
// Onboarding (3 steps):
//   1. Name the workspace           — text input, persisted locally.
//   2. Decision rules               — the DecisionRules controls rendered
//                                     INLINE (not as a modal) via the shared
//                                     <DecisionRulesPanel/>.
//   3. Upload files                 — a dropzone that posts the workbook to
//                                     the SKU pipeline (same call the upload
//                                     dialog uses).
//
// Once completed (or skipped) the page shows the workspace hub: the loaded
// company/period + quick-access cards into every analysis view. A "Restart
// setup" link re-runs the flow.

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import { NavLink, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Clock,
  Cloud,
  FileSpreadsheet,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  UploadCloud,
  Eye,
} from "lucide-react";
import { openUploadedFilePreview } from "@/lib/stagedFilePreview";
import { getSupabase } from "@/lib/supabase";
import { SourceFilesRow } from "@/components/cfo/SourceFilesRow";
import { startWorkspaceSwitch } from "@/lib/periodSwitch";
import { setUnsavedGuard } from "@/lib/unsavedGuard";

import { PageHeader } from "@/components/cfo/ui/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DecisionRulesPanel } from "@/components/cfo/command/DecisionRulesModal";
import { WorkspaceSettingsV2 } from "@/components/cfo/workspace/WorkspaceSettingsV2";
import { OrgIndustryPills, orgIndustryDisplayLabel, orgIndustryLabel } from "@/components/cfo/OrgIndustryPills";
import { toast } from "@/components/ui/sonner";
import { periodQueryKey, useActivePeriod } from "@/lib/activePeriod";
import {
  createEmptyPeriod,
  deleteEmptyPeriod,
  fetchWorkspacePeriodsDirect,
  formatPeriodMonth,
  formatPeriodMonthLoose,
  isImplausiblePeriod,
  isCurrentMonthPeriod,
  type OrgPeriod,
  type OrgPeriodsPayload,
} from "@/lib/orgPeriods";
import { forgetPeriodVerdictFor } from "@/lib/dataPresence";
import { uploadExcelToBackend } from "@/lib/api";
import { useUploadEnqueue } from "@/hooks/useUploadEnqueue";
import { pickActiveSourceDoc } from "@/lib/activeSourceDoc";
import { setActiveRun, setAnalysis, setUploadAlerts } from "@/lib/runStore";
import {
  readDecisionRules,
  resetDecisionRulesToDefaults,
  useDecisionRules,
  writeDecisionRules,
} from "@/lib/decisionRulesStore";
import type { DecisionRulesState } from "@/lib/decisionRules";
import { lastWorkspaceCreateHitLimit, updateActiveOrg } from "@/lib/org";
import { usePlanState, workspaceCapReached } from "@/lib/planState";
import { readWorkspaceName, writeWorkspaceName } from "@/lib/workspaceName";
import { setPref, usePrefSync } from "@/lib/prefs";
import { useWorkspaces, type Workspace } from "@/lib/workspaces";

// ── Local persistence — the "onboarding done" flag lives in the browser.
//    The workspace name is owned by lib/workspaceName (shared with the
//    TopHeader tagline, which reflects it live).
const ONBOARDED_KEY = "cfoai:v1:workspace-onboarded";
/** Key inside `org_prefs.prefs` — see supabase/schema_phase_prefs.sql. */
const ONBOARDED_PREF_KEY = "workspace_onboarded";

function readDone(): boolean {
  try { return localStorage.getItem(ONBOARDED_KEY) === "1"; } catch { return false; }
}
function writeDone(v: boolean) {
  try {
    if (v) localStorage.setItem(ONBOARDED_KEY, "1");
    else localStorage.removeItem(ONBOARDED_KEY);
  } catch { /* private mode — fail soft */ }
}

export default function Workspace() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [done, setDone] = useState<boolean>(readDone);
  // Tracks whether the current onboarding run is creating a NEW workspace
  // (→ add a fresh entry on finish) vs. restarting the current one
  // (→ rename the existing entry).
  const [creatingNew, setCreatingNew] = useState(false);
  // Which workspace (if any) is open in the settings "tab". Lifted here so the
  // settings view gets its OWN page header + description (replacing the hub
  // header) rather than rendering underneath it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const ws = useWorkspaces();
  const period = useActivePeriod();
  const editingWorkspace = editingId ? ws.workspaces.find((w) => w.id === editingId) ?? null : null;

  // 2026-08 tier restructure — plan workspace cap. Pre-flight check from
  // plan state; FAILS OPEN (no plan state ⇒ never blocks) because the
  // `create_workspace` RPC's SQL hard floor is the real enforcement.
  const { state: planState } = usePlanState();
  const atWorkspaceCap = workspaceCapReached(planState, ws.workspaces.length);

  function showWorkspaceLimitToast() {
    toast.error(t("pricing.workspaceLimitTitle"), {
      description: t("pricing.workspaceLimitDesc", {
        max: planState?.max_workspaces ?? ws.workspaces.length,
      }),
      action: {
        label: t("pricing.workspaceLimitCta"),
        onClick: () => navigate("/pricing"),
      },
    });
  }

  // Start a brand-new workspace: clear the name and re-enter onboarding. The
  // new entry is only committed to the list on finish (in onDone below).
  function startNewWorkspace() {
    if (atWorkspaceCap) {
      showWorkspaceLimitToast();
      return;
    }
    setCreatingNew(true);
    writeWorkspaceName("");
    writeDone(false);
    setDone(false);
  }

  function finishOnboarding(industry: OnboardingIndustry | null) {
    const name = readWorkspaceName();
    // `creatingNew` OR "no active workspace yet" (the very first one) both take
    // the create path so the industry is written onto the organizations row
    // ATOMICALLY. The old first-run path (upsertCurrentName + a follow-up
    // updateActiveOrg) created the row WITHOUT industry — updateActiveOrg then
    // no-op'd because cachedOrg was still null — leaving industry_key null.
    // That tripped the AuthGuard/needsOnboarding wizard re-entry, so the user
    // had to click "I'll upload later" twice. One create-with-industry avoids it.
    if (creatingNew || !ws.current) {
      // create_workspace() stores the industry on the new organizations row,
      // so AuthGuard doesn't bounce the fresh workspace to /onboarding.
      // The RPC enforces the plan's workspace cap as a SQL hard floor —
      // if a stale tab slips past the pre-flight gate, surface the same
      // upgrade prompt instead of failing silently.
      void ws.create(name, industry).then((id) => {
        if (!id && lastWorkspaceCreateHitLimit()) showWorkspaceLimitToast();
      });
    } else {
      void ws.upsertCurrentName(name);
      // Restart run on the current workspace — persist a changed industry the
      // same way /onboarding does. Separate call from the rename on purpose:
      // both target different columns of the same row, so neither clobbers.
      if (industry && industry.key !== ws.current?.industryKey) {
        void updateActiveOrg({
          industry_key: industry.key,
          industry_display_name: industry.label,
        });
      }
    }
    setCreatingNew(false);
    writeDone(true);
    setDone(true);
    // Per WORKSPACE, not per user: a newly added SRL should run its own setup
    // rather than inherit "already onboarded" from the previous company.
    setPref("org", ONBOARDED_PREF_KEY, true);
  }

  // Adopt the flag for whichever workspace is active (another device, or a
  // workspace this browser has never opened).
  const adoptOnboarded = useCallback((remote: boolean) => {
    writeDone(remote === true);
    setDone(remote === true);
  }, []);
  usePrefSync<boolean>("org", ONBOARDED_PREF_KEY, done, adoptOnboarded);

  // Settings "tab" — the workspace rail STAYS on the left (2026-07-26 per
  // operator: "always display the list of workspaces"). Opening a workspace's
  // settings used to return a single-column page that replaced the hub, so the
  // switcher vanished and the only way back to another company was the "All
  // workspaces" link. Same two-column shape as the hub below, with the
  // settings panel in place of the selected-workspace summary.
  if (editingWorkspace) {
    return (
      // Pulled up and in (2026-07-26 per operator): AppShell pads every page
      // with py-6→12 / px-4→10, which on this two-column screen left the rail
      // floating well below the header and away from the sidebar. Negative
      // margins claw back part of that padding for THIS page only, so the
      // shared shell spacing stays correct everywhere else.
      <section
        className="max-w-[1280px] space-y-8 -mt-4 sm:-mt-6 lg:-mt-8 lg:-ml-6"
        data-testid="workspace-page"
      >
        <div className="flex flex-col lg:flex-row gap-8 items-start">
          <div className="w-full lg:w-[260px] lg:shrink-0">
            <WorkspaceHub
              // Switching rows inside settings keeps you in settings, now
              // showing the workspace you just picked.
              onEdit={(id) => { ws.select(id); setEditingId(id); }}
              onCreate={startNewWorkspace}
            />
          </div>

          <div className="w-full flex-1 min-w-0 space-y-8">
            <PageHeader
              hero
              eyebrow={t("ws.settingsEyebrow")}
              title={
                <Trans
                  i18nKey="ws.manageTitle"
                  values={{ name: editingWorkspace.name || t("ws.thisWorkspace") }}
                  components={{ grad: <span className="text-grad" /> }}
                />
              }
              subtitle={t("ws.settingsSubtitleEdit")}
            />
            <WorkspaceSettingsV2
              workspace={editingWorkspace}
              canDelete={ws.canDelete}
              onBack={() => setEditingId(null)}
              onRename={(name) => { void ws.rename(editingWorkspace.id, name); }}
              onChangeIndustry={(key) => { void ws.setIndustry(editingWorkspace.id, key, orgIndustryLabel(key)); }}
              onDelete={() => {
                const name = editingWorkspace.name;
                setEditingId(null);
                void ws.remove(editingWorkspace.id).then((ok) => {
                  toast[ok ? "success" : "error"](
                    ok
                      ? t("ws.deletedRestorable", { name: name || t("ws.workspaceFallback") })
                      : t("ws.cantDeleteWorkspace"),
                  );
                });
              }}
            />
          </div>
        </div>
      </section>
    );
  }

  // AuthGuard bounces EVERY non-/workspace route back here while the ACTIVE
  // org has no industry_key (`needsOnboarding`). If we render the hub in that
  // state, the user is trapped: forced to /workspace but never shown the setup
  // wizard that sets industry_key and releases the guard — so every sidebar tab
  // just bounces back and the app feels frozen. Mirror the guard's exact
  // condition here: when the active workspace still needs onboarding, force the
  // wizard regardless of the local `done` flag (which can be stale-true via the
  // adopted `workspace_onboarded` org-pref even when industry_key was never set).
  const activeNeedsOnboarding = !!ws.current && !ws.current.industryKey;

  // A brand-new account: signup auto-created exactly one workspace, it still
  // needs setup, nothing is archived, and the user isn't adding a second one.
  // The rail is hidden here — there is nothing to switch BETWEEN, so a
  // vertical list holding "Create workspace" plus the single workspace the
  // wizard is already setting up is just noise beside the form.
  //
  // Every other reason this branch renders still gets the rail, which is why
  // this is deliberately narrow rather than `!done`:
  //   · archived.length > 0 — deleted their last workspace; the rail is the
  //     only route back to "Recently deleted" within the 30-day window
  //   · workspaces.length > 1 — a real switcher
  //   · creatingNew — adding one alongside existing companies
  const isFirstRun =
    !creatingNew
    && ws.archived.length === 0
    && ws.workspaces.length <= 1
    && activeNeedsOnboarding;

  return (
    <section className="max-w-[1280px] space-y-8" data-testid="workspace-page">
      {/* With zero workspaces (e.g. the user deleted them all) drop straight
          into the create-workspace flow instead of a landing hero. Keep the hub
          while the list is still loading or when workspaces exist, so users who
          have workspaces never see the create form flash.

          2026-08-02: an industry-less ACTIVE workspace only forces the wizard
          when it's a genuine first run (one workspace, nothing archived).
          Multi-workspace users — or anyone with a Recently-deleted shelf —
          get the hub, where industry is one field in the settings panel;
          trapping them in the wizard hid the rail (their only path to
          Restore) and re-ran setup they'd already done elsewhere. */}
      {ws.loadError ? (
        /* List FETCH failed — a user with workspaces would otherwise see the
           create wizard and make a duplicate. Retry re-runs the RPC. */
        <div
          className="max-w-[480px] rounded-xl border border-rule bg-surface px-6 py-8 text-center mx-auto"
          data-testid="workspace-load-error"
        >
          <p className="text-[14px] font-medium text-ink mb-1.5">
            {t("ws.loadErrorTitle")}
          </p>
          <p className="text-[12.5px] text-ink-soft mb-4">
            {t("ws.loadErrorBody")}
          </p>
          <button
            type="button"
            onClick={() => void ws.refresh()}
            data-testid="workspace-load-retry"
            className="inline-flex items-center justify-center h-9 px-4 rounded-lg border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : done &&
      !(activeNeedsOnboarding && ws.workspaces.length <= 1 && ws.archived.length === 0) &&
      (ws.loading || ws.workspaces.length > 0) ? (
        // Two-column layout (2026-07-26 per operator): the workspace switcher
        // becomes a narrow vertical rail on the left, the selected workspace's
        // settings fill the rest. Stacks under lg, where a 260px rail beside a
        // dense settings form stops being readable.
        <div className="flex flex-col lg:flex-row gap-8 items-start">
          <div className="w-full lg:w-[260px] lg:shrink-0">
            <WorkspaceHub
              onEdit={(id) => { ws.select(id); setEditingId(id); }}
              onCreate={startNewWorkspace}
            />
          </div>

          {/* Title reflects the selected workspace; its edit tab renders
              directly beneath it. Gated on !ws.loading so it doesn't flash the
              "Manage" section for a stale active id during the initial resolve
              (the active id is only nulled once the workspace list resolves). */}
          <div className="w-full flex-1 min-w-0">
          {!ws.loading && ws.current && (
            <SelectedWorkspacePanel
              workspace={ws.current}
              canDelete={ws.canDelete}
              onRename={(name) => { if (ws.current) void ws.rename(ws.current.id, name); }}
              onChangeIndustry={(key) => { if (ws.current) void ws.setIndustry(ws.current.id, key, orgIndustryLabel(key)); }}
              onDelete={() => {
                const cur = ws.current;
                if (!cur) return;
                void ws.remove(cur.id).then((ok) => {
                  toast[ok ? "success" : "error"](
                    ok
                      ? t("ws.deletedRestorable", { name: cur.name || t("ws.workspaceFallback") })
                      : t("ws.cantDeleteWorkspace"),
                  );
                });
              }}
            />
          )}
          </div>
        </div>
      ) : (
        // The setup wizard keeps the workspace rail beside it whenever there
        // is anything to list (2026-07-26 per operator). Deleting your last
        // active workspace drops you here, and without the rail the ones
        // sitting in "Recently deleted" were unreachable — so a soft delete
        // that is supposed to be restorable for 30 days became effectively
        // permanent, with the wizard insisting you start over instead.
        // Hidden only on a true first run (nothing active, nothing archived),
        // where an empty rail would just crowd the wizard.
        <div className="flex flex-col lg:flex-row gap-8 items-start">
          {!isFirstRun && (ws.workspaces.length > 0 || ws.archived.length > 0) && (
            <div className="w-full lg:w-[260px] lg:shrink-0">
              <WorkspaceHub
                onEdit={(id) => { ws.select(id); setEditingId(id); }}
                onCreate={startNewWorkspace}
                // Only when the wizard is genuinely CREATING one. It used to
                // be unconditional, but this branch also renders when an
                // EXISTING workspace still needs onboarding
                // (`activeNeedsOnboarding` — true for the workspace auto-
                // created at signup, which has no industry_key yet). In that
                // case nothing is being created, so marking "Create
                // workspace" as selected left a brand-new account looking at
                // a rail where its own workspace was never the selected item
                // and appeared unreachable. With `creatingNew`, the rail
                // falls back to `w.id === currentId` and the auto-created
                // workspace reads as selected, which is what it is.
                createActive={creatingNew}
                // Picking a workspace closes the wizard and shows it. Only
                // possible when that workspace is itself set up — one that
                // still needs onboarding re-enters the wizard by design
                // (`activeNeedsOnboarding`), which is what stops the app
                // trapping the user on a workspace with no industry set.
                onSelected={() => { setCreatingNew(false); writeDone(true); setDone(true); }}
              />
            </div>
          )}

          <div className="flex-1 min-w-0 space-y-8">
            <PageHeader
              hero
              eyebrow={t("sidebar.workspace")}
              title={<Trans i18nKey="ws.setupTitle" components={{ grad: <span className="text-grad" /> }} />}
              subtitle={t("ws.setupSubtitle")}
            />
            <Onboarding
              onDone={finishOnboarding}
              // A restart on the current workspace prefills its industry; a
              // brand-new SRL starts blank and must pick its own.
              initialIndustryKey={creatingNew ? null : (ws.current?.industryKey ?? null)}
              // Back from the first step returns to the workspaces screen.
              // Only offered when there IS one to return to and the active
              // workspace isn't itself mid-onboarding — otherwise the hub's own
              // guard (`done && !activeNeedsOnboarding` above) would re-enter the
              // wizard on the very next render and the button would read as
              // broken.
              canExit={ws.workspaces.length > 0 && !activeNeedsOnboarding}
              onExit={() => { setCreatingNew(false); writeDone(true); setDone(true); }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Onboarding wizard ───────────────────────────────────────────────────────

const STEP_KEYS = ["ws.stepName", "ws.stepRules", "ws.stepUpload"] as const;

export interface OnboardingIndustry {
  key: string;
  label: string;
}

function Onboarding({
  onDone,
  onExit,
  canExit = false,
  initialIndustryKey = null,
}: {
  onDone: (industry: OnboardingIndustry | null) => void;
  onExit?: () => void;
  /** Show the step-0 "All workspaces" exit. False when the user has nowhere to
   *  go back to, or when the active workspace still needs onboarding (leaving
   *  would re-enter the wizard on the next render — a dead button). */
  canExit?: boolean;
  /** Prefill when restarting setup on a workspace that already has one. */
  initialIndustryKey?: string | null;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [name, setName] = useState<string>(readWorkspaceName);
  const [industryKey, setIndustryKey] = useState<string | null>(initialIndustryKey);
  const [busy, setBusy] = useState(false);
  // For the "Skip for now — open the dashboard" escape (2026-08-02).
  const navigate = useNavigate();
  // For the trial-balance reroute below — quota/extra-doc dialogs included.
  const uploadEnqueue = useUploadEnqueue();

  // What finishOnboarding writes to organizations.industry_key /
  // industry_display_name — the same pair /onboarding saves.
  const industry: OnboardingIndustry | null = industryKey
    ? { key: industryKey, label: orgIndustryLabel(industryKey) }
    : null;

  function next() {
    // Advancing steps must NOT commit the workspace name — writing it here made
    // the TopHeader tagline (useWorkspaceName) flip to the new workspace the
    // instant the user pressed Continue, reading as if the not-yet-created
    // workspace was already selected. The name is committed only at finish
    // (`finish()` below) — i.e. after step 3's upload or "I'll upload later".
    setStep((s) => (Math.min(2, s + 1) as 0 | 1 | 2));
  }
  function back() {
    // At the first step, Back leaves onboarding entirely and returns to the
    // workspace listing (when there is one — see `onExit` in the parent).
    if (step === 0) { onExit?.(); return; }
    setStep((s) => (Math.max(0, s - 1) as 0 | 1 | 2));
  }

  // Commit the workspace: persist the name so the parent's finishOnboarding
  // (which reads readWorkspaceName()) creates/renames the row with it, then
  // hand off. This is the ONLY place the new workspace becomes real/selected —
  // reached from step 3's successful upload or the "I'll upload later" button.
  function finish() {
    writeWorkspaceName(name.trim());
    onDone(industry);
  }

  // Trial-balance reroute (2026-08-04, operator hit this on mobile): the
  // wizard's step-3 dropzone feeds the SKU/trading parser, but the single
  // most common first upload is a balanță de verificare. The old behavior
  // was a dead-end English error telling the user to go find the Dashboard
  // themselves. Now: when the backend flags the trial-balance shape, we
  // finish onboarding and hand the SAME file to the financial pipeline
  // (uploadDocument → enqueue — exactly the Dashboard's own path), then
  // land on the Dashboard where the scan progress takes over.
  async function routeTrialBalanceToDashboard(file: File): Promise<void> {
    const [{ uploadDocument }, { startUpload, patchUpload, clearUpload }] = await Promise.all([
      import("@/lib/supabase"),
      import("@/lib/uploadStore"),
    ]);
    startUpload({ docId: "", filename: file.name, status: "queued" });
    const { row, error } = await uploadDocument(file, { scope: "financial" });
    if (!row) {
      clearUpload();
      throw new Error(error ?? t("dash.unknownError"));
    }
    startUpload({ docId: row.id, filename: file.name, status: "queued" });
    const enq = await uploadEnqueue.enqueue(row.id);
    if (enq.kind !== "queued") {
      const reason =
        enq.kind === "quota_blocked" || enq.kind === "non_ro_blocked" || enq.kind === "transport_failed"
          ? enq.message
          : t("dash.uploadCancelled");
      patchUpload({ status: "failed", error: reason });
      throw new Error(reason);
    }
    toast.success(t("ws.tbRoutedTitle"), {
      description: t("ws.tbRoutedDesc", { filename: file.name }),
    });
    finish();
    navigate("/dashboard");
  }

  // Same call the upload dialog uses — posts the workbook to the SKU pipeline
  // and seeds the run store so Products / decision rules light up with data.
  async function handleUpload(file: File) {
    setBusy(true);
    try {
      const result = await uploadExcelToBackend(file);
      setActiveRun(
        result.run,
        {
          fileName: result.file_name,
          rowCount: result.transaction_rows,
          uploadedAt: new Date().toISOString(),
        },
        result.raw_rows.map((r) => ({
          sku: r.sku,
          category: r.category,
          volumeT: r.volume_tons,
          revenue: r.revenue_kron,
          grossMarginPct: r.gross_margin_pct,
          dioDays: 90,
          strategicFlag: false,
        })),
      );
      setAnalysis({ ...result.analysis, generatedAt: new Date().toISOString() });
      setUploadAlerts(result.alerts ?? null);
      const skuCount = result.skus?.sku_count ?? 0;
      toast.success(t("ws.workbookImported"), {
        description: t("ws.workbookImportedDesc", { count: skuCount }),
      });
      finish();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("productsX.toast.uploadFailed");
      // Backend flagged a trial balance ([TRIAL_BALANCE] token on new
      // backends; phrase-match keeps the reroute working across deploy skew).
      if (/\[TRIAL_BALANCE\]|looks like a trial balance/i.test(msg)) {
        try {
          await routeTrialBalanceToDashboard(file);
          return;
        } catch (reErr) {
          const reMsg = reErr instanceof Error ? reErr.message : t("productsX.toast.uploadFailed");
          toast.error(t("productsX.toast.uploadFailed"), { description: reMsg });
          setBusy(false);
          return;
        }
      }
      toast.error(t("productsX.toast.uploadFailed"), {
        description: msg.includes("Failed to fetch")
          ? t("ws.backendNotRunning")
          : msg.replace(/^\[TRIAL_BALANCE\]\s*/, ""),
      });
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="workspace-onboarding">
      {/* Extra-doc / quota dialogs for the trial-balance reroute. */}
      {uploadEnqueue.dialog}
      <Stepper step={step} />

      <div>
        {step === 0 && (
          <StepName
            name={name}
            setName={setName}
            industryKey={industryKey}
            setIndustryKey={setIndustryKey}
          />
        )}
        {step === 1 && <StepRules />}
        {step === 2 && <StepUpload busy={busy} onUpload={handleUpload} />}
      </div>

      {/* Wizard navigation */}
      <div className="flex items-center justify-between gap-3">
        {/* Back appears from step 1 onward. The step-0 "All workspaces" exit
            was removed 2026-07-26 per operator — the workspace rail now sits
            beside the wizard, so leaving is a click on a workspace there
            rather than a button that duplicated it. `canExit` still gates
            nothing here; the parent keeps computing it for that rail. */}
        {step > 0 ? (
          <button
            type="button"
            onClick={back}
            data-testid="onboarding-back"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-rule bg-surface text-[13px] font-medium text-ink hover:bg-bg-2/60 transition-colors"
          >
            <ArrowLeft size={14} strokeWidth={2} />
            {t("common.back")}
          </button>
        ) : (
          <span />
        )}

        <div className="flex items-center gap-3">
          {step === 2 && (
            <button
              type="button"
              onClick={finish}
              data-testid="onboarding-skip"
              className="text-[12.5px] text-ink-mute hover:text-ink transition-colors"
            >
              {t("ws.uploadLater")}
            </button>
          )}
          {step < 2 && (
            <>
              {/* 2026-08-02 — the wizard is optional, not a wall. A fresh
                  signup already has a working workspace (the signup trigger
                  created it); this escape finishes with whatever is filled in
                  and opens the dashboard. Industry can be set later from
                  Workspace settings or the Benchmark page's picker. */}
              <button
                type="button"
                onClick={() => {
                  finish();
                  navigate("/dashboard");
                }}
                data-testid="onboarding-skip-early"
                className="text-[12.5px] text-ink-mute hover:text-ink transition-colors"
              >
                {t("ws.skipForNow")}
              </button>
              <button
                type="button"
                onClick={next}
                disabled={step === 0 && name.trim().length === 0}
                data-testid="onboarding-next"
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {t("common.continue")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  const { t } = useTranslation();
  return (
    <ol className="flex items-center gap-2" data-testid="onboarding-stepper">
      {STEP_KEYS.map((key, i) => {
        const label = t(key);
        const isDone = i < step;
        const isActive = i === step;
        return (
          <li key={key} className="flex items-center gap-2 flex-1 last:flex-none">
            <span
              className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold tabular-nums transition-all ${
                isDone
                  ? "ask-ai-anim-fill [animation-duration:10s] border border-brand/50 text-ink shadow-[0_0_12px_rgba(92,211,197,0.55)]"
                  : isActive
                  ? "bg-brand/15 text-brand-d ring-2 ring-brand/30"
                  : "bg-bg-2 text-ink-mute border border-rule"
              }`}
            >
              {isDone ? <Check size={18} strokeWidth={2.5} /> : String(i + 1).padStart(2, "0")}
            </span>
            <span className={`text-[12.5px] font-medium ${isActive ? "text-ink" : "text-ink-mute"}`}>
              {label}
            </span>
            {i < STEP_KEYS.length - 1 && (
              <span className="hidden sm:block flex-1 h-px bg-rule mx-1" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepHeading({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-4">
      <h2 className="font-serif text-[20px] text-ink leading-tight">{title}</h2>
      <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">{body}</p>
    </div>
  );
}

function StepName({
  name,
  setName,
  industryKey,
  setIndustryKey,
}: {
  name: string;
  setName: (v: string) => void;
  industryKey: string | null;
  setIndustryKey: (k: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <StepHeading
        title={t("ws.stepNameTitle")}
        body={t("ws.stepNameBody")}
      />
      <label className="block">
        <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-1.5">
          {t("settings.workspace_name")}
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder={t("ws.namePlaceholder")}
          autoFocus
          data-testid="onboarding-name-input"
          className="w-full h-11 px-3.5 rounded-lg border border-rule bg-surface text-[14px] text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
        />
      </label>

      {/* Same catalog + pills as /onboarding — the pick lands on this
          workspace's organization row and drives its benchmarks. */}
      <div className="mt-5">
        <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-2">
          {t("onboarding.industry")}
        </span>
        <OrgIndustryPills value={industryKey} onChange={setIndustryKey} />
        <p className="mt-2 text-[11.5px] text-ink-mute leading-snug">
          {t("ws.industryHint")}
        </p>
      </div>
    </div>
  );
}

function StepRules() {
  const { t } = useTranslation();
  return (
    <div>
      <StepHeading
        title={t("ws.stepRulesTitle")}
        body={t("ws.stepRulesBody")}
      />
      {/* The DecisionRules controls, rendered inline (no modal). */}
      <DecisionRulesPanel />
    </div>
  );
}

function StepUpload({ busy, onUpload }: { busy: boolean; onUpload: (f: File) => void }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const f = files[0];
    const ok = f.name.toLowerCase().endsWith(".xlsx") || f.name.toLowerCase().endsWith(".csv");
    if (!ok) {
      toast.error(t("ws.unsupportedFile"), { description: t("ws.unsupportedFileDesc") });
      return;
    }
    onUpload(f);
  }

  return (
    <div>
      <StepHeading
        title={t("ws.stepUploadTitle")}
        body={t("ws.stepUploadBody")}
      />
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.csv"
        className="hidden"
        onChange={(e) => pick(e.target.files)}
      />
      {/* Same premium dropzone as the dashboard's upload surface: glass card,
          oversized decorative cloud + up-arrow mark, brand glow, ring-glow on
          drag-over, animated-gradient Import button. */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); pick(e.dataTransfer.files); }}
        data-testid="onboarding-dropzone"
        className={`relative overflow-hidden rounded-2xl border-2 border-dashed backdrop-blur-sm p-6 sm:p-7 flex flex-col items-center justify-center text-center min-h-[240px] transition-all duration-150 ${
          dragOver
            ? "border-brand bg-brand/10 ring-2 ring-inset ring-brand/30 shadow-[0_0_0_4px_rgba(92,211,197,0.08)]"
            : "border-rule/80 bg-gradient-to-br from-bg-2/30 via-surface/60 to-surface/40 hover:border-rule-strong hover:from-bg-2/50"
        }`}
      >
        {/* Atmospheric brand glow */}
        <div aria-hidden className="pointer-events-none absolute -top-20 -right-12 h-56 w-56 rounded-full bg-brand/8 blur-3xl" />
        {/* Oversized upload mark — cloud + up-arrow, pinned bottom-left and
            clipped by overflow-hidden. */}
        <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 text-ink opacity-[0.08]">
          <Cloud size={440} strokeWidth={1} />
          <ArrowUp size={160} strokeWidth={2.5} className="absolute left-1/2 top-[62%] -translate-x-1/2 -translate-y-1/2" />
        </div>

        {busy ? (
          <div className="relative flex items-center justify-center gap-3 text-ink-soft">
            <Loader2 size={18} strokeWidth={2} className="animate-spin text-brand-d" />
            <span className="text-[13.5px]">{t("ws.importing")}</span>
          </div>
        ) : (
          <div className="relative flex flex-col items-center">
            <h3 className="text-[16px] font-semibold text-ink">
              {dragOver ? t("files.dropToUpload") : t("ws.dropWorkbook")}
            </h3>
            <p className="text-[12.5px] text-ink-soft mt-1">{t("ws.uploadFormats")}</p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              data-testid="onboarding-choose-file"
              className="mt-4 inline-flex items-center justify-center h-9 px-3.5 rounded-lg border border-brand/40 ask-ai-anim-fill [animation-duration:10s] text-ink text-[12.5px] font-medium hover:border-brand/60 transition-colors"
            >
              {t("files.import")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Post-onboarding hub ─────────────────────────────────────────────────────

// ─── Per-workspace uploads ───────────────────────────────────────────────────
// Collapsible list of every document a workspace has received. Fetches
// lazily on first expand (react-query, keyed by org id) so rendering the
// workspace list costs zero extra requests. Documents are read straight
// from Supabase with an explicit org filter — RLS membership still
// applies, so only the user's own workspaces return rows.

// The selected-workspace panel under the title: months, uploads, and the edit
// tab. While the workspace's months + uploads load, the content is blurred
// almost to invisibility behind a centered spinner (the two queries are shared
// by key with the child sections, so this adds no extra network cost).
function SelectedWorkspacePanel({
  workspace,
  canDelete,
  onRename,
  onChangeIndustry,
  onDelete,
}: {
  workspace: Workspace;
  canDelete: boolean;
  onRename: (name: string) => void;
  onChangeIndustry: (key: string) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const period = useActivePeriod();
  const monthsQ = useQuery({
    queryKey: ["org-periods", workspace.id],
    queryFn: () => fetchWorkspacePeriodsDirect(workspace.id),
    staleTime: 60_000,
  });
  const loading = monthsQ.isLoading;

  // Top rule removed 2026-07-26 per operator — the panel's own hero header
  // already separates it from the workspace list above.
  return (
    <div className="space-y-6" data-testid="selected-workspace-panel">
      <PageHeader
        hero
        eyebrow={t("ws.settingsEyebrow")}
        title={
          <Trans
            i18nKey="ws.manageTitle"
            values={{ name: workspace.name || t("ws.thisWorkspace") }}
            components={{ grad: <span className="text-grad" /> }}
          />
        }
        subtitle={t("ws.settingsSubtitle")}
      />
      {/* The blur-the-content-and-overlay-a-spinner treatment was removed
          2026-07-26 per operator: switching workspace now shows the app-wide
          fullscreen cover (startWorkspaceSwitch → PeriodSwitchOverlay), which
          covers the WHOLE app rather than just this panel's subtree. Two
          loading treatments at once read as a stutter. `aria-busy` stays so
          assistive tech still knows the region is settling. */}
      <div className="space-y-6" aria-busy={loading}>
        {/* Settings redesign 2026-08-04: periods, rules, financing and the
            danger zone all live inside WorkspaceSettingsV2's sectioned
            surface (the old inline MonthsSection + staged-apply settings
            were replaced by it). */}
        <WorkspaceSettingsV2
          key={workspace.id}
          workspace={workspace}
          canDelete={canDelete}
          showBack={false}
          onRename={onRename}
          onChangeIndustry={onChangeIndustry}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

// Month pills for a workspace card — the periods (months) that workspace has,
// newest first. Read-only chips (the card's click still selects the workspace);
// fetched per org and cached so a grid of cards costs one request each.
function WorkspaceMonthsPills({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["org-periods", orgId],
    queryFn: () => fetchWorkspacePeriodsDirect(orgId),
    staleTime: 60_000,
  });
  // Empty periods count — a container without a file is still a period the
  // workspace holds (2026-07-26: periods are independent of files).
  const periods = (data?.periods ?? [])
    .slice()
    .sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? ""));
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="workspace-card-months">
      {(() => {
        // A card is a GLANCE, not an inventory (2026-08-04 per operator —
        // their card read "Mar 5309, Dec 2050, Aug 2026, …, Dec 2025 ×3,
        // Dec 2021"): show the newest months only, one chip per month,
        // corrupt dates excluded, capped at three + a "+N" tail. The full,
        // honest list (with duplicate/bad-date chips) lives in Settings →
        // Perioade.
        const seen = new Set<string>();
        const clean = periods
          .filter((p) => !isImplausiblePeriod(p.period_end))
          .map((p) => ({ p, label: formatPeriodMonth(p.period_end) ?? p.period_label }))
          .filter(({ label }) => {
            if (!label || seen.has(label)) return false;
            seen.add(label);
            return true;
          })
          .sort((a, b) => (b.p.period_end ?? "").localeCompare(a.p.period_end ?? ""));
        const hiddenCount = periods.length - clean.slice(0, 3).length;
        if (clean.length === 0) {
          return (
            <span className="inline-flex items-center h-6 px-2 rounded-full border border-dashed border-rule text-[11px] font-medium text-ink-mute">
              {t("ws.noPeriods")}
            </span>
          );
        }
        return (
          <>
            {clean.slice(0, 3).map(({ p, label }) => (
              <span
                key={p.period_id}
                className="inline-flex items-center h-6 px-2 rounded-full border border-rule bg-surface/60 text-[11px] font-medium text-ink-soft tabular-nums"
              >
                {label}
              </span>
            ))}
            {hiddenCount > 0 && (
              <span
                data-testid="workspace-card-months-more"
                title={t("ws.morePeriodsTitle")}
                className="inline-flex items-center h-6 px-2 rounded-full border border-rule/60 text-[11px] font-medium text-ink-mute tabular-nums"
              >
                +{hiddenCount}
              </span>
            )}
          </>
        );
      })()}
    </div>
  );
}

// WorkspaceUploadsSection + WorkspaceUploadRow removed 2026-07-26 per operator
// — every uploaded file now renders inside its own period card (see
// MonthsSection), so a separate workspace-wide list showed the same filenames
// a second time. The shared <SourceFilesRow /> is still used by the Dashboard
// and Products.

function WorkspaceHub({
  onEdit,
  onCreate,
  createActive = false,
  onSelected,
}: {
  onEdit: (id: string) => void;
  onCreate: () => void;
  /** Fired after a workspace row is picked. The setup wizard uses it to close
   *  itself (2026-07-26 per operator): picking a workspace while the wizard is
   *  open means "show me that one", but the wizard used to stay put because
   *  its own `creatingNew` flag knew nothing about the rail. */
  onSelected?: (id: string) => void;
  /** True while the setup wizard is open — the rail then marks "Create
   *  workspace" as the selected item (2026-07-26 per operator), because the
   *  wizard beside it IS that action in progress. Without it the rail showed
   *  nothing selected while you were plainly in the middle of creating one. */
  createActive?: boolean;
}) {
  const { t } = useTranslation();
  const period = useActivePeriod();
  const navigate = useNavigate();
  const { workspaces, archived, currentId, select, setPeriod, restore, purge } = useWorkspaces();
  // Which archived workspace the permanent-delete dialog is open for.
  const [purgeTarget, setPurgeTarget] = useState<Workspace | null>(null);
  // 2026-08 — plan workspace cap. Fails OPEN without plan state; the
  // create_workspace RPC's SQL hard floor is the real enforcement.
  const { state: planState } = usePlanState();
  const atWorkspaceCap = workspaceCapReached(planState, workspaces.length);

  // Keep the current workspace's remembered period in sync with what's loaded,
  // so switching back to it later restores the same analysis.
  useEffect(() => {
    if (currentId) setPeriod(currentId, period.id ?? null);
  }, [currentId, period.id, setPeriod]);

  // Switching re-scopes every query to the other company, so wait for the
  // switch to land before navigating — otherwise the destination renders
  // against the outgoing workspace's cache for a frame.
  async function switchTo(id: string) {
    // Re-picking the ACTIVE workspace is still meaningful while the wizard is
    // open — it's how you dismiss it — so notify before the early return.
    onSelected?.(id);
    if (id === currentId) return;
    // Fullscreen cover for the duration (2026-07-26 per operator) — a
    // workspace switch clears the whole query cache and refetches every
    // surface, so the alternative is watching the page repaint company by
    // company. Replaces the local content blur this panel used to show, which
    // only covered its own subtree and left the rest of the app mid-swap.
    const target = workspaces.find((w) => w.id === id);
    startWorkspaceSwitch(target?.name || undefined);
    await select(id);
    const qs = target?.periodId ? `?period=${encodeURIComponent(target.periodId)}` : "";
    navigate(`/workspace${qs}`, { replace: true });
  }

  async function restoreWorkspace(id: string, name: string) {
    const ok = await restore(id);
    toast[ok ? "success" : "error"](
      ok
        ? t("ws.workspaceRestored", { name: name || t("ws.workspaceFallback") })
        : t("ws.cantRestoreWorkspace"),
    );
  }

  const noneSelected = currentId == null;

  // Active workspace leads the row, right after the Create card (2026-07-26
  // per operator) — the one you're working in shouldn't be buried mid-list
  // once several companies exist. Order is otherwise preserved, and the sort
  // runs on a COPY so the shared `workspaces` array from the store isn't
  // mutated out from under other consumers.
  const orderedWorkspaces = currentId
    ? [...workspaces].sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId))
    : workspaces;

  return (
    <div className="space-y-4">
      {/* The "Your workspace(s)" label was removed 2026-07-26 per operator —
          the hero header above already names the surface, so it read as a
          duplicate heading. */}

      {/* No workspace selected — the app can run with no active workspace
          (e.g. right after switching accounts). Surface it and point at the
          Select buttons below rather than silently showing every row inactive. */}
      {!noneSelected ? null : workspaces.length > 0 ? (
        <div
          data-testid="workspace-none-selected"
          className="rounded-2xl border border-dashed border-rule bg-bg-2/30 px-5 py-4 text-[13px] text-ink-soft"
        >
          {t("ws.noneSelected")}
        </div>
      ) : null}

      {/* The "Create your first workspace" hero was removed 2026-07-26 per
          operator. The rail below already opens with a Create button, so an
          empty workspace list simply renders that button on its own — one
          affordance in one place instead of a separate full-page screen that
          said the same thing. */}
      {
      // Vertical rail (2026-07-26 per operator): one workspace per row, the
      // Create button the same width as the cards below it, and the whole
      // column pinned while the settings panel beside it scrolls.
      <ul
        className="flex flex-col gap-3 items-stretch lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2.5rem)] lg:overflow-y-auto chat-scroll"
        data-testid="workspace-list"
      >
        <li>
          {/* Selected state mirrors the workspace cards below exactly — the
              animated teal fill, brand border and corner dot — so "what the
              rail is currently on" reads the same whether that's a workspace
              or the create flow. */}
          <button
            type="button"
            onClick={atWorkspaceCap ? undefined : onCreate}
            disabled={atWorkspaceCap}
            data-testid="workspace-create"
            data-active={createActive ? "true" : "false"}
            data-at-cap={atWorkspaceCap ? "true" : "false"}
            aria-current={createActive ? "step" : undefined}
            className={`group relative w-full flex flex-row items-center justify-center gap-2 rounded-2xl border px-3 py-3 text-center transition-colors ${
              atWorkspaceCap
                ? "border-rule text-ink-mute opacity-50 cursor-not-allowed"
                : createActive
                ? "ask-ai-anim-fill [animation-duration:14s] border-brand/50 text-ink"
                : "border-rule text-ink-mute hover:text-ink hover:border-rule-strong hover:bg-bg-2/40"
            }`}
          >
            {createActive && (
              <span
                className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-brand shadow-[0_0_8px_rgba(92,211,197,0.6)]"
                title={t("ws.creatingWorkspace")}
              >
                <span className="sr-only">{t("ws.creatingWorkspace")}</span>
              </span>
            )}
            <span
              className={`grid place-items-center h-7 w-7 shrink-0 rounded-full border transition-colors ${
                createActive ? "border-brand/50" : "border-rule group-hover:border-rule-strong"
              }`}
            >
              <Plus size={16} strokeWidth={2.25} />
            </span>
            <span className="text-[12.5px] font-medium leading-tight">{t("ws.createWorkspace")}</span>
          </button>
          {/* At the plan's workspace cap — inline upgrade CTA replaces the
              dead click. Only renders when plan state actually carries a
              cap (fail-open otherwise). */}
          {atWorkspaceCap && (
            <p
              data-testid="workspace-cap-upgrade"
              className="mt-2 px-1 text-[11.5px] leading-snug text-ink-soft"
            >
              {t("pricing.workspaceLimitDesc", {
                max: planState?.max_workspaces ?? workspaces.length,
              })}{" "}
              <NavLink
                to="/pricing"
                className="font-medium text-brand-d hover:text-brand underline-offset-2 hover:underline"
              >
                {t("pricing.workspaceLimitCta")}
              </NavLink>
            </p>
          )}
        </li>
        {orderedWorkspaces.map((w) => {
          // Exactly one selected item in the rail (2026-07-26 per operator).
          // While the create wizard is open it owns the selection, so the
          // still-active workspace must not also render as selected.
          const isActive = !createActive && w.id === currentId;
          return (
            <li key={w.id} className="w-full">
              <div
                data-testid="workspace-list-item"
                data-active={isActive ? "true" : "false"}
                onClick={() => void switchTo(w.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void switchTo(w.id); }
                }}
                aria-pressed={isActive}
                aria-label={t("ws.selectWorkspaceAria", { name: w.name || t("ws.workspaceFallback") })}
                // Selected card carries the animated teal gradient
                // (2026-07-26 per operator) — the same `.ask-ai-anim-fill`
                // treatment as the selected industry card and the Ask CFO AI
                // pill, so "chosen" reads identically everywhere. The long
                // duration keeps a grid of cards calm.
                className={`group relative h-full rounded-2xl border px-4 py-3 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  isActive
                    ? "ask-ai-anim-fill [animation-duration:14s] border-brand/50"
                    : "border-rule bg-surface hover:border-rule-strong hover:bg-bg-2/40"
                }`}
              >
                {/* Active marker — a brand-accent dot pinned to the card's
                    top-right corner. Visual only; screen readers get the
                    sr-only label since a colored circle says nothing aloud. */}
                {isActive && (
                  <span
                    className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-brand shadow-[0_0_8px_rgba(92,211,197,0.6)]"
                    title={t("ws.activeWorkspace")}
                  >
                    <span className="sr-only">{t("ws.activeWorkspace")}</span>
                  </span>
                )}

                <div className="pr-8">
                  <span className="block font-serif text-[16px] text-ink leading-tight truncate">
                    {w.name || t("ws.untitledWorkspace")}
                  </span>
                  {/* Firm / industry — shown on every card (fallback when the
                      setup wizard hasn't set one yet). */}
                  <div className="mt-0.5 text-[12px] text-ink-mute">
                    {w.industryKey ? orgIndustryDisplayLabel(w.industryKey) : t("ws.noIndustrySet")}
                  </div>
                  {/* Month pills — the periods this workspace holds (carry the
                      "no months" state too, so the old "No data loaded yet"
                      line was removed). */}
                  <WorkspaceMonthsPills orgId={w.id} />
                </div>
              </div>
            </li>
          );
        })}

        {/* Recently deleted — recoverable until the 30-day window closes. Now
            in the SAME grid (no separate divider); each carries its countdown
            to permanent deletion. */}
        {archived.map((w) => (
          // Full width like every other rail item. The old `w-[200px]` was a
          // leftover from when this list was a horizontal grid; in the vertical
          // rail it left the deleted cards visibly narrower than the Create
          // button and the workspace cards above them.
          <li key={w.id} className="w-full">
            <div
              data-testid="workspace-archived-item"
              className="relative flex h-full flex-col rounded-2xl border border-dashed border-rule bg-bg-2/30 px-4 py-2.5"
            >
              <div className="font-serif text-[15px] text-ink-soft leading-tight truncate pr-2">
                {w.name || t("ws.untitledWorkspace")}
              </div>
              <div className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full border border-rule bg-surface/60 px-2 py-0.5 text-[11px] font-medium text-ink-mute tabular-nums">
                <Clock size={11} strokeWidth={2} />
                {w.daysLeft && w.daysLeft > 0
                  ? t("ws.deletesInDays", { count: w.daysLeft })
                  : t("ws.deletingSoon")}
              </div>
              {/* Actions — one in each bottom corner. */}
              <div className="mt-auto pt-2 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => void restoreWorkspace(w.id, w.name)}
                  data-testid="workspace-restore"
                  title={t("panels.restore")}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-rule text-[11.5px] font-medium text-ink hover:bg-bg-2/70 transition-colors"
                >
                  <RotateCcw size={12} strokeWidth={1.75} />
                  {t("panels.restore")}
                </button>
                <button
                  type="button"
                  onClick={() => setPurgeTarget(w)}
                  data-testid="workspace-purge"
                  title={t("panels.deleteForever")}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-red-500/30 bg-red-500/10 text-[11.5px] font-medium text-red-600 hover:bg-red-500/20 transition-colors"
                >
                  <Trash2 size={12} strokeWidth={1.75} />
                  {t("common.delete")}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      }

      <PurgeWorkspaceDialog
        workspace={purgeTarget}
        onClose={() => setPurgeTarget(null)}
        onConfirm={async (w) => {
          const ok = await purge(w.id);
          setPurgeTarget(null);
          toast[ok ? "success" : "error"](
            ok
              ? t("ws.workspacePurged", { name: w.name || t("ws.workspaceFallback") })
              : t("ws.cantDeleteWorkspace"),
          );
        }}
      />
    </div>
  );
}

// ─── Permanent-delete confirmation ───────────────────────────────────────────
// GitHub-style: the destructive button stays disabled until the user types
// the workspace name exactly. Deliberate friction — this erases the SRL's
// documents, periods, analyses and chats with no recovery window.
function PurgeWorkspaceDialog({
  workspace,
  onClose,
  onConfirm,
}: {
  workspace: Workspace | null;
  onClose: () => void;
  onConfirm: (w: Workspace) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const name = workspace?.name?.trim() ?? "";
  const match = name.length > 0 && typed.trim() === name;

  // Fresh dialog per target — the typed confirmation must never carry over
  // from one workspace to another.
  useEffect(() => {
    setTyped("");
    setBusy(false);
  }, [workspace?.id]);

  async function confirm() {
    if (!workspace || !match || busy) return;
    setBusy(true);
    try {
      await onConfirm(workspace);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!workspace} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]" data-testid="workspace-purge-dialog">
        <DialogHeader>
          <DialogTitle>{t("ws.purgeTitle", { name: name || t("ws.thisWorkspace") })}</DialogTitle>
          <DialogDescription>
            {t("ws.purgeBody")}
          </DialogDescription>
        </DialogHeader>

        <label className="block">
          <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-1.5">
            <Trans
              i18nKey="ws.typeToConfirm"
              values={{ name }}
              components={{ 1: <span className="font-mono normal-case tracking-normal text-ink" /> }}
            />
          </span>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void confirm(); }}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            data-testid="workspace-purge-input"
            className="w-full h-10 px-3 rounded-lg border border-rule bg-surface text-[14px] text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500/40"
          />
        </label>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/70 disabled:opacity-40 transition-colors"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!match || busy}
            data-testid="workspace-purge-confirm"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-red-600 text-white text-[13px] font-medium hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 size={14} strokeWidth={1.75} />
            {busy ? t("productsX.wipe.deleting") : t("ws.purgeConfirm")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Workspace settings sub-view ─────────────────────────────────────────────
// The old staged-apply WorkspaceSettings (name/industry/rules + Apply changes
// row) was replaced 2026-08-04 by the sectioned redesign in
// components/cfo/workspace/WorkspaceSettingsV2.tsx (General / Periods /
// Decision rules / Financing / Danger zone). Every mutation kept its existing
// path: rename + industry go through useWorkspaces(), rules through
// decisionRulesStore, delete through ws.remove (soft, 30-day restore).
