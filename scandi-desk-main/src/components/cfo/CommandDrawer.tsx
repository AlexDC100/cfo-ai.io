// Command Center — right-side glass drawer.
//
// Apple-style command panel: rounded 24px corners, dark glass surface,
// segmented control for tabs, grouped cards inside each tab. Replaces the
// legacy Settings page entirely; opens from the burger button on every page.
//
// Tabs:
//   · Workspace — switcher, dataset, sync history
//   · Data      — upload, ERP, sync status
//   · Rules     — Protect / Watch · Fix · Reduce / Liquidate · Scale
//   · AI        — open chat, briefing, board summary, simulate, supplier draft
//   · Account   — profile, theme, sign-out

import { ReactNode, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "@/components/ui/sonner";
import {
  Building2,
  Database,
  Settings2,
  Users,
  Plug,
  Sparkles,
  FileBarChart2,
  ListChecks,
  CircleDollarSign,
  User,
  LogOut,
  ChevronRight,
  UploadCloud,
  Activity,
  Sun,
  Moon,
  Monitor,
  X,
  Hammer,
  Mail,
  Download,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useThresholds, writeThresholds, DEFAULTS } from "@/lib/thresholds";
import {
  SPECS,
  type ThresholdSpec,
  isAtCalibrated,
} from "@/lib/thresholdSchema";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the AI chat from the drawer (used by the AI tab). */
  onOpenAi?: () => void;
  /** Open the search palette from the drawer (used by the Workspace tab). */
  onOpenSearch?: () => void;
  /** Open the upload dialog from the drawer (used by the Data tab). */
  onOpenUpload?: () => void;
}

type Tab = "workspace" | "data" | "rules" | "ai" | "account";
const TABS: { id: Tab; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "data",      label: "Data" },
  { id: "rules",     label: "Rules" },
  { id: "ai",        label: "AI" },
  { id: "account",   label: "Account" },
];

export function CommandDrawer({
  open,
  onOpenChange,
  onOpenAi,
  onOpenSearch,
  onOpenUpload,
}: Props) {
  const [tab, setTab] = useState<Tab>("workspace");

  function close(after?: () => void) {
    onOpenChange(false);
    if (after) setTimeout(after, 220);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="
          w-[calc(100vw-24px)] sm:w-[420px] sm:max-w-[420px]
          p-0 m-3 h-[calc(100vh-24px)]
          rounded-3xl
          bg-surface dark:bg-bg-2
          border border-rule-strong
          text-ink
          shadow-4
          [&>button.absolute]:hidden
          flex flex-col
        "
      >
        {/* ─── Header ─────────────────────────── */}
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-center justify-between mb-4">
            <SheetTitle className="text-[15px] font-medium text-ink">
              Command Center
            </SheetTitle>
            <button
              onClick={() => onOpenChange(false)}
              aria-label="Close"
              className="text-ink-mute hover:text-ink p-1 -m-1 rounded-md transition-colors"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>

          {/* Workspace mini card */}
          <div className="rounded-xl border border-rule bg-bg-2 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="w-7 h-7 rounded-md bg-brand/15 grid place-items-center shrink-0">
                <Building2 size={14} strokeWidth={1.75} className="text-brand-d" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink leading-tight">
                  Your workspace
                </div>
                <div className="text-[11px] text-ink-soft mt-0.5 leading-tight">
                  No dataset connected
                </div>
              </div>
            </div>
          </div>

          {/* Segmented control */}
          <div
            role="tablist"
            className="mt-4 grid grid-cols-5 gap-0.5 p-0.5 rounded-lg bg-bg-2 border border-rule"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`
                  rounded-md py-1.5 text-[12px] font-medium transition-colors
                  ${tab === t.id
                    ? "bg-surface text-ink shadow-1"
                    : "text-ink-soft hover:text-ink"}
                `}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Content ─────────────────────────── */}
        <div className="px-5 pb-6 overflow-y-auto flex-1">
          {tab === "workspace" && (
            <WorkspaceTab onSearch={() => close(onOpenSearch)} onClose={() => onOpenChange(false)} />
          )}
          {tab === "data" && <DataTab onUpload={() => close(onOpenUpload)} />}
          {tab === "rules" && <RulesTab />}
          {tab === "ai" && <AiTab onOpenAi={onOpenAi} onClose={() => onOpenChange(false)} />}
          {tab === "account" && <AccountTab onClose={() => onOpenChange(false)} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Shared building blocks ──────────────────────────────────────────────

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute mb-2.5 px-1 font-medium">
        {label}
      </div>
      <div className="rounded-xl border border-rule bg-bg-2 divide-y divide-rule overflow-hidden">
        {children}
      </div>
    </section>
  );
}

function Row({
  icon: Icon,
  title,
  hint,
  trailing,
  onClick,
  comingSoon: isComingSoon,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  trailing?: ReactNode;
  onClick?: () => void;
  /** Renders the row as a visually-inactive "coming soon" placeholder.
   *  The row is still clickable so users get a friendly explanation
   *  toast, but the visual state communicates "not yet available —
   *  future upgrade" rather than the previous "Not connected" framing
   *  that implied it was a configurable feature. */
  comingSoon?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`
        w-full flex items-center gap-3 px-4 py-3 text-left
        transition-colors
        ${isComingSoon
          ? "opacity-70 hover:opacity-100 cursor-default"
          : "hover:bg-surface"}
      `}
      data-coming-soon={isComingSoon ? "true" : undefined}
    >
      <span className={`
        w-7 h-7 rounded-md grid place-items-center
        border border-rule text-ink-soft shrink-0
        ${isComingSoon ? "bg-bg-2/40" : "bg-surface"}
      `}>
        <Icon size={14} strokeWidth={1.75} />
      </span>
      <div className="flex-1 min-w-0">
        <div className={`text-[13.5px] leading-tight ${isComingSoon ? "text-ink-soft" : "text-ink"}`}>
          {title}
        </div>
        {hint && <div className="text-[11.5px] text-ink-mute mt-0.5 leading-tight">{hint}</div>}
      </div>
      {trailing ?? (
        isComingSoon ? (
          <span className="
            inline-flex items-center h-5 px-2 rounded-full
            text-[9.5px] uppercase tracking-[0.1em] font-semibold
            bg-bg-2/60 border border-rule text-ink-mute
            shrink-0
          ">
            Coming soon
          </span>
        ) : (
          <ChevronRight size={13} strokeWidth={1.75} className="text-ink-mute shrink-0" />
        )
      )}
    </button>
  );
}

// ─── Tabs ──────────────────────────────────────────────────────────────

// Tiny placeholder helpers so every Row has a wired action. Backends for
// these land in later milestones; until then we surface friendly toasts so
// no click is silent.

function comingSoon(title: string, body: string) {
  toast(title, { description: body });
}

function WorkspaceTab({
  onSearch,
  onClose,
}: {
  onSearch: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <Section label="Workspace">
        <Row
          icon={Building2}
          title="Switch workspace"
          hint="Your workspace"
          onClick={() =>
            comingSoon(
              "Single workspace",
              "Multi-tenant switching ships with the upload flow.",
            )
          }
        />
        <Row
          icon={Database}
          title="Search dataset"
          hint="Browse SKUs and categories"
          onClick={onSearch}
        />
      </Section>
      <Section label="General">
        <Row
          icon={CircleDollarSign}
          title="Cost of capital"
          hint="6.5% annual"
          onClick={() =>
            comingSoon(
              "Cost of capital",
              "Adjustable in Rules → Engine. Currently 6.5% per the seed config.",
            )
          }
        />
        <Row
          icon={Users}
          title="Users"
          hint="Invite teammates"
          onClick={() =>
            comingSoon(
              "User management",
              "Invites + roles ship with the auth layer (Supabase wiring).",
            )
          }
        />
      </Section>
    </>
  );
}

function DataTab({ onUpload: _onUpload }: { onUpload: () => void }) {
  // The "Upload workbook" entry was removed in the upload consolidation
  // pass — there's a single canonical upload concept now (Dashboard's
  // empty-state zone + the Replace dropdown). The legacy inventory-XLSX
  // dialog remains reachable programmatically through onUpload but isn't
  // surfaced in the command center to avoid duplicating the dashboard
  // entry point. ERP connectors are still TBD.
  return (
    <>
      <Section label="Import">
        <Row
          icon={Plug}
          title="ERP connector"
          hint="Available in a future upgrade"
          comingSoon
          onClick={() =>
            comingSoon(
              "ERP connectors",
              "SAP, Microsoft Dynamics, NetSuite, Odoo, Shopify. Connector framework lands next.",
            )
          }
        />
      </Section>
      <Section label="Sync">
        <Row
          icon={Activity}
          title="Sync history"
          hint="Run log appears after first import"
          onClick={() =>
            toast("Sync log", {
              description:
                "No imports yet. Once you upload a workbook, every run will be logged here.",
            })
          }
        />
        <Row
          icon={FileBarChart2}
          title="Data quality"
          hint="No warnings"
          onClick={() =>
            toast.success("All clear", {
              description: "Every required column resolved during the last import.",
            })
          }
        />
      </Section>
    </>
  );
}

function RulesTab() {
  const thresholds = useThresholds();
  const [openGroup, setOpenGroup] = useState<"protect" | "watch" | "liquidate" | null>(null);

  // Map the user's mental model to the threshold schema groups:
  //   Protect             → SPECS.anchor      (anchor protection thresholds)
  //   Watch · Fix · Reduce → SPECS.warning     (margin + DIO gates for non-anchors)
  //   Liquidate · Scale   → SPECS.eliminate + SPECS.scale (the two extremes)
  //
  // High-volume + good/medium margin → Protect (anchor protection).
  // Big volume + low margin          → escalates inside Watch (warningMaxVolumeT).
  // Small volume + small margin      → Liquidate (microVolumeT + microProfitKron).
  // Small volume + big margin        → Scale candidate (scaleHighMarginVolumeT).
  // Big volume + big margin          → Protect/Scale (depends on volume ceiling).
  // Live preview: each slider writes to localStorage; analytics recomputes in <100ms.

  return (
    <>
      <Section label="Decision rules">
        <RuleGroup
          title="Protect"
          subtitle="Anchor thresholds"
          specs={SPECS.anchor}
          thresholds={thresholds}
          open={openGroup === "protect"}
          onToggle={() => setOpenGroup(openGroup === "protect" ? null : "protect")}
        />
        <RuleGroup
          title="Watch · Fix · Reduce"
          subtitle="Margin and DIO gates"
          specs={SPECS.warning}
          thresholds={thresholds}
          open={openGroup === "watch"}
          onToggle={() => setOpenGroup(openGroup === "watch" ? null : "watch")}
        />
        <RuleGroup
          title="Liquidate · Scale"
          subtitle="Capital trap, scale floor"
          // Combine the two extremes in one panel — they're the
          // "throw out" vs "double down" decisions and live next to each other
          // in the user's mental model.
          specs={[...SPECS.eliminate, ...SPECS.scale]}
          thresholds={thresholds}
          open={openGroup === "liquidate"}
          onToggle={() => setOpenGroup(openGroup === "liquidate" ? null : "liquidate")}
        />
      </Section>
      <Section label="Engine">
        <Row
          icon={Activity}
          title="6 active buckets"
          hint="Live preview · changes apply across all SKUs instantly"
          onClick={() =>
            toast("Live preview", {
              description:
                "Adjust any slider above — the queue recomputes in <100ms. Thresholds persist locally.",
            })
          }
        />
        <ResetAllRow />
      </Section>
    </>
  );
}

// ─── Rule group (expandable card with sliders) ─────────────────────────

function RuleGroup({
  title,
  subtitle,
  specs,
  thresholds,
  open,
  onToggle,
}: {
  title: string;
  subtitle: string;
  specs: ThresholdSpec[];
  thresholds: ReturnType<typeof useThresholds>;
  open: boolean;
  onToggle: () => void;
}) {
  const driftCount = specs.filter(
    (s) => !isAtCalibrated(s, (thresholds as Record<string, unknown>)[s.key] as number),
  ).length;

  return (
    <div className="border-b border-rule last:border-b-0">
      {/* Header row — same visual weight as the old static row. */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface transition-colors"
      >
        <span className="w-7 h-7 rounded-md grid place-items-center bg-surface border border-rule text-ink-soft shrink-0">
          <Settings2 size={14} strokeWidth={1.75} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] text-ink leading-tight">{title}</div>
          <div className="text-[11.5px] text-ink-soft mt-0.5 leading-tight">{subtitle}</div>
        </div>
        {driftCount > 0 && (
          <span
            className="font-mono text-[10px] uppercase tracking-[0.12em] px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300 font-semibold"
            title="Number of thresholds adjusted away from calibrated defaults"
          >
            {driftCount} edited
          </span>
        )}
        <ChevronRight
          size={13}
          strokeWidth={1.75}
          className={`text-ink-mute shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>

      {/* Body — only renders when expanded; one Slider per spec. */}
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 bg-surface/40">
          {specs.map((spec) => (
            <ThresholdSlider key={spec.key} spec={spec} thresholds={thresholds} />
          ))}
          <button
            type="button"
            onClick={() => {
              // Reset just this group's specs to calibrated.
              const next = { ...thresholds };
              for (const s of specs) {
                (next as Record<string, unknown>)[s.key] = s.calibrated;
              }
              writeThresholds(next);
              toast.success(`${title} reset to calibrated`, {
                description: `${specs.length} threshold${specs.length === 1 ? "" : "s"} restored to defaults.`,
              });
            }}
            className="
              inline-flex items-center gap-1.5
              text-[11.5px] font-medium text-ink-soft hover:text-ink
              transition-colors
            "
          >
            <RotateCcw size={11} strokeWidth={2} />
            Reset {title.toLowerCase()} to calibrated
          </button>
        </div>
      )}
    </div>
  );
}

function ThresholdSlider({
  spec,
  thresholds,
}: {
  spec: ThresholdSpec;
  thresholds: ReturnType<typeof useThresholds>;
}) {
  const current = ((thresholds as Record<string, unknown>)[spec.key] as number) ?? spec.calibrated;
  const formatted = spec.format ? spec.format(current) : current.toString();
  const calibratedFmt = spec.format ? spec.format(spec.calibrated) : spec.calibrated.toString();
  const drifted = !isAtCalibrated(spec, current);

  // Position the calibrated marker as % of the slider range so the user sees
  // where the "anchor" default sits regardless of the current value.
  const calibratedPct = ((spec.calibrated - spec.min) / (spec.max - spec.min)) * 100;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={`th-${spec.key}`}
          className="text-[12.5px] text-ink font-medium leading-tight"
        >
          {spec.label}
        </label>
        <span
          className={`font-mono text-[12px] tabular-nums ${drifted ? "text-brand-d" : "text-ink-soft"}`}
        >
          {formatted}
        </span>
      </div>
      <div className="relative mt-2">
        <input
          id={`th-${spec.key}`}
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={current}
          onChange={(e) => {
            const v = parseFloat(e.currentTarget.value);
            if (!Number.isFinite(v)) return;
            writeThresholds({ ...thresholds, [spec.key]: v });
          }}
          className="
            w-full h-1.5 rounded-full appearance-none cursor-pointer
            bg-rule
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-brand
            [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-surface
            [&::-webkit-slider-thumb]:shadow
            [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-brand
            [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-surface
            [&::-moz-range-thumb]:cursor-pointer
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50
          "
        />
        {/* Calibrated marker — a small tick above the slider showing where the
            calibrated default sits. Click to snap back. */}
        <button
          type="button"
          onClick={() => writeThresholds({ ...thresholds, [spec.key]: spec.calibrated })}
          title={`Snap to calibrated (${calibratedFmt})`}
          aria-label={`Snap ${spec.label} to calibrated ${calibratedFmt}`}
          className="absolute -top-1 w-2 h-2 -ml-1 bg-ink-mute hover:bg-brand transition-colors rounded-full"
          style={{ left: `${calibratedPct}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between mt-1.5">
        <p className="text-[11px] text-ink-soft leading-snug max-w-[300px]">{spec.caption}</p>
        <span className="font-mono text-[10px] text-ink-mute shrink-0 ml-2">
          cal. {calibratedFmt}
        </span>
      </div>
    </div>
  );
}

function ResetAllRow() {
  return (
    <Row
      icon={RotateCcw}
      title="Reset all thresholds"
      hint="Restore every rule to calibrated defaults"
      onClick={() => {
        writeThresholds({ ...DEFAULTS });
        toast.success("All thresholds reset", {
          description: "Every rule is back to the calibrated default. Queue recomputed.",
        });
      }}
    />
  );
}

function AiTab({
  onOpenAi,
  onClose,
}: {
  onOpenAi?: () => void;
  onClose: () => void;
}) {
  function launch(action?: () => void) {
    onClose();
    if (action) setTimeout(action, 220);
  }

  async function exportActions() {
    onClose();
    const API_URL =
      (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
    try {
      const res = await fetch(`${API_URL}/api/cfo/exports/action-list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: { name: "Your workspace" },
          skus: [],
          categories: [],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      // Trigger a download of the CSV
      const blob = new Blob([data.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cfo-action-list-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Action plan exported", {
        description: `${data.row_count} recommendations · CSV downloaded.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed";
      toast.error("Export failed", {
        description: msg.includes("Failed to fetch")
          ? "Backend not running. Start the engine API and try again."
          : msg,
      });
    }
  }

  return (
    <>
      <Section label="Conversation">
        <Row
          icon={Sparkles}
          title="Open CFO AI"
          hint="Chat about cash, margin, and decisions"
          onClick={() => launch(onOpenAi)}
        />
      </Section>
      <Section label="Briefings">
        <Row
          icon={FileBarChart2}
          title="Generate daily briefing"
          hint="Plain-language CFO update"
          onClick={() => launch(onOpenAi)}
        />
        <Row
          icon={FileBarChart2}
          title="Generate board summary"
          hint="One-page executive memo"
          onClick={() => launch(onOpenAi)}
        />
      </Section>
      <Section label="Tools">
        <Row
          icon={Activity}
          title="Simulate impact"
          hint="Tune thresholds, see who moves"
          onClick={() => launch(onOpenAi)}
        />
        <Row
          icon={Mail}
          title="Draft supplier negotiation"
          hint="Talking points grounded in real margin"
          onClick={() => launch(onOpenAi)}
        />
        <Row
          icon={Download}
          title="Export action plan"
          hint="Downloads CSV of recommendations"
          onClick={exportActions}
        />
      </Section>
    </>
  );
}

function AccountTab({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { signOut, user, displayName } = useAuth();
  return (
    <>
      <Section label="Account">
        <Row
          icon={User}
          title={displayName ?? user?.email ?? "Profile"}
          hint={user?.email ?? "Manage your account"}
          onClick={() => {
            onClose();
            setTimeout(() => navigate("/settings"), 220);
          }}
        />
        <Row
          icon={LogOut}
          title="Sign out"
          onClick={async () => {
            onClose();
            const { error } = await signOut();
            if (error) {
              toast("Sign-out failed", { description: error.message });
              return;
            }
            navigate("/login");
          }}
        />
      </Section>
      <Section label="About">
        <div className="px-4 py-3 text-[12.5px] text-ink-soft leading-relaxed">
          Theme is in the sidebar footer (the sun/moon icon at the bottom-left).
          Use that to flip light / dark anywhere in the app.
        </div>
      </Section>
    </>
  );
}
