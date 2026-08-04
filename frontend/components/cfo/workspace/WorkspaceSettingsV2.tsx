// WorkspaceSettingsV2 — the redesigned Workspace Settings surface
// (2026-08-04, Linear/Stripe-settings layout).
//
// Desktop (lg+): a sticky left anchor nav (General / Periods / Decision
// rules / Financing / Danger zone) beside a column of `.card-2026` cards.
// Mobile: stacked cards with sticky section headers. Smooth-scroll anchors;
// the active section is highlighted via a cheap IntersectionObserver.
//
// This is a RESKIN plus display logic. Every data mutation stays on its
// existing path:
//   · rename            → onRename → useWorkspaces().rename (org RPC)
//   · industry          → onChangeIndustry → useWorkspaces().setIndustry
//   · period add/delete → PeriodsSection (createEmptyPeriod / deletePeriod)
//   · rules apply/reset → decisionRulesStore (writeDecisionRules / reset)
//   · financing         → decisionRulesStore.setFinancing
//   · delete workspace  → onDelete → useWorkspaces().remove (soft, 30 days)

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Boxes,
  Briefcase,
  Building2,
  Check,
  ChevronDown,
  Factory,
  HardHat,
  Home,
  Info,
  MonitorSmartphone,
  Pencil,
  RotateCcw,
  Search,
  ShoppingBasket,
  ShoppingCart,
  Stethoscope,
  Trash2,
  Truck,
  Wheat,
  X,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { DecisionRulesPanel } from "@/components/cfo/command/DecisionRulesModal";
import { ORG_INDUSTRIES } from "@/components/cfo/OrgIndustryPills";
import { DEFAULT_FINANCING } from "@/lib/decisionRules";
import {
  resetDecisionRulesToDefaults,
  setFinancing,
  useDecisionRules,
} from "@/lib/decisionRulesStore";
import type { Workspace } from "@/lib/workspaces";
import { PeriodsSection } from "./PeriodsSection";
import "./wsSetI18n";

// ─── industry catalog presentation ───────────────────────────────────────────

const INDUSTRY_ICONS: Record<string, typeof Building2> = {
  real_estate: Building2,
  real_estate_residential: Home,
  saas: MonitorSmartphone,
  fmcg: ShoppingBasket,
  manufacturing: Factory,
  retail_ecom: ShoppingCart,
  professional_services: Briefcase,
  construction: HardHat,
  healthcare: Stethoscope,
  logistics: Truck,
  agriculture: Wheat,
  other: Boxes,
};

// ─── section scaffolding ─────────────────────────────────────────────────────

const SECTIONS = [
  { id: "wsset-general", labelKey: "wsSet.nav.general" },
  { id: "wsset-periods", labelKey: "wsSet.nav.periods" },
  { id: "wsset-rules", labelKey: "wsSet.nav.rules" },
  { id: "wsset-financing", labelKey: "wsSet.nav.financing" },
  { id: "wsset-danger", labelKey: "wsSet.nav.danger" },
] as const;

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function SectionShell({
  id,
  title,
  danger = false,
  children,
}: {
  id: string;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24" data-testid={id}>
      <h2
        className={`max-lg:sticky max-lg:top-16 max-lg:z-10 max-lg:bg-bg/90 max-lg:backdrop-blur-sm max-lg:-mx-1 max-lg:px-1 py-2 text-[11px] uppercase tracking-[0.14em] font-semibold ${
          danger ? "text-red-500/80" : "text-ink-mute"
        }`}
      >
        {title}
      </h2>
      <div
        className={`card-2026 p-5 sm:p-6 ${danger ? "!border-red-500/25" : ""}`}
      >
        {children}
      </div>
    </section>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

export function WorkspaceSettingsV2({
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
  showBack?: boolean;
}) {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);

  // Cheap scroll-spy: the topmost intersecting section wins.
  useEffect(() => {
    const visible = new Map<string, number>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        if (visible.size > 0) {
          const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0]![0];
          setActiveSection(top);
        }
      },
      { rootMargin: "-15% 0px -60% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  return (
    <div className="space-y-5" data-testid="workspace-settings">
      {showBack && onBack && (
        <button
          type="button"
          onClick={onBack}
          data-testid="workspace-settings-back"
          className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-mute hover:text-ink transition-colors"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          {t("ws.allWorkspaces")}
        </button>
      )}

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Anchor nav — sticky, lg+ only. */}
        <nav
          className="hidden lg:block w-40 shrink-0 sticky top-20"
          aria-label={t("ws.settingsEyebrow")}
          data-testid="wsset-nav"
        >
          <ul className="space-y-0.5">
            {SECTIONS.map((s) => {
              const active = activeSection === s.id;
              const danger = s.id === "wsset-danger";
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => scrollToSection(s.id)}
                    data-testid={`wsset-nav-${s.id.replace("wsset-", "")}`}
                    aria-current={active ? "true" : undefined}
                    className={`w-full text-left rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors border-l-2 ${
                      active
                        ? `border-brand bg-bg-2/60 ${danger ? "text-red-500" : "text-ink"}`
                        : `border-transparent ${danger ? "text-red-500/60 hover:text-red-500" : "text-ink-mute hover:text-ink"} hover:bg-bg-2/40`
                    }`}
                  >
                    {t(s.labelKey)}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Content column. w-full matters below lg: the parent flex-col is
            items-start (needed for the sticky nav at lg+), which would
            otherwise size this column to content width and overflow. */}
        <div className="w-full flex-1 min-w-0 space-y-6 cards-stagger">
          <SectionShell id="wsset-general" title={t("wsSet.nav.general")}>
            <GeneralSection
              workspace={workspace}
              onRename={onRename}
              onChangeIndustry={onChangeIndustry}
            />
          </SectionShell>

          <SectionShell id="wsset-periods" title={t("wsSet.nav.periods")}>
            <PeriodsSection orgId={workspace.id} />
          </SectionShell>

          <SectionShell id="wsset-rules" title={t("wsSet.nav.rules")}>
            {/* The panel itself is conditional on the industry: product
                industries get the full rules surface, everything else a
                compact "not applicable" card with a change-industry link. */}
            <DecisionRulesPanel
              key={workspace.industryKey ?? "none"}
              industryKey={workspace.industryKey ?? null}
              onChangeIndustryRequest={() => scrollToSection("wsset-general")}
              showFinancing={false}
              applyBar
            />
          </SectionShell>

          <SectionShell id="wsset-financing" title={t("wsSet.nav.financing")}>
            <FinancingSection />
          </SectionShell>

          <SectionShell id="wsset-danger" title={t("wsSet.danger.title")} danger>
            <DangerZone
              workspace={workspace}
              canDelete={canDelete}
              onDelete={onDelete}
            />
          </SectionShell>
        </div>
      </div>
    </div>
  );
}

// ─── General ─────────────────────────────────────────────────────────────────

function GeneralSection({
  workspace,
  onRename,
  onChangeIndustry,
}: {
  workspace: Workspace;
  onRename: (name: string) => void;
  onChangeIndustry: (key: string) => void;
}) {
  const { t } = useTranslation();

  // Inline rename — pencil swaps the read-only value for an input in place;
  // check/Enter saves through the EXISTING rename plumbing, x/Escape cancels.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workspace.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function startEditing() {
    setDraft(workspace.name);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }
  function commit() {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed.length === 0 || trimmed === workspace.name) return;
    onRename(trimmed);
    toast.success(t("wsSet.general.nameSaved"));
  }
  function cancel() {
    setDraft(workspace.name);
    setEditing(false);
  }

  // Industry — current selection as a card + searchable popover to change it.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = ORG_INDUSTRIES.find((i) => i.key === workspace.industryKey) ?? null;
  const CurrentIcon = current ? INDUSTRY_ICONS[current.key] ?? Boxes : Boxes;
  const indName = (key: string) => t(`wsSet.industries.${key}.name`);
  const indDesc = (key: string) => t(`wsSet.industries.${key}.desc`);
  const q = query.trim().toLowerCase();
  const filtered = ORG_INDUSTRIES.filter(
    (i) =>
      q === "" ||
      indName(i.key).toLowerCase().includes(q) ||
      indDesc(i.key).toLowerCase().includes(q) ||
      i.key.includes(q),
  );

  function pickIndustry(key: string) {
    setPickerOpen(false);
    setQuery("");
    if (key === workspace.industryKey) return;
    onChangeIndustry(key);
    toast.success(t("wsSet.general.industryChanged"));
  }

  return (
    <div className="space-y-6">
      {/* Name */}
      <div>
        <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-1.5">
          {t("settings.workspace_name")}
        </span>
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commit(); }
                if (e.key === "Escape") cancel();
              }}
              data-testid="workspace-settings-name"
              className="w-full max-w-[420px] h-10 px-3.5 rounded-lg border border-rule bg-surface text-[14px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
            />
            <button
              type="button"
              onClick={commit}
              aria-label={t("wsSet.general.saveName")}
              title={t("wsSet.general.saveName")}
              data-testid="wsset-name-save"
              className="shrink-0 grid place-items-center h-10 w-10 rounded-lg border border-brand/40 text-brand-d hover:border-brand/60 hover:bg-brand/10 transition-colors"
            >
              <Check size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={cancel}
              aria-label={t("wsSet.general.cancelEdit")}
              title={t("wsSet.general.cancelEdit")}
              data-testid="wsset-name-cancel"
              className="shrink-0 grid place-items-center h-10 w-10 rounded-lg border border-rule text-ink-mute hover:text-ink hover:bg-bg-2/60 transition-colors"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <div className="group flex items-center gap-2">
            <span className="text-[15px] font-medium text-ink truncate" data-testid="wsset-name-value">
              {workspace.name || t("ws.untitledWorkspace")}
            </span>
            <button
              type="button"
              onClick={startEditing}
              aria-label={t("wsSet.general.editName")}
              title={t("wsSet.general.editName")}
              data-testid="workspace-settings-name-edit"
              className="shrink-0 grid place-items-center h-8 w-8 rounded-lg text-ink-mute opacity-70 group-hover:opacity-100 hover:text-ink hover:bg-bg-2/70 transition-all"
            >
              <Pencil size={14} strokeWidth={1.75} />
            </button>
          </div>
        )}
      </div>

      {/* Industry */}
      <div>
        <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-1.5">
          {t("onboarding.industry")}
        </span>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div
            className="flex items-center gap-3 flex-1 min-w-0 rounded-xl border border-rule bg-bg-2/40 px-3.5 py-3"
            data-testid="wsset-industry-current"
          >
            <span className="grid place-items-center h-9 w-9 shrink-0 rounded-lg bg-brand/10 text-brand-d">
              <CurrentIcon size={18} strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink truncate">
                {current ? indName(current.key) : t("ws.noIndustrySet")}
              </div>
              <div className="text-[11.5px] text-ink-soft truncate">
                {current ? indDesc(current.key) : t("wsSet.general.noIndustry")}
              </div>
            </div>
          </div>

          <Popover
            open={pickerOpen}
            onOpenChange={(o) => { setPickerOpen(o); if (!o) setQuery(""); }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="wsset-industry-change"
                className="shrink-0 inline-flex items-center gap-1.5 h-10 px-3.5 rounded-lg border border-brand/40 text-[13px] font-medium text-ink hover:border-brand/60 hover:bg-brand/10 transition-colors"
              >
                {t("wsSet.general.changeIndustry")}
                <ChevronDown size={14} strokeWidth={2} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[320px] p-0 rounded-xl border-rule bg-surface"
              data-testid="wsset-industry-popover"
            >
              <div className="flex items-center gap-2 border-b border-rule/60 px-3 py-2">
                <Search size={14} strokeWidth={2} className="shrink-0 text-ink-mute" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  placeholder={t("wsSet.general.searchIndustry")}
                  autoFocus
                  data-testid="wsset-industry-search"
                  className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-mute focus:outline-none"
                />
              </div>
              <div className="max-h-[320px] overflow-y-auto chat-scroll p-1.5">
                {filtered.length === 0 ? (
                  <p className="px-3 py-4 text-[12px] text-ink-mute text-center">
                    {t("wsSet.general.noneFound")}
                  </p>
                ) : (
                  filtered.map((i) => {
                    const Icon = INDUSTRY_ICONS[i.key] ?? Boxes;
                    const selected = i.key === workspace.industryKey;
                    return (
                      <button
                        key={i.key}
                        type="button"
                        onClick={() => pickIndustry(i.key)}
                        data-testid={`wsset-industry-option-${i.key}`}
                        aria-pressed={selected}
                        className={`w-full flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                          selected ? "bg-brand/10" : "hover:bg-bg-2/70"
                        }`}
                      >
                        <span className="grid place-items-center h-7 w-7 shrink-0 rounded-md bg-bg-2/70 text-ink-soft mt-0.5">
                          <Icon size={14} strokeWidth={1.75} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-medium text-ink leading-snug">
                            {indName(i.key)}
                          </span>
                          <span className="block text-[11px] text-ink-soft leading-snug">
                            {indDesc(i.key)}
                          </span>
                        </span>
                        {selected && (
                          <Check size={14} strokeWidth={2} className="shrink-0 text-brand-d mt-1" />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <p className="mt-2 text-[11.5px] text-ink-mute leading-snug">
          {t("wsSet.general.industryNote")}
        </p>
      </div>
    </div>
  );
}

// ─── Financing ───────────────────────────────────────────────────────────────
// Same store the decision rules read (setFinancing) — the panel's own
// financing block is hidden on this surface so the assumptions live here once.

function FinancingSection() {
  const { t } = useTranslation();
  const state = useDecisionRules();
  const financing = state.financing ?? DEFAULT_FINANCING;
  const totalRate = (financing.costOfFinancing ?? 0) + (financing.bankSpread ?? 0);

  return (
    <div className="space-y-4" data-testid="wsset-financing-card">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12.5px] text-ink-soft leading-relaxed max-w-[52ch]">
          {t("wsSet.financing.subtitle")}
        </p>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("wsSet.financing.infoAria")}
              data-testid="wsset-financing-info"
              className="shrink-0 grid place-items-center h-8 w-8 rounded-lg text-ink-mute hover:text-ink hover:bg-bg-2/70 transition-colors"
            >
              <Info size={15} strokeWidth={1.75} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-[300px] rounded-xl border-rule bg-surface p-4 space-y-3"
          >
            <div>
              <p className="text-[12px] font-medium text-ink">
                {t("decision_rules.financing.cost_label")}
              </p>
              <p className="text-[11.5px] text-ink-soft leading-snug mt-0.5">
                {t("decision_rules.financing.cost_hint")}
              </p>
            </div>
            <div>
              <p className="text-[12px] font-medium text-ink">
                {t("decision_rules.financing.spread_label")}
              </p>
              <p className="text-[11.5px] text-ink-soft leading-snug mt-0.5">
                {t("decision_rules.financing.spread_hint")}
              </p>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-1.5">
            {t("decision_rules.financing.cost_label")}
          </span>
          <div className="relative">
            <input
              type="number"
              min={0}
              max={20}
              step={0.1}
              value={financing.costOfFinancing}
              onChange={(e) => {
                const v = parseFloat(e.currentTarget.value);
                if (Number.isFinite(v)) setFinancing({ costOfFinancing: Math.max(0, Math.min(20, v)) });
              }}
              data-testid="financing-cost-of-financing"
              className="w-[120px] h-10 pl-3 pr-8 rounded-lg border border-rule bg-surface text-[13px] tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-ink-mute">%</span>
          </div>
        </label>

        <span className="pb-2.5 text-[14px] text-ink-mute">+</span>

        <label className="block">
          <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-1.5">
            {t("decision_rules.financing.spread_label")}
          </span>
          <div className="relative">
            <input
              type="number"
              min={0}
              max={10}
              step={0.1}
              value={financing.bankSpread}
              onChange={(e) => {
                const v = parseFloat(e.currentTarget.value);
                if (Number.isFinite(v)) setFinancing({ bankSpread: Math.max(0, Math.min(10, v)) });
              }}
              data-testid="financing-bank-spread"
              className="w-[120px] h-10 pl-3 pr-8 rounded-lg border border-rule bg-surface text-[13px] tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-ink-mute">%</span>
          </div>
        </label>

        <span className="pb-2.5 text-[14px] text-ink-mute">=</span>

        <div
          className="inline-flex items-center gap-2 h-10 px-3.5 rounded-lg bg-brand/10 border border-brand/30"
          data-testid="wsset-financing-total"
        >
          <span className="text-[11px] uppercase tracking-[0.1em] font-semibold text-ink-soft">
            {t("decision_rules.financing.total_rate")}
          </span>
          <span className="font-mono text-[14px] tabular-nums font-semibold text-brand-d">
            {totalRate.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Danger zone ─────────────────────────────────────────────────────────────

function DangerZone({
  workspace,
  canDelete,
  onDelete,
}: {
  workspace: Workspace;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const name = workspace.name?.trim() ?? "";
  const match = name.length > 0 && typed.trim() === name;

  // Fresh dialog per opening — a typed confirmation must never carry over.
  useEffect(() => {
    if (deleteOpen) setTyped("");
  }, [deleteOpen]);

  return (
    <div className="space-y-5">
      {/* Reset decision rules */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">{t("wsSet.danger.resetTitle")}</p>
          <p className="text-[11.5px] text-ink-soft leading-snug mt-0.5">
            {t("wsSet.danger.resetBody")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            resetDecisionRulesToDefaults();
            toast.success(t("ws.rulesReset"));
          }}
          data-testid="workspace-settings-reset"
          className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 transition-colors"
        >
          <RotateCcw size={14} strokeWidth={1.75} />
          {t("ws.resetToDefault")}
        </button>
      </div>

      <div className="border-t border-red-500/15" />

      {/* Delete workspace */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">{t("wsSet.danger.deleteTitle")}</p>
          <p className="text-[11.5px] text-ink-soft leading-snug mt-0.5">
            {canDelete ? t("wsSet.danger.deleteNote") : t("wsSet.danger.cannotDelete")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDeleteOpen(true)}
          disabled={!canDelete}
          data-testid="workspace-settings-delete"
          className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-red-500/30 bg-red-500/10 text-[13px] font-medium text-red-600 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Trash2 size={14} strokeWidth={1.75} />
          {t("ws.deleteWorkspace")}
        </button>
      </div>

      {/* Typed confirmation — mirrors the permanent-purge dialog's pattern,
          but the action itself stays the existing SOFT delete (30-day
          restore), so the copy leads with what actually happens. */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-[440px]" data-testid="workspace-settings-delete-dialog">
          <DialogHeader>
            <DialogTitle>
              {t("ws.deleteWorkspaceTitle", { name: workspace.name || t("ws.thisWorkspace") })}
            </DialogTitle>
            <DialogDescription>
              {t("ws.deleteWorkspaceBody")}
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
              onKeyDown={(e) => {
                if (e.key === "Enter" && match) {
                  setDeleteOpen(false);
                  onDelete();
                }
              }}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              data-testid="wsset-delete-confirm-input"
              className="w-full h-10 px-3 rounded-lg border border-rule bg-surface text-[14px] text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500/40"
            />
          </label>

          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => setDeleteOpen(false)}
              data-testid="workspace-settings-delete-cancel"
              className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => { setDeleteOpen(false); onDelete(); }}
              disabled={!match}
              data-testid="workspace-settings-delete-confirm"
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-red-500/30 bg-red-500/10 text-[13px] font-medium text-red-600 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 size={14} strokeWidth={1.75} />
              {t("ws.deleteWorkspace")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
