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

import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  FileSpreadsheet,
  Pencil,
  Plus,
  Trash2,
  UploadCloud,
} from "lucide-react";

import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { DecisionRulesPanel } from "@/components/cfo/command/DecisionRulesModal";
import { toast } from "@/components/ui/sonner";
import { useActivePeriod } from "@/lib/activePeriod";
import { uploadExcelToBackend } from "@/lib/api";
import { setActiveRun, setAnalysis, setUploadAlerts } from "@/lib/runStore";
import { readWorkspaceName, writeWorkspaceName } from "@/lib/workspaceName";
import { useWorkspaces, type Workspace } from "@/lib/workspaces";

// ── Local persistence — the "onboarding done" flag lives in the browser.
//    The workspace name is owned by lib/workspaceName (shared with the
//    TopHeader tagline, which reflects it live).
const ONBOARDED_KEY = "cfoai:v1:workspace-onboarded";

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
  const editingWorkspace = editingId ? ws.workspaces.find((w) => w.id === editingId) ?? null : null;

  // Start a brand-new workspace: clear the name and re-enter onboarding. The
  // new entry is only committed to the list on finish (in onDone below).
  function startNewWorkspace() {
    setCreatingNew(true);
    writeWorkspaceName("");
    writeDone(false);
    setDone(false);
  }

  function finishOnboarding() {
    const name = readWorkspaceName();
    if (creatingNew) ws.create(name);
    else ws.upsertCurrentName(name);
    setCreatingNew(false);
    writeDone(true);
    setDone(true);
  }

  // Settings "tab" — its own header + description, replacing the hub view.
  if (editingWorkspace) {
    return (
      <section className="max-w-[900px] space-y-8" data-testid="workspace-page">
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
          canDelete={ws.workspaces.length > 1}
          onBack={() => setEditingId(null)}
          onRename={(name) => ws.rename(editingWorkspace.id, name)}
          onDelete={() => { ws.remove(editingWorkspace.id); setEditingId(null); }}
        />
      </section>
    );
  }

  return (
    <section className="max-w-[900px] space-y-8" data-testid="workspace-page">
      <PageHeader
        hero
        eyebrow="Workspace"
        title={
          done ? (
            <>
              Everything in your workspace,{" "}
              <span className="text-grad">in one place</span>.
            </>
          ) : (
            <>
              Set up your <span className="text-grad">workspace</span>.
            </>
          )
        }
        subtitle={
          done
            ? "See the company and period you're analyzing, and jump straight into any view — dashboard, benchmark, products, or the CFO assistant — without losing your place."
            : "Name your workspace, tune the decision rules that classify your products, and upload your data — three quick steps and CFO AI is ready to analyze."
        }
      />

      {done && (
        <div>
          <button
            type="button"
            onClick={startNewWorkspace}
            data-testid="workspace-create"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand text-bg px-4 py-2 text-[13px] font-medium shadow-[0_6px_16px_-6px_rgba(42,168,155,0.55)] hover:brightness-110 ring-1 ring-inset ring-white/15 transition-all"
          >
            <Plus size={15} strokeWidth={2} />
            Create workspace
          </button>
        </div>
      )}

      {done ? (
        <WorkspaceHub onEdit={(id) => { ws.select(id); setEditingId(id); }} />
      ) : (
        <Onboarding
          onDone={finishOnboarding}
          // Only offer "exit to the workspace listing" when there IS a listing
          // to return to (i.e. at least one workspace already exists — this run
          // is a create-additional / restart, not the very first setup).
          onExit={
            ws.workspaces.length > 0
              ? () => { setCreatingNew(false); writeDone(true); setDone(true); }
              : undefined
          }
        />
      )}
    </section>
  );
}

// ─── Onboarding wizard ───────────────────────────────────────────────────────

const STEP_LABELS = ["Name", "Decision rules", "Upload"] as const;

function Onboarding({ onDone, onExit }: { onDone: () => void; onExit?: () => void }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [name, setName] = useState<string>(readWorkspaceName);
  const [busy, setBusy] = useState(false);

  function next() {
    if (step === 0) writeWorkspaceName(name.trim());
    setStep((s) => (Math.min(2, s + 1) as 0 | 1 | 2));
  }
  function back() {
    // At the first step, Back leaves onboarding entirely and returns to the
    // workspace listing (when there is one — see `onExit` in the parent).
    if (step === 0) { onExit?.(); return; }
    setStep((s) => (Math.max(0, s - 1) as 0 | 1 | 2));
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
      onDone();
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

      <div className="rounded-2xl border border-rule bg-surface p-5 sm:p-6">
        {step === 0 && <StepName name={name} setName={setName} />}
        {step === 1 && <StepRules />}
        {step === 2 && <StepUpload busy={busy} onUpload={handleUpload} />}
      </div>

      {/* Wizard navigation */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={back}
          // Disabled only on the very first setup (no listing to exit to).
          disabled={step === 0 && !onExit}
          data-testid="onboarding-back"
          className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-rule bg-surface text-[13px] font-medium text-ink hover:bg-bg-2/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          {step === 0 && onExit ? "All workspaces" : "Back"}
        </button>

        <div className="flex items-center gap-3">
          {step === 2 && (
            <button
              type="button"
              onClick={onDone}
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
              disabled={step === 0 && name.trim().length === 0}
              data-testid="onboarding-next"
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-brand text-bg text-[13px] font-medium shadow-[0_6px_16px_-6px_rgba(42,168,155,0.55)] hover:brightness-110 ring-1 ring-inset ring-white/15 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
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
              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold transition-colors ${
                isDone
                  ? "bg-brand text-paper"
                  : isActive
                  ? "bg-brand/15 text-brand-d ring-2 ring-brand/30"
                  : "bg-bg-2 text-ink-mute border border-rule"
              }`}
            >
              {isDone ? <Check size={14} strokeWidth={2.5} /> : i + 1}
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

function StepName({ name, setName }: { name: string; setName: (v: string) => void }) {
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
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); pick(e.dataTransfer.files); }}
        data-testid="onboarding-dropzone"
        className={`relative overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-150 px-6 py-10 text-center ${
          dragOver
            ? "border-brand bg-brand/10 ring-2 ring-inset ring-brand/30"
            : "border-rule/80 bg-gradient-to-br from-bg-2/30 via-surface/60 to-surface/40 hover:border-rule-strong hover:from-bg-2/50"
        }`}
      >
        {busy ? (
          <div className="flex items-center justify-center gap-3 text-ink-soft">
            <FileSpreadsheet size={20} strokeWidth={1.75} className="text-brand" />
            <span className="text-[13.5px]">Importing your workbook…</span>
          </div>
        ) : (
          <>
            <UploadCloud size={26} strokeWidth={1.5} className="text-ink-mute mx-auto" />
            <div className="mt-3 text-[13.5px] text-ink">Drop your workbook here</div>
            <div className="mt-1 text-[11.5px] text-ink-mute">.xlsx or .csv up to 25MB</div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              data-testid="onboarding-choose-file"
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand text-bg px-4 py-2 text-[13px] font-medium hover:brightness-110 ring-1 ring-inset ring-white/15 transition"
            >
              Choose file
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Post-onboarding hub ─────────────────────────────────────────────────────

function WorkspaceHub({ onEdit }: { onEdit: (id: string) => void }) {
  const period = useActivePeriod();
  const navigate = useNavigate();
  const { workspaces, currentId, select, setPeriod } = useWorkspaces();

  // What the ACTIVE workspace is currently showing (company + period), used to
  // enrich the highlighted row.
  const activeCompany =
    period.statements?.companyName ?? period.label ?? (readWorkspaceName() || null);

  // Keep the current workspace's remembered period in sync with what's loaded,
  // so switching back to it later restores the same analysis.
  useEffect(() => {
    if (currentId) setPeriod(currentId, period.id ?? null);
  }, [currentId, period.id, setPeriod]);

  function switchTo(id: string) {
    if (id === currentId) return;
    select(id);
    const target = workspaces.find((w) => w.id === id);
    const qs = target?.periodId ? `?period=${encodeURIComponent(target.periodId)}` : "";
    navigate(`/workspace${qs}`, { replace: true });
  }

  return (
    <div className="space-y-4">
      {/* All workspaces */}
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
        {workspaces.length === 1 ? "Your workspace" : "Your workspaces"}
      </div>

      <ul className="space-y-2" data-testid="workspace-list">
        {workspaces.map((w) => {
          const isActive = w.id === currentId;
          return (
            <li key={w.id}>
              <div
                className={`group relative rounded-2xl border px-5 py-4 transition-colors ${
                  isActive
                    ? "border-brand/40 bg-brand/[0.06]"
                    : "border-rule bg-surface hover:border-rule-strong hover:bg-bg-2/40"
                }`}
              >
                <button
                  type="button"
                  onClick={() => switchTo(w.id)}
                  data-testid="workspace-list-item"
                  data-active={isActive ? "true" : "false"}
                  className="w-full text-left pr-10"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-serif text-[19px] text-ink leading-tight truncate">
                      {w.name || "Untitled workspace"}
                    </span>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-brand-d">
                        <Check size={13} strokeWidth={2.5} />
                        Active
                      </span>
                    )}
                  </div>
                  {isActive ? (
                    activeCompany && activeCompany !== w.name ? (
                      <div className="mt-1 text-[13px] text-ink-soft">
                        {activeCompany}
                        {period.label && period.label !== activeCompany && (
                          <span className="text-ink-mute"> · {period.label}</span>
                        )}
                      </div>
                    ) : (
                      <div className="mt-1 text-[13px] text-ink-soft">
                        No data loaded yet —{" "}
                        <NavLink
                          to="/dashboard"
                          onClick={(e) => e.stopPropagation()}
                          className="text-brand-d hover:underline underline-offset-2"
                        >
                          upload a trial balance
                        </NavLink>
                        .
                      </div>
                    )
                  ) : (
                    <div className="mt-1 text-[12.5px] text-ink-mute">Tap to switch</div>
                  )}
                </button>

                {/* Edit — opens this workspace's settings tab. */}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onEdit(w.id); }}
                  aria-label="Workspace settings"
                  title="Workspace settings"
                  data-testid="workspace-edit"
                  className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-mute hover:text-ink hover:bg-bg-2/70 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition"
                >
                  <Pencil size={14} strokeWidth={1.75} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Workspace settings sub-view ─────────────────────────────────────────────
function WorkspaceSettings({
  workspace,
  canDelete,
  onBack,
  onRename,
  onDelete,
}: {
  workspace: Workspace;
  canDelete: boolean;
  onBack: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(workspace.name);
  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== workspace.name;

  return (
    <div className="space-y-6" data-testid="workspace-settings">
      <button
        type="button"
        onClick={onBack}
        data-testid="workspace-settings-back"
        className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-mute hover:text-ink transition-colors"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        All workspaces
      </button>

      {/* Name */}
      <div className="rounded-2xl border border-rule bg-surface p-5">
        <StepHeading title="Workspace name" body="Rename this workspace — usually the company or entity you're analyzing." />
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-testid="workspace-settings-name"
            className="flex-1 h-10 px-3.5 rounded-lg border border-rule bg-surface text-[14px] text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
          />
          <button
            type="button"
            onClick={() => { if (dirty) onRename(trimmed); }}
            disabled={!dirty}
            data-testid="workspace-settings-save"
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-brand text-bg text-[13px] font-medium hover:brightness-110 ring-1 ring-inset ring-white/15 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Save
          </button>
        </div>
      </div>

      {/* Decision rules */}
      <div className="rounded-2xl border border-rule bg-surface p-5">
        <StepHeading
          title="Decision rules"
          body="These rules classify every product into Protect / Watch / Wind down. Tune the thresholds — changes apply immediately."
        />
        <DecisionRulesPanel />
      </div>

      {/* Actions */}
      <div className="rounded-2xl border border-rule bg-surface p-5">
        <StepHeading title="Setup & data" body="Remove this workspace entirely." />
        <div className="flex flex-wrap items-center gap-3">
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              data-testid="workspace-settings-delete"
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-red-500/30 text-[13px] font-medium text-red-600 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={14} strokeWidth={1.75} />
              Delete workspace
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
