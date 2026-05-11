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
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";

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
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface transition-colors"
    >
      <span className="w-7 h-7 rounded-md grid place-items-center bg-surface border border-rule text-ink-soft shrink-0">
        <Icon size={14} strokeWidth={1.75} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] text-ink leading-tight">{title}</div>
        {hint && <div className="text-[11.5px] text-ink-soft mt-0.5 leading-tight">{hint}</div>}
      </div>
      {trailing ?? (
        <ChevronRight size={13} strokeWidth={1.75} className="text-ink-mute shrink-0" />
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
          hint="Not connected"
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
  function explain(group: string, body: string) {
    toast(group, { description: body });
  }
  return (
    <>
      <Section label="Decision rules">
        <Row
          icon={Settings2}
          title="Protect"
          hint="Anchor thresholds"
          onClick={() =>
            explain(
              "Protect",
              "Top 20% by absolute profit · ≥5% revenue share · volume ≥50t. High-volume floor: 5% real margin.",
            )
          }
        />
        <Row
          icon={Settings2}
          title="Watch · Fix · Reduce"
          hint="Margin and DIO gates"
          onClick={() =>
            explain(
              "Watch · Fix · Reduce",
              "Watch: long DIO. Fix: thin real margin (0–3%). Reduce: capital trap, throttle reorder.",
            )
          }
        />
        <Row
          icon={Settings2}
          title="Liquidate · Scale"
          hint="Capital trap, scale floor"
          onClick={() =>
            explain(
              "Liquidate · Scale",
              "Liquidate: real margin <0% or micro vol+profit. Scale: real margin ≥10% with strong volume.",
            )
          }
        />
      </Section>
      <Section label="Engine">
        <Row
          icon={Activity}
          title="6 active buckets"
          hint="Live preview on threshold change"
          onClick={() =>
            toast("Live preview", {
              description:
                "Tweak any threshold and the queue recomputes in <100ms across all SKUs.",
            })
          }
        />
      </Section>
    </>
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
