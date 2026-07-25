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

import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Clock,
  Cloud,
  Eye,
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
import type { DocumentRow } from "@/lib/supabase";
import { openUploadedFilePreview } from "@/lib/stagedFilePreview";

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
import { useActivePeriod } from "@/lib/activePeriod";
import { fetchOrgPeriodsFor, formatPeriodMonth, useOrgPeriods } from "@/lib/orgPeriods";
import { uploadExcelToBackend } from "@/lib/api";
import { setActiveRun, setAnalysis, setUploadAlerts } from "@/lib/runStore";
import { resetDecisionRulesToDefaults } from "@/lib/decisionRulesStore";
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

  // Settings "tab" — its own header + description, replacing the hub view.
  if (editingWorkspace) {
    return (
      <section className="max-w-[1280px] space-y-8" data-testid="workspace-page">
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

  return (
    <section className="max-w-[1280px] space-y-8" data-testid="workspace-page">
      {/* With zero workspaces (e.g. the user deleted them all) drop straight
          into the create-workspace flow instead of a landing hero. Keep the hub
          while the list is still loading or when workspaces exist, so users who
          have workspaces never see the create form flash. */}
      {done && !activeNeedsOnboarding && (ws.loading || ws.workspaces.length > 0) ? (
        <>
          {/* Your workspaces — the switcher (with the Create card as its first
              grid item) sits ABOVE the title so the title can name whichever
              workspace is currently selected. */}
          <WorkspaceHub
            onEdit={(id) => { ws.select(id); setEditingId(id); }}
            onCreate={startNewWorkspace}
          />

          {/* Title reflects the selected workspace; its edit tab renders
              directly beneath it. Gated on !ws.loading so it doesn't flash the
              "Manage" section for a stale active id during the initial resolve
              (the active id is only nulled once the workspace list resolves). */}
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
        </>
      ) : (
        <>
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
            // Back from the first step always returns to the workspaces screen —
            // which renders the no-workspaces hero when the user has none, so
            // they're never trapped in the wizard.
            onExit={() => { setCreatingNew(false); writeDone(true); setDone(true); }}
          />
        </>
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
  initialIndustryKey = null,
}: {
  onDone: (industry: OnboardingIndustry | null) => void;
  onExit?: () => void;
  /** Prefill when restarting setup on a workspace that already has one. */
  initialIndustryKey?: string | null;
}) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [name, setName] = useState<string>(readWorkspaceName);
  const [industryKey, setIndustryKey] = useState<string | null>(initialIndustryKey);
  const [busy, setBusy] = useState(false);

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
        {/* Back appears from step 1 onward; the step-0 "All workspaces" exit
            button was removed per the operator. A spacer keeps Continue right. */}
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
            <button
              type="button"
              onClick={next}
              disabled={step === 0 && (name.trim().length === 0 || !industryKey)}
              data-testid="onboarding-next"
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Continue
            </button>
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

// ─── Month switcher ──────────────────────────────────────────────────────────
// One trial balance per month: every upload creates a period (its
// closing date = the month it covers) scoped to the active workspace.
// This section lists them newest-first as month pills; picking one sets
// `?period=<id>` — the app-wide active-period key — so the dashboard,
// statements, ratios, and the TopHeader "[workspace] - [month]" readout
// all flip to that month's data. Hidden until the workspace has at
// least one uploaded period.

function MonthsSection({ compact = false, orgId }: { compact?: boolean; orgId?: string }) {
  // When an orgId is given, scope the months to THAT workspace (used by the
  // selected-workspace panel); otherwise fall back to the active workspace.
  const active = useOrgPeriods();
  const scoped = useQuery({
    queryKey: ["org-periods", orgId],
    queryFn: () => fetchOrgPeriodsFor(orgId as string),
    enabled: !!orgId,
    staleTime: 60_000,
  });
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedId = params.get("period");
  const periods = orgId
    ? (scoped.data?.periods ?? [])
        .filter((p) => p.documents.length > 0)
        .sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? ""))
    : (active.data?.periods ?? []);

  // "Add month" — upload a new trial balance for another period. Routes to the
  // dashboard's empty/upload state (?empty=1 forces it even when a period is
  // already loaded) so the dropzone is ready.
  const addMonthBtn = (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); navigate("/dashboard?empty=1"); }}
      data-testid="workspace-add-month"
      className={`inline-flex items-center gap-1 rounded-full border border-dashed border-rule ${compact ? "h-8 px-3 text-[12px]" : "h-9 px-3.5 text-[13px]"} font-medium text-ink-mute hover:text-ink hover:border-brand/50 transition-colors`}
    >
      <Plus size={compact ? 13 : 14} strokeWidth={2} />
      Add month
    </button>
  );

  // Even with no months yet, still offer "Add month" (compact/in-card only).
  if (periods.length === 0) {
    return compact ? (
      <div className="mt-3 border-b border-rule/60 pb-4" data-testid="workspace-months">
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold mb-2">Months</div>
        {addMonthBtn}
      </div>
    ) : null;
  }

  function pickMonth(periodId: string) {
    const sp = new URLSearchParams(params);
    sp.set("period", periodId);
    // Replace, not push — month switching is substitution, and back
    // should leave the page, not replay every month ever selected.
    setParams(sp, { replace: true });
  }

  const pills = (
    <div className="flex flex-wrap gap-2">
      {periods.map((p) => {
        const label = formatPeriodMonth(p.period_end) ?? p.period_label;
        const selected = p.period_id === selectedId;
        return (
          <button
            key={p.period_id}
            type="button"
            onClick={(e) => { e.stopPropagation(); pickMonth(p.period_id); }}
            aria-pressed={selected}
            data-testid={`workspace-month-${p.period_id}`}
            className={`
              inline-flex items-center gap-1.5 ${compact ? "h-8 px-3 text-[12px]" : "h-9 px-3.5 text-[13px]"} rounded-full border
              font-medium tabular-nums transition-colors
              ${selected
                ? "border-brand/60 bg-brand/15 text-ink"
                : "border-rule bg-surface text-ink-soft hover:text-ink hover:bg-bg-2/60 hover:border-rule-strong"}
            `}
          >
            {label}
          </button>
        );
      })}
      {addMonthBtn}
    </div>
  );

  // Compact — embedded inside a workspace item card: just a small label + the
  // month pills, no standalone-section paragraph.
  if (compact) {
    return (
      <div className="mt-3 border-b border-rule/60 pb-4" data-testid="workspace-months">
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold mb-2">
          Months
        </div>
        {pills}
      </div>
    );
  }

  return (
    <section className="space-y-2" data-testid="workspace-months">
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
        Months
      </div>
      <p className="text-[12px] text-ink-soft">
        Each uploaded trial balance is one month of this workspace. Pick a
        month to analyze it everywhere — upload a new trial balance from the
        Dashboard to add the next month.
      </p>
      {pills}
    </section>
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
    queryFn: () => fetchOrgPeriodsFor(workspace.id),
    staleTime: 60_000,
  });
  const docsQ = useQuery({
    queryKey: ["workspace-docs", workspace.id],
    queryFn: async () => {
      const { listDocumentsForOrg } = await import("@/lib/supabase");
      return listDocumentsForOrg(workspace.id);
    },
    staleTime: 60_000,
  });
  const loading = monthsQ.isLoading || docsQ.isLoading;

  return (
    <div className="space-y-6 border-t border-rule/60 pt-8" data-testid="selected-workspace-panel">
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
      <div className="relative">
        <div
          aria-busy={loading}
          className={`transition-[filter,opacity] duration-300 ${
            loading ? "blur-md opacity-20 pointer-events-none select-none" : ""
          }`}
        >
          <div className="space-y-6">
            <MonthsSection compact orgId={workspace.id} />
            <WorkspaceUploadsSection orgId={workspace.id} filterPeriodId={period.id} />
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
        {loading && (
          <div
            className="absolute inset-0 grid place-items-center"
            data-testid="workspace-panel-loading"
          >
            <div className="flex flex-col items-center gap-2 text-ink-mute">
              <Loader2 size={26} strokeWidth={2} className="animate-spin text-brand-d" />
              <span className="text-[12px] font-medium">Loading workspace…</span>
            </div>
          </div>
        )}
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
    queryFn: () => fetchOrgPeriodsFor(orgId),
    staleTime: 60_000,
  });
  const periods = (data?.periods ?? [])
    .filter((p) => p.documents.length > 0)
    .sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? ""));
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="workspace-card-months">
      {periods.length === 0 ? (
        <span className="inline-flex items-center h-6 px-2 rounded-full border border-dashed border-rule text-[11px] font-medium text-ink-mute">
          No months
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

function WorkspaceUploadsSection({ orgId, filterPeriodId }: { orgId: string; filterPeriodId?: string | null }) {
  // Uploads are always shown (no collapse) — fetched on mount, cached per org.
  const { data: allDocs, isLoading } = useQuery({
    queryKey: ["workspace-docs", orgId],
    queryFn: async () => {
      const { listDocumentsForOrg } = await import("@/lib/supabase");
      return listDocumentsForOrg(orgId);
    },
    staleTime: 60_000,
  });

  // When a month is selected (active workspace), show only that month's files.
  // Otherwise show everything the workspace has.
  const docs = filterPeriodId
    ? (allDocs ?? []).filter((d) => d.period_id === filterPeriodId)
    : allDocs;

  // Nothing to show → render nothing at all (no header, no empty text).
  if (!isLoading && (!docs || docs.length === 0)) return null;

  return (
    <div className="mt-3 border-t border-rule/60 pt-2.5">
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold mb-2">
        Uploads
        {docs && docs.length > 0 && (
          <span className="ml-1 font-normal tabular-nums normal-case tracking-normal">({docs.length})</span>
        )}
      </div>

      <div data-testid="workspace-uploads-list">
        {isLoading ? (
          <div className="text-[12px] text-ink-mute py-1">Loading uploads…</div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(docs ?? []).map((d) => (
              <WorkspaceUploadRow key={d.id} doc={d} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function WorkspaceUploadRow({ doc }: { doc: DocumentRow }) {
  const uploaded = doc.created_at
    ? new Date(doc.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : null;

  function view() {
    void openUploadedFilePreview(doc.original_filename ?? "document", async () => {
      const { signedDocumentUrl } = await import("@/lib/supabase");
      return signedDocumentUrl(doc);
    });
  }

  // The whole item is the affordance now — pressing it opens the file preview
  // in a new tab (no status pill, no separate View button).
  return (
    <li>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); view(); }}
        aria-label={`Preview ${doc.original_filename ?? "document"}`}
        title="Open preview in a new tab"
        data-testid="workspace-upload-view"
        className="group/upload w-full flex items-center gap-2.5 rounded-lg border border-rule bg-bg-2/30 p-3 text-left hover:bg-bg-2/60 hover:border-rule-strong transition-colors"
      >
        <FileSpreadsheet size={15} strokeWidth={1.75} className="text-ink-mute shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-ink truncate">{doc.original_filename}</div>
          {uploaded && <div className="text-[10.5px] text-ink-mute">{uploaded}</div>}
        </div>
        <Eye
          size={14}
          strokeWidth={1.75}
          className="text-ink-mute shrink-0 opacity-0 group-hover/upload:opacity-100 transition-opacity"
        />
      </button>
    </li>
  );
}

function WorkspaceHub({ onEdit, onCreate }: { onEdit: (id: string) => void; onCreate: () => void }) {
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
    if (id === currentId) return;
    await select(id);
    const target = workspaces.find((w) => w.id === id);
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

  return (
    <div className="space-y-4">
      {/* All workspaces — the label is omitted in the empty state, where the
          hero's "Your workspaces" eyebrow already stands in for it. */}
      {workspaces.length > 0 && (
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
          {workspaces.length === 1 ? "Your workspace" : "Your workspaces"}
        </div>
      )}

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

      {workspaces.length === 0 ? (
        <div data-testid="workspace-empty">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
            <Sparkles size={10} strokeWidth={2.25} className="text-brand-d" />
            Your workspaces
          </div>
          <h1 className="mt-3 font-serif text-[44px] sm:text-[56px] leading-[1.04] tracking-[-0.02em] text-ink max-w-[820px]">
            Create your first{" "}
            <span className="text-grad">workspace</span>.
          </h1>
          <p className="mt-5 text-[15.5px] text-ink-soft max-w-[680px] leading-relaxed">
            A workspace is your company's home in CFO AI — where your trial balances,
            months, benchmarks and settings live together. Set up your company to start
            working; then upload its trial balance ({" "}
            <span className="inline-flex items-center align-middle text-[10px] uppercase tracking-[0.08em] font-semibold text-ink bg-bg-2 border border-rule-strong rounded-full px-2 py-0.5">XLSX</span>
            {" "}or{" "}
            <span className="inline-flex items-center align-middle text-[10px] uppercase tracking-[0.08em] font-semibold text-ink bg-bg-2 border border-rule-strong rounded-full px-2 py-0.5">PDF</span>
            {" "}from SAGA, WinMentor, SmartBill, NEXTUP or CIEL) and CFO AI reconstructs the
            full picture: P&amp;L, Balance Sheet, Cash Flow, Ratios, Valuation, Risk, and
            Recommendations.
          </p>
          <div className="mt-5">
            <button
              type="button"
              onClick={onCreate}
              data-testid="workspace-empty-create"
              className="inline-flex items-center justify-center h-10 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors"
            >
              Create workspace
            </button>
          </div>
        </div>
      ) : (
      <ul className="flex flex-wrap gap-3 items-stretch" data-testid="workspace-list">
        {/* Create workspace — a compact square, kept to its own size (not
            stretched to match the item cards) and flush next to the first
            item. */}
        <li>
          <button
            type="button"
            onClick={onCreate}
            data-testid="workspace-create"
            className="group h-full w-36 flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-rule px-3 py-3 text-center text-ink-mute hover:text-ink hover:border-rule-strong hover:bg-bg-2/40 transition-colors"
          >
            <span className="grid place-items-center h-8 w-8 rounded-full border border-rule group-hover:border-rule-strong transition-colors">
              <Plus size={18} strokeWidth={2.25} />
            </span>
            <span className="text-[12.5px] font-medium leading-tight">Create workspace</span>
          </button>
        </li>
        {workspaces.map((w) => {
          const isActive = w.id === currentId;
          return (
            <li key={w.id} className="w-[248px]">
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
                className={`group relative h-full rounded-2xl border px-4 py-3 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  isActive
                    ? "border-brand/40 bg-brand/[0.06]"
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
          <li key={w.id} className="w-[200px]">
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
      )}

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
  // "Apply changes" button — the per-field Save was removed. `name` + industry
  // are the tracked settings; decision rules keep their own live semantics
  // (the DecisionRulesPanel applies immediately and is used elsewhere too).
  const [name, setName] = useState(workspace.name);
  const [industryKey, setIndustryKey] = useState<string | null>(workspace.industryKey ?? null);
  const trimmed = name.trim();
  const nameChanged = trimmed.length > 0 && trimmed !== workspace.name;
  const industryChanged = (industryKey ?? "") !== (workspace.industryKey ?? "");
  const dirty = nameChanged || industryChanged;

  // Confirmation shown when leaving the tab with unsaved field changes.
  const [leaveWarnOpen, setLeaveWarnOpen] = useState(false);

  function applyChanges() {
    if (nameChanged) onRename(trimmed);
    if (industryChanged && industryKey) onChangeIndustry(industryKey);
    if (dirty) toast.success("Workspace settings applied.");
  }

  // Guard the "All workspaces" back link: with unsaved changes, warn first.
  function handleBack() {
    if (!onBack) return;
    if (dirty) { setLeaveWarnOpen(true); return; }
    onBack();
  }

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

      {/* Name — staged; committed by "Apply changes" below (no inline Save). */}
      <div>
        <StepHeading title="Workspace name" body="Rename this workspace — usually the company or entity you're analyzing." />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          data-testid="workspace-settings-name"
          className="w-full h-10 px-3.5 rounded-lg border border-rule bg-surface text-[14px] text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
        />
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
          body="These rules classify every product into Protect / Watch / Wind down. Tune the thresholds — changes apply immediately."
        />
        <DecisionRulesPanel />
      </div>

      {/* Actions */}
      <div className="border-t border-rule/60 pt-6">
        <StepHeading
          title="Setup & data"
          body="Deleting hides this workspace and everything in it. You can restore it for 30 days, after which its documents, periods and analyses are erased permanently. If it's your last workspace, you'll return to a clean slate to create a new one."
        />
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
              onClick={onDelete}
              data-testid="workspace-settings-delete"
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-red-500/30 bg-red-500/10 text-[13px] font-medium text-red-600 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 size={14} strokeWidth={1.75} />
              Delete workspace
            </button>
          )}
        </div>
      </div>

      {/* Apply bar — the single commit point for the tab's field settings
          (name + industry). Disabled until something changed; shows an
          unsaved-changes hint while dirty. */}
      <div className="border-t border-rule/60 pt-6 flex flex-wrap items-center justify-end gap-3">
        {dirty && (
          <span className="text-[12.5px] text-amber-600 mr-auto" data-testid="workspace-settings-dirty">
            You have unsaved changes.
          </span>
        )}
        <button
          type="button"
          onClick={applyChanges}
          disabled={!dirty}
          data-testid="workspace-settings-apply"
          className="inline-flex items-center gap-1.5 h-10 px-5 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Check size={14} strokeWidth={2} />
          Apply changes
        </button>
      </div>

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
