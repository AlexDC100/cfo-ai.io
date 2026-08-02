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
import { OrgIndustryPills, orgIndustryLabel } from "@/components/cfo/OrgIndustryPills";
import { toast } from "@/components/ui/sonner";
import { periodQueryKey, useActivePeriod } from "@/lib/activePeriod";
import {
  createEmptyPeriod,
  deleteEmptyPeriod,
  fetchWorkspacePeriodsDirect,
  formatPeriodMonth,
  isCurrentMonthPeriod,
  type OrgPeriod,
  type OrgPeriodsPayload,
} from "@/lib/orgPeriods";
import { forgetPeriodVerdictFor } from "@/lib/dataPresence";
import { uploadExcelToBackend } from "@/lib/api";
import { useUploadEnqueue } from "@/hooks/useUploadEnqueue";
import { setActiveRun, setAnalysis, setUploadAlerts } from "@/lib/runStore";
import {
  readDecisionRules,
  resetDecisionRulesToDefaults,
  useDecisionRules,
  writeDecisionRules,
} from "@/lib/decisionRulesStore";
import type { DecisionRulesState } from "@/lib/decisionRules";
import { updateActiveOrg } from "@/lib/org";
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

  // Start a brand-new workspace: clear the name and re-enter onboarding. The
  // new entry is only committed to the list on finish (in onDone below).
  function startNewWorkspace() {
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
      void ws.create(name, industry);
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

          <div className="flex-1 min-w-0 space-y-8">
            <PageHeader
              hero
              eyebrow="Workspace settings"
              title={
                <>
                  Manage <span className="text-grad">{editingWorkspace.name || "this workspace"}</span>.
                </>
              }
              subtitle="Rename this workspace, tune the decision rules that classify its products, re-run the guided setup, or remove it. Changes apply to this workspace only."
            />
            <WorkspaceSettings
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
                      ? `“${name || "Workspace"}” deleted — restorable for 30 days.`
                      : "Couldn't delete that workspace.",
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
            Could not load your workspace.
          </p>
          <p className="text-[12.5px] text-ink-soft mb-4">
            The workspace list didn't come back from the server. Your data is safe — retry in a moment.
          </p>
          <button
            type="button"
            onClick={() => void ws.refresh()}
            data-testid="workspace-load-retry"
            className="inline-flex items-center justify-center h-9 px-4 rounded-lg border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors"
          >
            Retry
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
          <div className="flex-1 min-w-0">
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
                      ? `“${cur.name || "Workspace"}” deleted — restorable for 30 days.`
                      : "Couldn't delete that workspace.",
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
              eyebrow="Workspace"
              title={<>Set up your <span className="text-grad">workspace</span>.</>}
              subtitle="Name your workspace, tune the decision rules that classify your products, and upload your data — three quick steps and CFO AI is ready to analyze."
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

const STEP_LABELS = ["Name", "Decision rules", "Upload"] as const;

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
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [name, setName] = useState<string>(readWorkspaceName);
  const [industryKey, setIndustryKey] = useState<string | null>(initialIndustryKey);
  const [busy, setBusy] = useState(false);
  // For the "Skip for now — open the dashboard" escape (2026-08-02).
  const navigate = useNavigate();

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
      toast.success("Workbook imported", {
        description: `${skuCount} SKUs classified. Your workspace is ready.`,
      });
      finish();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast.error("Upload failed", {
        description: msg.includes("Failed to fetch")
          ? "Backend not running. Start the engine API and try again."
          : msg,
      });
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="workspace-onboarding">
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
            Back
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
              I'll upload later
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
                Skip for now — open the dashboard
              </button>
              <button
                type="button"
                onClick={next}
                disabled={step === 0 && name.trim().length === 0}
                data-testid="onboarding-next"
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Continue
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex items-center gap-2" data-testid="onboarding-stepper">
      {STEP_LABELS.map((label, i) => {
        const isDone = i < step;
        const isActive = i === step;
        return (
          <li key={label} className="flex items-center gap-2 flex-1 last:flex-none">
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
            {i < STEP_LABELS.length - 1 && (
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
  return (
    <div>
      <StepHeading
        title="Name your workspace"
        body="Give this workspace a name so you can recognize it — usually the company or entity you're analyzing."
      />
      <label className="block">
        <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-1.5">
          Workspace name
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="e.g. Scandia Food SRL"
          autoFocus
          data-testid="onboarding-name-input"
          className="w-full h-11 px-3.5 rounded-lg border border-rule bg-surface text-[14px] text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
        />
      </label>

      {/* Same catalog + pills as /onboarding — the pick lands on this
          workspace's organization row and drives its benchmarks. */}
      <div className="mt-5">
        <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-2">
          Industry
        </span>
        <OrgIndustryPills value={industryKey} onChange={setIndustryKey} />
        <p className="mt-2 text-[11.5px] text-ink-mute leading-snug">
          Pick the closest match — CFO AI applies industry-appropriate benchmarks. A 4×
          Debt/EBITDA is normal in real estate and alarming in B2B SaaS.
        </p>
      </div>
    </div>
  );
}

function StepRules() {
  return (
    <div>
      <StepHeading
        title="Set your decision rules"
        body="These rules classify every product into Protect / Watch / Wind down. Pick a preset or tune the thresholds — you can always change them later from Products."
      />
      {/* The DecisionRules controls, rendered inline (no modal). */}
      <DecisionRulesPanel />
    </div>
  );
}

function StepUpload({ busy, onUpload }: { busy: boolean; onUpload: (f: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const f = files[0];
    const ok = f.name.toLowerCase().endsWith(".xlsx") || f.name.toLowerCase().endsWith(".csv");
    if (!ok) {
      toast.error("Unsupported file", { description: "Drop a .xlsx or .csv workbook." });
      return;
    }
    onUpload(f);
  }

  return (
    <div>
      <StepHeading
        title="Upload your data"
        body="Drop an Excel or CSV with SKU sales, margin, and inventory. CFO AI classifies every product using the rules you just set."
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
            <span className="text-[13.5px]">Importing your workbook…</span>
          </div>
        ) : (
          <div className="relative flex flex-col items-center">
            <h3 className="text-[16px] font-semibold text-ink">
              {dragOver ? "Drop your file to upload" : "Drop your workbook here"}
            </h3>
            <p className="text-[12.5px] text-ink-soft mt-1">XLSX · CSV · up to 25 MB</p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              data-testid="onboarding-choose-file"
              className="mt-4 inline-flex items-center justify-center h-9 px-3.5 rounded-lg border border-brand/40 ask-ai-anim-fill [animation-duration:10s] text-ink text-[12.5px] font-medium hover:border-brand/60 transition-colors"
            >
              Import
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Post-onboarding hub ─────────────────────────────────────────────────────

// ─── Periods ─────────────────────────────────────────────────────────────────
// Periods are independent CONTAINERS (2026-07-26 per operator); files are
// their contents. A period can exist with no file — created from the Add
// dialog — and shows an "Attach trial balance" affordance until one lands.
// Reads `financial_periods` DIRECTLY from Supabase (fetchWorkspacePeriodsDirect)
// rather than the engine's /periods-with-documents feed, because that feed
// deliberately skips doc-less periods (it drives the analysis surfaces).
//
// Uploading into a month never duplicates it: the pipeline's stage_persist
// matches on (org_id, period_end) and ADOPTS the existing row — pre-created
// empty periods included.

function MonthsSection({
  compact = false,
  orgId,
}: {
  compact?: boolean;
  orgId: string;
}) {
  const scoped = useQuery({
    queryKey: ["org-periods", orgId],
    queryFn: () => fetchWorkspacePeriodsDirect(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });
  const qc = useQueryClient();

  // Which period the delete-confirmation dialog is open for. Deleting a period
  // is destructive (it takes the analysis, metrics, briefing and alerts with
  // it), so it always goes through a confirm step rather than firing on click.
  const [deleteTarget, setDeleteTarget] = useState<OrgPeriod | null>(null);
  // Which FILE the delete-confirmation dialog is open for (2026-07-26 per
  // operator). Separate from the period target above: removing one attachment
  // leaves the month itself in place.
  const [fileDeleteTarget, setFileDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  // Which period the right-hand panel is showing. Local to this section —
  // it is NOT the app's active period.
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
  // `?period=` is the app-wide selection, which the sidebar's month label
  // reads. Deleting the period it points at has to move it (2026-07-26 per
  // operator) — otherwise the URL keeps naming a period that no longer
  // exists and the rail shows a stale month.
  const [urlParams, setUrlParams] = useSearchParams();

  async function confirmDeleteFile() {
    const target = fileDeleteTarget;
    if (!target) return;
    setFileDeleteTarget(null);
    const sb = getSupabase();
    if (!sb) { toast.error("Not signed in."); return; }
    // Soft-delete, matching every other delete path in the app: the row stays
    // for 30 days in Recently deleted rather than being destroyed.
    const { error } = await sb
      .from("documents")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", target.id);
    if (error) { toast.error(`Couldn't delete "${target.name}".`); return; }
    void qc.invalidateQueries({ queryKey: ["org-periods", orgId] });
    void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
    qc.removeQueries({ queryKey: ["period-documents"] });
    toast.success(`“${target.name}” deleted — restorable for 30 days.`);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const label = formatPeriodMonth(target.period_end) ?? target.period_label;

    // Backstop for the disabled delete button. Guarding here too means a stale
    // render (or a dialog opened just before the list changed) can't slip
    // through. Two rules, in order of specificity:
    //   1. The CURRENT month is permanent — it's the guaranteed landing spot
    //      for today's upload and useEnsureCurrentPeriod would recreate it
    //      immediately anyway, so deleting it only ever flickers.
    //   2. A workspace keeps at least one period.
    if (isCurrentMonthPeriod(target.period_end)) {
      setDeleteTarget(null);
      toast.info(`${label} is the current month — it can't be deleted.`);
      return;
    }
    if (periods.length <= 1) {
      setDeleteTarget(null);
      toast.info("A workspace keeps at least one period — add another first.");
      return;
    }

    // Reflect the delete IMMEDIATELY (2026-07-26 per operator). Invalidation
    // alone left the card on screen for a full round trip — the DELETE, then a
    // refetch of both period lists — which reads as the click not registering.
    // So we drop the row from the caches up front and reconcile with the server
    // afterwards, restoring the snapshots if the request fails.
    const dropPeriod = (payload: OrgPeriodsPayload | null | undefined) => {
      if (!payload) return payload;
      return {
        ...payload,
        // A pointer at the period we just removed is worse than none: every
        // consumer would resolve it and 404.
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
    // Anything keyed by this period is now unreachable — drop it rather than
    // leaving a warm cache entry for a deleted id.
    qc.removeQueries({ queryKey: ["period-documents", target.period_id] });
    forgetPeriodVerdictFor(target.period_id);
    setDeleteTarget(null);

    // Move BOTH selections onto the period that takes its place — the local
    // panel's and the app-wide `?period=`, so the sidebar's month label
    // follows the deletion instead of naming a period that's gone. `periods`
    // is newest-first, so the first survivor is the natural successor and
    // matches what the right-hand panel falls back to on its own.
    const successor = periods.find((p) => p.period_id !== target.period_id) ?? null;
    setSelectedPeriodId(successor?.period_id ?? null);
    if (urlParams.get("period") === target.period_id) {
      const nextParams = new URLSearchParams(urlParams);
      if (successor) nextParams.set("period", successor.period_id);
      else nextParams.delete("period");
      setUrlParams(nextParams, { replace: true });
    }

    try {
      if ((target.documents?.length ?? 0) === 0) {
        // Empty container — no files to soft-delete, no engine analysis to
        // unwind. A direct row delete under the user's own RLS is instant and
        // works with the engine stopped.
        const errMsg = await deleteEmptyPeriod(target.period_id);
        if (errMsg) throw new Error(errMsg);
        toast.success(`“${label}” deleted.`);
      } else {
        const { cfoApi } = await import("@/lib/cfoApi");
        const res = await cfoApi.deletePeriod(target.period_id);
        toast.success(`“${label}” deleted.`, {
          description: res.documents_soft_deleted
            ? `${res.documents_soft_deleted} file(s) moved to Recently deleted — restorable for 30 days.`
            : undefined,
        });
      }
      // Reconcile: the optimistic edit only removed the row, the server also
      // moved the active period on and soft-deleted the files.
      void qc.invalidateQueries({ queryKey: scopedKey });
      void qc.invalidateQueries({ queryKey: activeKey });
      void qc.invalidateQueries({ queryKey: ["workspace-docs", orgId] });
    } catch (err) {
      // Put the card back — the period still exists on the server.
      if (prevScoped !== undefined) qc.setQueryData(scopedKey, prevScoped);
      if (prevActive !== undefined) qc.setQueryData(activeKey, prevActive);
      toast.error("Couldn't delete that period.", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }
  const periods = (scoped.data?.periods ?? [])
    .slice()
    .sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? ""));

  // "Add period" — opens a modal (2026-07-26 per operator) where the user
  // picks WHICH period they're adding and drops its trial balance, instead of
  // being routed away to the dashboard's upload state. Picking the month here
  // is the point: it lands on `documents.period_end_hint`, which the engine
  // prefers over its own filename/content detection, so the file is filed
  // under the month the user meant rather than the month a filename implied.
  //
  // Shaped as a card so it sits in the same grid as the period cards below,
  // styled to match the "Create workspace" card: centered circled Plus over a
  // label, same rounded card and hover lift.
  const [addOpen, setAddOpen] = useState(false);


  const addMonthBtn = (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setAddOpen(true); }}
      data-testid="workspace-add-month"
      className="group h-full flex flex-col items-center justify-center gap-2 rounded-2xl border border-rule px-6 py-7 text-center text-ink-mute hover:text-ink hover:border-rule-strong hover:bg-bg-2/40 transition-colors"
    >
      <span className="grid place-items-center h-8 w-8 rounded-full border border-rule group-hover:border-rule-strong transition-colors">
        <Plus size={18} strokeWidth={2.25} />
      </span>
      <span className="text-[12.5px] font-medium leading-tight">Add period</span>
    </button>
  );

  const addDialog = (
    <AddPeriodDialog
      open={addOpen}
      onOpenChange={setAddOpen}
      takenMonths={periods.map((p) => (p.period_end ?? "").slice(0, 7)).filter(Boolean)}
      orgId={orgId}
    />
  );

  // Even with no months yet, still offer "Add month" (compact/in-card only).
  if (periods.length === 0) {
    return compact ? (
      <div className="border-t border-rule/60 pt-6" data-testid="workspace-months">
        <StepHeading
          title="Periods"
          body="Each period is a month of this workspace. Create one and attach its trial balance whenever you're ready."
        />
        {addMonthBtn}
        {addDialog}
      </div>
    ) : null;
  }

  // Period cards — a 2-up grid of rounded cards matching the Industry cards
  // below. NOT selectable (2026-07-26 per operator): these are a read-out of
  // what the workspace holds, and the app's active period is switched from the
  // sidebar stepper. Each card names the period and lists every file behind
  // it; a period with no files is a legitimate state (containers are
  // independent of contents) and carries its own attach affordance.
  //
  // Hovering reveals a delete control for the period.
  // Master/detail (2026-07-26 per operator): periods as a vertical list on the
  // left, the SELECTED period's files on the right where they can be viewed
  // and deleted. The selection is local to this panel — it decides which
  // month's contents you're inspecting here, NOT the app's active period
  // (that stays with the sidebar stepper), so browsing files can't silently
  // re-scope the dashboard.
  const selected = periods.find((p) => p.period_id === selectedPeriodId) ?? periods[0] ?? null;
  const selectedDocs = selected?.documents ?? [];

  const pills = (
    <div className="flex flex-col lg:flex-row gap-4 items-start">
      {/* Left — the period list. */}
      <div className="w-full lg:w-[240px] lg:shrink-0 flex flex-col gap-2">
        {addMonthBtn}
        {periods.map((p) => {
          const label = formatPeriodMonth(p.period_end) ?? p.period_label;
          const count = (p.documents ?? []).length;
          const isSelected = selected?.period_id === p.period_id;
          return (
            <div
              key={p.period_id}
              data-testid={`workspace-month-${p.period_id}`}
              data-selected={isSelected ? "true" : "false"}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedPeriodId(p.period_id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedPeriodId(p.period_id); }
              }}
              aria-pressed={isSelected}
              className={`group relative rounded-xl border px-3.5 py-3 cursor-pointer transition-colors ${
                isSelected
                  ? "border-brand/50 ask-ai-anim-fill [animation-duration:10s]"
                  : "border-rule bg-bg-2/40 hover:border-rule-strong hover:bg-bg-2/70"
              }`}
            >
              {/* Selection dot — top-right corner (2026-07-26 per operator);
                  the same mark the workspace cards carry. */}
              {isSelected && (
                <span
                  aria-hidden
                  className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-brand shadow-[0_0_8px_rgba(92,211,197,0.6)]"
                />
              )}
              <div className="text-[13px] font-medium tabular-nums text-ink pr-5">{label}</div>
              <div className="mt-0.5 text-[11px] text-ink-mute">
                {count === 0 ? "No files attached" : `${count} file${count === 1 ? "" : "s"}`}
              </div>
            </div>
          );
        })}
      </div>

      {/* Right — the selected period's files: click to preview, hover to delete. */}
      <div className="flex-1 min-w-0 w-full rounded-xl border border-rule bg-bg-2/20 p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          {/* The period IS the title (2026-07-26 per operator) — "Uploaded
              files" drops to an eyebrow above it. */}
          <div className="min-w-0">
            <div className="text-[15px] font-medium tabular-nums text-ink leading-tight">
              {selected
                ? formatPeriodMonth(selected.period_end) ?? selected.period_label
                : "No period selected"}
            </div>
            <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-ink-mute mt-0.5">
              Uploaded files
            </div>
          </div>
          {/* Delete the SELECTED period — moved off the list rows into this
              panel (2026-07-26 per operator), where it reads as an action on
              the month you're looking at rather than a hover target on every
              row. Still refused on the last remaining period. */}
          {selected && (
            <button
              type="button"
              onClick={() => setDeleteTarget(selected)}
              disabled={periods.length <= 1 || isCurrentMonthPeriod(selected.period_end)}
              data-testid={`workspace-month-delete-${selected.period_id}`}
              aria-label={`Delete ${formatPeriodMonth(selected.period_end) ?? selected.period_label}`}
              title={
                isCurrentMonthPeriod(selected.period_end)
                  ? "The current month is always kept — it's where today's upload lands"
                  : periods.length <= 1
                    ? "A workspace keeps at least one period — add another before deleting this one"
                    : "Delete this period"
              }
              className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-red-500/30 bg-red-500/[0.06] text-[11.5px] font-medium text-red-600 hover:bg-red-500/15 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 size={12} strokeWidth={1.75} />
              Delete period
            </button>
          )}
        </div>
        {selectedDocs.length === 0 ? (
          <div
            data-testid={`workspace-month-empty-${selected?.period_id ?? "none"}`}
            className="flex flex-col items-center justify-center text-center gap-1.5 py-10 text-[11.5px] text-ink-mute/80"
          >
            <FileSpreadsheet size={30} strokeWidth={1.5} className="shrink-0 opacity-50" />
            <span>No files attached</span>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-rule/60">
            {selectedDocs.map((d) => (
              <div key={d.id} className="group relative w-full">
                <button
                  type="button"
                  title={d.filename ?? undefined}
                  data-testid={`workspace-file-${d.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void openUploadedFilePreview(d.filename ?? "document", async () => {
                      const sb = getSupabase();
                      if (!sb) return null;
                      const { signedDocumentUrl } = await import("@/lib/supabase");
                      const { data } = await sb
                        .from("documents")
                        .select("*")
                        .eq("id", d.id)
                        .single();
                      return data ? signedDocumentUrl(data as never) : null;
                    });
                  }}
                  className="w-full flex items-center gap-2.5 text-left rounded-lg border border-transparent bg-transparent pl-2.5 pr-12 py-2 transition-colors group-hover:border-rule-strong group-hover:bg-bg-2/70"
                >
                  <FileSpreadsheet size={20} strokeWidth={1.5} className="shrink-0 text-ink-mute" />
                  <span className="min-w-0 flex-1">
                    {/* `scope` is the engine's own split: 'sku' feeds Products,
                        everything else feeds the dashboard's statements. */}
                    <span
                      data-testid={`workspace-file-scope-${d.id}`}
                      className="block text-[9.5px] uppercase tracking-[0.1em] font-semibold text-ink-mute/80"
                    >
                      {d.scope === "sku" ? "Products" : "Trial balance"}
                    </span>
                    <span className="block text-[11.5px] font-medium text-ink break-words leading-snug">
                      {d.filename ?? "Untitled file"}
                    </span>
                  </span>
                  {d.status && d.status !== "analyzed" && (
                    <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-ink-mute/80">
                      {d.status === "failed" ? "failed" : "analyzing…"}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setFileDeleteTarget({ id: d.id, name: d.filename ?? "this file" }); }}
                  data-testid={`workspace-file-delete-${d.id}`}
                  aria-label={`Delete ${d.filename ?? "file"}`}
                  title="Delete this file"
                  className="absolute top-1/2 -translate-y-1/2 right-2 grid place-items-center h-9 w-9 rounded-lg text-ink-mute opacity-0 transition-opacity hover:text-red-600 hover:bg-red-500/10 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 size={17} strokeWidth={1.75} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // Destructive — always confirmed, and the copy names what goes with it.
  const deleteDialog = (
    <>
    <Dialog open={!!fileDeleteTarget} onOpenChange={(o) => { if (!o) setFileDeleteTarget(null); }}>
      <DialogContent className="sm:max-w-[420px]" data-testid="workspace-file-delete-dialog">
        <DialogHeader>
          <DialogTitle>Delete this file?</DialogTitle>
          <DialogDescription>
            “{fileDeleteTarget?.name}” is removed from this period along with
            the analysis derived from it. The file moves to Recently deleted
            and can be restored for 30 days.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={() => setFileDeleteTarget(null)}
            className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirmDeleteFile()}
            data-testid="workspace-file-delete-confirm"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-red-500/30 bg-red-500/10 text-[13px] font-medium text-red-600 hover:bg-red-500/20 transition-colors"
          >
            <Trash2 size={14} strokeWidth={1.75} />
            Delete file
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
      <DialogContent className="sm:max-w-[440px]" data-testid="workspace-period-delete-dialog">
        <DialogHeader>
          <DialogTitle>
            Delete{" "}
            {deleteTarget
              ? formatPeriodMonth(deleteTarget.period_end) ?? deleteTarget.period_label
              : "this period"}
            ?
          </DialogTitle>
          <DialogDescription>
            {(deleteTarget?.documents?.length ?? 0) === 0
              ? "This period has no files — deleting it just removes the empty container."
              : "This removes the period and everything derived from it — statements, ratios, valuation, briefing and alerts. Its uploaded file(s) move to Recently deleted and stay restorable for 30 days, but the analysis is not recoverable; re-uploading rebuilds it."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={() => setDeleteTarget(null)}
            className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 transition-colors"
          >
            Cancel
          </button>
          {/* No pending/spinner state: the dialog closes and the card
              disappears on click, so the request settles behind an interface
              that has already moved on. */}
          <button
            type="button"
            onClick={() => void confirmDelete()}
            data-testid="workspace-period-delete-confirm"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-red-500/30 bg-red-500/10 text-[13px] font-medium text-red-600 hover:bg-red-500/20 transition-colors"
          >
            <Trash2 size={14} strokeWidth={1.75} />
            Delete period
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );

  // Compact — embedded inside a workspace item card. Uses the same
  // StepHeading + top-rule treatment as the Industry / Decision-rules
  // sections below it (2026-07-26 per operator) so the panel reads as one
  // consistent stack of settings rather than a small label followed by
  // full-size sections.
  if (compact) {
    return (
      <div className="border-t border-rule/60 pt-6" data-testid="workspace-months">
        <StepHeading
          title="Periods"
          body="Each period is a month of this workspace; attach its trial balance whenever you're ready. Switch the period you're analyzing from the arrows beside the month in the sidebar."
        />
        {pills}
        {deleteDialog}
        {addDialog}
      </div>
    );
  }

  return (
    <section className="border-t border-rule/60 pt-6" data-testid="workspace-months">
      <StepHeading
        title="Periods"
        body="Each period is a month of this workspace; attach its trial balance whenever you're ready."
      />
      {pills}
      {deleteDialog}
      {addDialog}
    </section>
  );
}

// ─── Add-period modal ────────────────────────────────────────────────────────
// Pick the month, then drop that month's trial balance. Two things make the
// month picker load-bearing rather than decorative:
//
//   · It writes `documents.period_end_hint`, which the engine's stage_persist
//     prefers over its own filename/content detection — so "balanta_final.xlsx"
//     files under the month the user chose instead of today's date.
//   · A period is only ever created BY an upload (one trial balance per
//     period), so there is no "create an empty period" to offer. The file is
//     required, not optional.
//
// The period-end written is the LAST day of the chosen month, the Romanian
// trial-balance convention the rest of the app assumes.
//
// Periods are independent of files (2026-07-26 per operator): confirming with
// no file creates an EMPTY period — a direct `financial_periods` insert under
// the user's own RLS, on screen instantly, engine not involved. Attaching a
// file (here or later from the period card) uploads with periodEndHint = this
// month; the pipeline's stage_persist matches (org_id, period_end) and adopts
// the pre-created row, so the two paths always converge on ONE period.
function AddPeriodDialog({
  open,
  onOpenChange,
  takenMonths,
  orgId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "YYYY-MM" of periods this workspace already holds. Creating a second
   *  EMPTY period for a taken month is blocked — the DB can't do it for us
   *  (source_document_id is NULL on empty rows, and NULLs never collide in a
   *  unique constraint). Uploading INTO a taken month is allowed: replace
   *  semantics, newest file wins. */
  takenMonths: string[];
  orgId: string;
}) {
  const qc = useQueryClient();
  const uploadEnqueue = useUploadEnqueue();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [month, setMonth] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Month detected FROM the attached file ("YYYY-MM"), and whether the user
  // has explicitly chosen to keep the period's own month over it.
  const [detectedMonth, setDetectedMonth] = useState<string | null>(null);
  const [mismatchDismissed, setMismatchDismissed] = useState(false);

  // Reset per opening — a stale file from a previous visit is a real hazard
  // here, since the confirm button uploads without a second look.
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setBusy(false);
    setDragging(false);
    setDetectedMonth(null);
    setMismatchDismissed(false);
    const now = new Date();
    setMonth(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`);
  }, [open]);

  // Read the attached file's own closing date (header text first, filename as
  // fallback — same detector the Dashboard's confirm step uses). Feeds the
  // mismatch prompt below; a re-pick resets any earlier "keep my month" choice
  // since it was about a different file.
  useEffect(() => {
    setDetectedMonth(null);
    setMismatchDismissed(false);
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const { detectPeriodEndFromFile } = await import("@/lib/detectPeriodEnd");
      const iso = await detectPeriodEndFromFile(file);
      if (!cancelled) setDetectedMonth(iso ? iso.slice(0, 7) : null);
    })();
    return () => { cancelled = true; };
  }, [file]);

  const monthValid = /^\d{4}-\d{2}$/.test(month);
  const duplicate = monthValid && takenMonths.includes(month);
  // The file says one month, the period picker another. Surfaced as a choice
  // (2026-07-26 per operator): switch the period to the file's date, or keep
  // the chosen period — in which case the file is deliberately filed under it
  // (periodEndHint overrides the engine's own detection).
  const mismatch =
    !!file &&
    !!detectedMonth &&
    monthValid &&
    detectedMonth !== month &&
    !mismatchDismissed;
  // Without a file, confirming creates an empty container — which a taken
  // month must block (it would be a silent duplicate). With a file it's a
  // legitimate replace.
  const blocked = duplicate && !file;

  const refreshPeriodLists = () => {
    void qc.invalidateQueries({ queryKey: ["org-periods", orgId] });
    void qc.invalidateQueries({ queryKey: ["org-periods"] });
    void qc.invalidateQueries({ queryKey: ["periods-with-documents"] });
    void qc.invalidateQueries({ queryKey: ["workspace-docs", orgId] });
  };

  async function submit() {
    if (!monthValid || busy || blocked || mismatch) return;
    setBusy(true);
    // Trial-balance convention: the period-end is the LAST day of the month.
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const periodEnd = `${month}-${String(lastDay).padStart(2, "0")}`;
    const label = formatPeriodMonth(periodEnd) ?? month;

    try {
      // 1. The period itself — created up front (unless the month already
      //    exists), so the card is real and on screen immediately, file or
      //    no file. If an upload follows, the pipeline adopts this row.
      if (!duplicate) {
        const created = await createEmptyPeriod(orgId, periodEnd);
        if ("error" in created) throw new Error(created.error);
      }
      refreshPeriodLists();

      // 2. Optionally, the file into it.
      if (file) {
        const { uploadDocument, subscribeToDocumentStatus } = await import("@/lib/supabase");
        const { row, error } = await uploadDocument(file, {
          scope: "financial",
          periodEndHint: periodEnd,
        });
        if (!row) throw new Error(error ?? "Upload failed.");
        const enq = await uploadEnqueue.enqueue(row.id);
        if (enq.kind !== "queued") {
          // The hook already surfaced the reason (quota / transport /
          // cancelled). The period exists either way — that's the point of
          // creating it first.
          onOpenChange(false);
          setBusy(false);
          return;
        }
        toast.success(`${label} added — analyzing ${file.name}…`);
        const unsub = subscribeToDocumentStatus(row.id, (next) => {
          if (next.status === "analyzed") {
            unsub();
            refreshPeriodLists();
            // Reset the period PAYLOAD cache too — replace/adopt keeps the
            // same period id, so a dashboard already viewing this period
            // would otherwise keep painting the stale (empty, possibly
            // cached-as-not-found) payload for its full staleTime.
            // resetQueries, not removeQueries: only reset refetches queries
            // that have active observers.
            if (next.period_id) {
              void qc.resetQueries({ queryKey: periodQueryKey(next.period_id) });
            }
            toast.success(`${label} is ready.`);
          } else if (next.status === "failed") {
            unsub();
            refreshPeriodLists();
            toast.error("Couldn't analyze that file.", { description: next.error ?? undefined });
          }
        });
      } else {
        toast.success(`${label} added.`, {
          description: "No file yet — attach its trial balance from the period card anytime.",
        });
      }
      onOpenChange(false);
      setBusy(false);
    } catch (err) {
      toast.error("Couldn't add that period.", {
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
            <DialogTitle>Add a period</DialogTitle>
            <DialogDescription>
              Pick the month. Attaching its trial balance now is optional — the period exists
              either way, and the month you pick is what any analysis gets filed under,
              overriding whatever the file name says.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label
                htmlFor="add-period-month"
                className="block text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute mb-1.5"
              >
                Period
              </label>
              <input
                id="add-period-month"
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                data-testid="workspace-add-period-month"
                className="w-full h-10 px-3 rounded-lg border border-rule bg-surface text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
              />
              {duplicate && (
                <p className="mt-1.5 text-[11.5px] text-amber-600" data-testid="workspace-add-period-duplicate">
                  {file
                    ? <>This workspace already has {formatPeriodMonth(`${month}-01`) ?? month} — this file replaces that period's analysis.</>
                    : <>This workspace already has {formatPeriodMonth(`${month}-01`) ?? month}. Pick another month, or attach a file to replace that period's analysis.</>}
                </p>
              )}
            </div>

            {/* Single file, matching every other upload surface in the app. */}
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
                  <span className="text-[11px] text-ink-mute">Click to choose a different file</span>
                </>
              ) : (
                <>
                  <UploadCloud size={22} strokeWidth={1.5} className="text-ink-mute" />
                  <span className="text-[12.5px] font-medium text-ink">
                    Drop the trial balance, or click to browse
                  </span>
                  <span className="text-[11px] text-ink-mute">
                    Optional — you can attach it later from the period card
                  </span>
                </>
              )}
            </button>

            {/* Date conflict — the file names a different month than the
                period. Confirm stays disabled until one side wins, so a
                mismatch can never slip through unnoticed. */}
            {mismatch && (
              <div
                data-testid="workspace-add-period-mismatch"
                className="rounded-lg border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2.5"
              >
                <p className="text-[11.5px] text-ink">
                  This file looks like{" "}
                  <span className="font-semibold">
                    {formatPeriodMonth(`${detectedMonth}-15`) ?? detectedMonth}
                  </span>
                  , but the period is set to{" "}
                  <span className="font-semibold">{formatPeriodMonth(`${month}-15`) ?? month}</span>.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => detectedMonth && setMonth(detectedMonth)}
                    data-testid="workspace-add-period-use-file-date"
                    className="inline-flex items-center h-7 px-2.5 rounded-md border border-brand/40 bg-brand/10 text-[11.5px] font-medium text-ink hover:bg-brand/20 transition-colors"
                  >
                    Use file date ({formatPeriodMonth(`${detectedMonth}-15`) ?? detectedMonth})
                  </button>
                  <button
                    type="button"
                    onClick={() => setMismatchDismissed(true)}
                    data-testid="workspace-add-period-keep-date"
                    className="inline-flex items-center h-7 px-2.5 rounded-md border border-rule text-[11.5px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2/60 transition-colors"
                  >
                    Keep {formatPeriodMonth(`${month}-15`) ?? month}
                  </button>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!monthValid || busy || blocked || mismatch}
              data-testid="workspace-add-period-confirm"
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {busy ? (file ? "Uploading…" : "Creating…") : "Add period"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

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
        eyebrow="Workspace settings"
        title={
          <>
            Manage <span className="text-grad">{workspace.name || "this workspace"}</span>.
          </>
        }
        subtitle="Rename this workspace, tune the decision rules that classify its products, or remove it. Changes apply to this workspace only."
      />
      {/* The blur-the-content-and-overlay-a-spinner treatment was removed
          2026-07-26 per operator: switching workspace now shows the app-wide
          fullscreen cover (startWorkspaceSwitch → PeriodSwitchOverlay), which
          covers the WHOLE app rather than just this panel's subtree. Two
          loading treatments at once read as a stutter. `aria-busy` stays so
          assistive tech still knows the region is settling. */}
      <div className="space-y-6" aria-busy={loading}>
        {/* The separate Uploads section was removed 2026-07-26 per operator —
            every file now appears inside its own period card above, so the
            list was showing the same filenames a second time. */}
        <MonthsSection compact orgId={workspace.id} />
        <WorkspaceSettings
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
      {periods.length === 0 ? (
        <span className="inline-flex items-center h-6 px-2 rounded-full border border-dashed border-rule text-[11px] font-medium text-ink-mute">
          No periods
        </span>
      ) : (
        periods.map((p) => (
          <span
            key={p.period_id}
            className="inline-flex items-center h-6 px-2 rounded-full border border-rule bg-surface/60 text-[11px] font-medium text-ink-soft tabular-nums"
          >
            {formatPeriodMonth(p.period_end) ?? p.period_label}
          </span>
        ))
      )}
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
  const period = useActivePeriod();
  const navigate = useNavigate();
  const { workspaces, archived, currentId, select, setPeriod, restore, purge } = useWorkspaces();
  // Which archived workspace the permanent-delete dialog is open for.
  const [purgeTarget, setPurgeTarget] = useState<Workspace | null>(null);

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
      ok ? `“${name || "Workspace"}” restored.` : "Couldn't restore that workspace.",
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
          No workspace is selected. Pick one below to load its data everywhere.
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
            onClick={onCreate}
            data-testid="workspace-create"
            data-active={createActive ? "true" : "false"}
            aria-current={createActive ? "step" : undefined}
            className={`group relative w-full flex flex-row items-center justify-center gap-2 rounded-2xl border px-3 py-3 text-center transition-colors ${
              createActive
                ? "ask-ai-anim-fill [animation-duration:14s] border-brand/50 text-ink"
                : "border-rule text-ink-mute hover:text-ink hover:border-rule-strong hover:bg-bg-2/40"
            }`}
          >
            {createActive && (
              <span
                className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-brand shadow-[0_0_8px_rgba(92,211,197,0.6)]"
                title="Creating a workspace"
              >
                <span className="sr-only">Creating a workspace</span>
              </span>
            )}
            <span
              className={`grid place-items-center h-7 w-7 shrink-0 rounded-full border transition-colors ${
                createActive ? "border-brand/50" : "border-rule group-hover:border-rule-strong"
              }`}
            >
              <Plus size={16} strokeWidth={2.25} />
            </span>
            <span className="text-[12.5px] font-medium leading-tight">Create workspace</span>
          </button>
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
                aria-label={`Select ${w.name || "workspace"}`}
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
                    title="Active workspace"
                  >
                    <span className="sr-only">Active workspace</span>
                  </span>
                )}

                <div className="pr-8">
                  <span className="block font-serif text-[16px] text-ink leading-tight truncate">
                    {w.name || "Untitled workspace"}
                  </span>
                  {/* Firm / industry — shown on every card (fallback when the
                      setup wizard hasn't set one yet). */}
                  <div className="mt-0.5 text-[12px] text-ink-mute">
                    {w.industryKey ? orgIndustryLabel(w.industryKey) : "No industry set"}
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
                {w.name || "Untitled workspace"}
              </div>
              <div className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full border border-rule bg-surface/60 px-2 py-0.5 text-[11px] font-medium text-ink-mute tabular-nums">
                <Clock size={11} strokeWidth={2} />
                {w.daysLeft && w.daysLeft > 0
                  ? `Deletes in ${w.daysLeft} ${w.daysLeft === 1 ? "day" : "days"}`
                  : "Deleting soon"}
              </div>
              {/* Actions — one in each bottom corner. */}
              <div className="mt-auto pt-2 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => void restoreWorkspace(w.id, w.name)}
                  data-testid="workspace-restore"
                  title="Restore"
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-rule text-[11.5px] font-medium text-ink hover:bg-bg-2/70 transition-colors"
                >
                  <RotateCcw size={12} strokeWidth={1.75} />
                  Restore
                </button>
                <button
                  type="button"
                  onClick={() => setPurgeTarget(w)}
                  data-testid="workspace-purge"
                  title="Delete forever"
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-red-500/30 bg-red-500/10 text-[11.5px] font-medium text-red-600 hover:bg-red-500/20 transition-colors"
                >
                  <Trash2 size={12} strokeWidth={1.75} />
                  Delete
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
              ? `“${w.name || "Workspace"}” permanently deleted.`
              : "Couldn't delete that workspace.",
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
          <DialogTitle>Permanently delete “{name || "this workspace"}”?</DialogTitle>
          <DialogDescription>
            This erases the workspace and everything in it — uploaded documents,
            financial periods, analyses, alerts and chat history. There is no
            30-day recovery for this action. It cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <label className="block">
          <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-1.5">
            Type <span className="font-mono normal-case tracking-normal text-ink">{name}</span> to confirm
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
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!match || busy}
            data-testid="workspace-purge-confirm"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-red-600 text-white text-[13px] font-medium hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 size={14} strokeWidth={1.75} />
            {busy ? "Deleting…" : "Permanently delete"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Workspace settings sub-view ─────────────────────────────────────────────
function WorkspaceSettings({
  workspace,
  canDelete,
  onBack,
  onRename,
  onChangeIndustry,
  onDelete,
  showBack = true,
}: {
  workspace: Workspace;
  canDelete: boolean;
  onBack?: () => void;
  onRename: (name: string) => void;
  onChangeIndustry: (key: string) => void;
  onDelete: () => void;
  /** Hide the "All workspaces" back link when the panel renders inline under
   *  the hub (the workspace list is already right above it). */
  showBack?: boolean;
}) {
  // Field settings are STAGED locally and committed together by the bottom
  // "Apply changes" button — the per-field Save was removed.
  const [name, setName] = useState(workspace.name);
  const [industryKey, setIndustryKey] = useState<string | null>(workspace.industryKey ?? null);
  const trimmed = name.trim();
  const nameChanged = trimmed.length > 0 && trimmed !== workspace.name;
  const industryChanged = (industryKey ?? "") !== (workspace.industryKey ?? "");

  // Decision rules are staged too (2026-07-26 per operator — they used to
  // commit on every drag). The panel still edits the live store, because its
  // per-rule SKU counts and the thresholds' effect are the whole point of the
  // control — reading them off a detached draft would mean duplicating the
  // bucketing pipeline. What changes is COMMITMENT: we snapshot the state on
  // entry, and leaving without pressing Apply restores that snapshot, so an
  // abandoned session leaves the catalog graded exactly as it was found.
  const rulesBaseline = useRef<DecisionRulesState>(readDecisionRules());
  const liveRules = useDecisionRules();
  const rulesChanged = useMemo(
    () => JSON.stringify(liveRules) !== JSON.stringify(rulesBaseline.current),
    [liveRules],
  );
  // Set once Apply runs, so the unmount revert below knows to stand down.
  const rulesCommitted = useRef(false);

  const dirty = nameChanged || industryChanged || rulesChanged;

  // Revert on the way out — covers EVERY exit path (route change, workspace
  // switch, tab close in-app), not just the "All workspaces" link that has its
  // own confirm dialog.
  useEffect(() => {
    return () => {
      if (rulesCommitted.current) return;
      const current = readDecisionRules();
      if (JSON.stringify(current) === JSON.stringify(rulesBaseline.current)) return;
      writeDecisionRules(rulesBaseline.current);
    };
  }, []);

  // Confirmation shown when leaving the tab with unsaved field changes.
  const [leaveWarnOpen, setLeaveWarnOpen] = useState(false);
  // "Delete workspace" confirms first (2026-07-26 per operator) — it used to
  // fire the moment the button was clicked, which is a lot of consequence for
  // a single stray click on a destructive control. Soft delete, so this is a
  // plain confirm rather than the type-the-name gate that guards the
  // irreversible purge in PurgeWorkspaceDialog.
  const [deleteOpen, setDeleteOpen] = useState(false);

  // The name field is read-only until Edit is pressed. Focus + select must run
  // AFTER the re-render that clears `readOnly` — calling them in the same tick
  // would target a still-read-only input, where select() is a no-op in some
  // browsers. rAF is enough: React has committed by the next frame.
  const [editingName, setEditingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  function startEditingName() {
    setEditingName(true);
    requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
  }

  function applyChanges() {
    if (nameChanged) onRename(trimmed);
    if (industryChanged && industryKey) onChangeIndustry(industryKey);
    if (rulesChanged) {
      // Nothing to write — the store already holds the edits. Committing means
      // adopting them as the new baseline so the unmount revert leaves them
      // alone.
      rulesBaseline.current = readDecisionRules();
    }
    rulesCommitted.current = true;
    if (dirty) toast.success("Workspace settings applied.");
  }

  // Guard the "All workspaces" back link: with unsaved changes, warn first.
  function handleBack() {
    if (!onBack) return;
    if (dirty) { setLeaveWarnOpen(true); return; }
    onBack();
  }

  // Register the app-wide guard so a sidebar tab switch warns before the
  // unmount revert throws the edits away (see lib/unsavedGuard).
  useEffect(() => {
    setUnsavedGuard(
      dirty
        ? "You have unapplied changes to this workspace's settings. Leaving now discards them.\n\nLeave without applying?"
        : null,
    );
    return () => setUnsavedGuard(null);
  }, [dirty]);

  // Also catch a full page unload / refresh while there are unsaved changes —
  // the SPA can't intercept a hard reload, so the browser's native prompt is
  // the only cover there.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  return (
    <div className="space-y-6" data-testid="workspace-settings">
      {showBack && onBack && (
        <button
          type="button"
          onClick={handleBack}
          data-testid="workspace-settings-back"
          className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-mute hover:text-ink transition-colors"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          All workspaces
        </button>
      )}

      {/* Name — read-only until Edit is pressed (2026-07-26 per operator), so
          the field reads as the current name rather than an invitation to
          type. Renaming is deliberate and rare; an always-live input next to
          a workspace's identity is easy to change by accident. Still staged —
          committed by "Apply changes", not on blur. */}
      <div className="border-t border-rule/60 pt-6">
        <StepHeading title="Workspace name" body="Rename this workspace — usually the company or entity you're analyzing." />
        <div className="flex items-center gap-2">
          <input
            ref={nameInputRef}
            type="text"
            value={name}
            readOnly={!editingName}
            onChange={(e) => setName(e.currentTarget.value)}
            // Enter commits the edit affordance (not the settings — Apply
            // changes still owns that) and Escape reverts to the stored name,
            // matching how an inline rename is expected to behave.
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); setEditingName(false); }
              if (e.key === "Escape") { setName(workspace.name); setEditingName(false); }
            }}
            // Clicking away re-locks the field. The typed value is KEPT (it's
            // staged for "Apply changes") — only editability is given back, so
            // blurring can't quietly discard a rename in progress.
            onBlur={() => setEditingName(false)}
            data-testid="workspace-settings-name"
            aria-readonly={!editingName}
            // Locked: no text-selection highlight (2026-07-26 per operator).
            // `readOnly` still lets you drag-select the name, which renders the
            // selection colour and makes the field look editable when it
            // isn't. `select-none` + a transparent selection removes that tell.
            className={`w-full h-10 px-3.5 rounded-lg border text-[14px] text-ink placeholder:text-ink-mute transition-colors focus:outline-none ${
              editingName
                ? "border-rule bg-surface focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
                : "border-rule/60 bg-bg-2/40 cursor-default select-none selection:bg-transparent selection:text-ink"
            }`}
          />
          {/* Edit / Done — styled like the public-companies search field
              (2026-07-26 per operator): rounded-xl on `surface`, with the
              brand border + ring as its active treatment. The button STATE
              tracks the field's: locked reads as neutral chrome, unlocked
              carries the same brand ring the input itself shows, so the pair
              reads as one control rather than a button beside a box.

              onMouseDown preventDefault keeps focus in the input — without it
              the input's onBlur re-locks the field a tick before this onClick
              runs, and the button would toggle editing straight back on. */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (editingName) setEditingName(false);
              else startEditingName();
            }}
            data-testid="workspace-settings-name-edit"
            aria-pressed={editingName}
            aria-label={editingName ? "Finish editing workspace name" : "Edit workspace name"}
            title={editingName ? "Finish editing" : "Edit workspace name"}
            className={`shrink-0 inline-flex items-center gap-1.5 h-10 px-4 rounded-xl border text-[13px] font-medium text-ink transition-all focus:outline-none ask-ai-anim-fill [animation-duration:10s] ${
              editingName
                ? "border-brand/60 ring-2 ring-brand/20"
                : "border-brand/40 hover:border-brand/60"
            }`}
          >
            {editingName ? (
              <Check size={14} strokeWidth={2} />
            ) : (
              <Pencil size={14} strokeWidth={1.75} />
            )}
            {editingName ? "Done" : "Edit"}
          </button>
        </div>
      </div>

      {/* Industry — drives which benchmarks CFO AI compares this workspace
          against. Sits above Decision rules so the sector is set before the
          thresholds it contextualizes. Staged; committed by "Apply changes". */}
      <div className="border-t border-rule/60 pt-6">
        <StepHeading
          title="Industry"
          body="Sets the sector benchmarks CFO AI grades this workspace against. Change it if the company's industry was set wrong — a 4× Debt/EBITDA is normal in real estate and alarming in SaaS."
        />
        <OrgIndustryPills value={industryKey} onChange={setIndustryKey} />
      </div>

      {/* Decision rules */}
      <div className="border-t border-rule/60 pt-6">
        <StepHeading
          title="Decision rules"
          body="These rules classify every product into Protect / Watch / Wind down. Tune the thresholds, then press Apply changes — leaving without applying discards them."
        />
        <DecisionRulesPanel />
      </div>

      {/* Actions */}
      <div className="border-t border-rule/60 pt-6">
        <StepHeading
          title="Setup & data"
          body="Deleting hides this workspace and everything in it. You can restore it for 30 days, after which its documents, periods and analyses are erased permanently. If it's your last workspace, you'll return to a clean slate to create a new one."
        />
        {/* Apply shares this row with Reset + Delete (2026-07-26 per
            operator). It's the single commit point for everything above —
            name, industry and the decision rules — and stays disabled until
            something actually changed. */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              resetDecisionRulesToDefaults();
              toast.success("Decision rules reset to defaults.");
            }}
            data-testid="workspace-settings-reset"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 transition-colors"
          >
            <RotateCcw size={14} strokeWidth={1.75} />
            Reset to default
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              data-testid="workspace-settings-delete"
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-red-500/30 bg-red-500/10 text-[13px] font-medium text-red-600 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 size={14} strokeWidth={1.75} />
              Delete workspace
            </button>
          )}
          {/* Apply sits at the far right of this row (2026-07-26 per
              operator) — the commit point for everything above, kept clear of
              the destructive actions on the left. */}
          {dirty && (
            <span className="ml-auto text-[12.5px] text-amber-600" data-testid="workspace-settings-dirty">
              You have unsaved changes.
            </span>
          )}
          <button
            type="button"
            onClick={applyChanges}
            disabled={!dirty}
            data-testid="workspace-settings-apply"
            className={`${dirty ? "" : "ml-auto "}inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors`}
          >
            <Check size={14} strokeWidth={2} />
            Apply changes
          </button>
        </div>
      </div>

      {/* Delete confirmation. Soft delete — the workspace is hidden and
          recoverable from "Recently deleted" for 30 days — so the copy leads
          with what actually happens rather than an alarm the action doesn't
          warrant. Permanent erasure is a separate, harder-gated action. */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-[440px]" data-testid="workspace-settings-delete-dialog">
          <DialogHeader>
            <DialogTitle>Delete “{workspace.name || "this workspace"}”?</DialogTitle>
            <DialogDescription>
              This hides the workspace and everything in it — documents, periods,
              analyses and chat. You can restore it from “Recently deleted” for 30
              days, after which it's erased permanently.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => setDeleteOpen(false)}
              data-testid="workspace-settings-delete-cancel"
              className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { setDeleteOpen(false); onDelete(); }}
              data-testid="workspace-settings-delete-confirm"
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-red-500/30 bg-red-500/10 text-[13px] font-medium text-red-600 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 size={14} strokeWidth={1.75} />
              Delete workspace
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved-changes guard when leaving via "All workspaces". */}
      <Dialog open={leaveWarnOpen} onOpenChange={setLeaveWarnOpen}>
        <DialogContent className="sm:max-w-[420px]" data-testid="workspace-settings-leave-dialog">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              You changed this workspace's settings but haven't applied them. Leaving now discards those changes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => setLeaveWarnOpen(false)}
              className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 transition-colors"
            >
              Keep editing
            </button>
            <button
              type="button"
              onClick={() => { applyChanges(); setLeaveWarnOpen(false); onBack?.(); }}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors"
            >
              Apply &amp; leave
            </button>
            <button
              type="button"
              onClick={() => { setLeaveWarnOpen(false); onBack?.(); }}
              data-testid="workspace-settings-leave-discard"
              className="inline-flex items-center h-9 px-3.5 rounded-lg border border-red-500/30 bg-red-500/10 text-[13px] font-medium text-red-600 hover:bg-red-500/20 transition-colors"
            >
              Discard &amp; leave
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
