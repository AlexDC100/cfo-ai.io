// CompanyPage — /workspace/<orgId>, screen 3 of the workspace redesign.
//
//   ← All companies
//   Agras SRL                                              ⚙
//   CUI 12345678 · Agriculture
//   ┌──────┐┌──────┐┌──────┐┌┄┄┄┄┄┄┐
//   │ 2023 ││ 2024 ││ 2025 │┆ + 2026┆   ← one line; scrolls sideways on a phone
//   │ 41 M ││ 47 M ││ 52 M │┆ drop  ┆
//   │      ││+14 % ││+11 % │└┄┄┄┄┄┄┘
//   └──────┘└──────┘└──────┘
//
// The company name IS the title. Each analysed year is a tile (year, revenue,
// change vs the year before) that opens that year's dashboard; the dashed
// tile after them is the one upload target on this screen. Settings,
// decision rules (only while Products is active), financing and the danger
// zone sit behind the gear — no left settings sub-nav.
//
// The header must name this company before anything of it renders: see
// lib/companyOnScreen.ts (gate G6).

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Settings2 } from "lucide-react";

import { Money } from "@/components/ui/Money";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/components/ui/sonner";
import { ORG_INDUSTRIES, orgIndustryDisplayLabel, orgIndustryLabel } from "@/components/cfo/OrgIndustryPills";
import { DecisionRulesPanel } from "@/components/cfo/command/DecisionRulesModal";
import { DangerZone, FinancingSection, GeneralSection } from "@/components/cfo/workspace/WorkspaceSettingsV2";
import { UploadDrop } from "@/components/cfo/upload/UploadDrop";
import { dashboardHref } from "@/components/cfo/upload/UploadFlowHost";
import { useCompanyOnScreen } from "@/lib/companyOnScreen";
import { activeLocale } from "@/lib/locale";
import { useFeatureStatus } from "@/lib/features";
import { useActiveOrg } from "@/lib/org";
import { fetchCompanyDirectory, fetchCompanyYears, type CompanyYear } from "@/lib/uploadsApi";
import type { Currency } from "@/lib/rates";
import { cn } from "@/lib/utils";

export default function CompanyPage() {
  const { orgId = "" } = useParams<{ orgId: string }>();
  const { t } = useTranslation();
  const screen = useCompanyOnScreen(orgId || null);

  if (screen.status === "missing") {
    return (
      <section className="max-w-[960px] space-y-4" data-testid="company-page-missing">
        <BackLink />
        <p className="text-[14px] text-ink">{t("wsV2.company.notFound")}</p>
      </section>
    );
  }
  if (screen.status !== "ready") {
    // Neutral hold: nothing of the company renders until the header names it.
    return (
      <section
        aria-busy
        className="max-w-[960px] space-y-4"
        data-testid="company-page-hold"
        data-status={screen.status}
      >
        <div className="h-4 w-28 rounded bg-bg-2/80" />
        <div className="h-7 w-1/3 rounded bg-bg-2/80" />
        <span className="sr-only">
          {screen.org ? t("wsV2.company.opening", { company: screen.org.name }) : ""}
        </span>
      </section>
    );
  }
  return (
    <CompanyReady
      orgId={screen.org.id}
      name={screen.org.name}
      industryKey={screen.org.industry_key}
      industryName={screen.org.industry_display_name ?? null}
    />
  );
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      to="/workspace"
      data-testid="company-back"
      className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-mute transition-colors hover:text-ink"
    >
      <ArrowLeft size={14} strokeWidth={2} aria-hidden />
      {t("wsV2.company.back")}
    </Link>
  );
}

function CompanyReady({
  orgId,
  name,
  industryKey,
  industryName,
}: {
  orgId: string;
  name: string;
  industryKey: string | null;
  /** organizations.industry_display_name — set by the commit route from the
   *  industry catalog when the key is not a workspace-settings industry. */
  industryName: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [gearOpen, setGearOpen] = useState(false);

  const yearsQ = useQuery({
    queryKey: ["company-years", orgId],
    queryFn: () => fetchCompanyYears(orgId),
    staleTime: 30_000,
  });
  const dirQ = useQuery({
    queryKey: ["company-directory", orgId],
    queryFn: () => fetchCompanyDirectory([orgId]),
    staleTime: 60_000,
  });
  const cui = dirQ.data?.[orgId]?.cui ?? null;

  const years = yearsQ.data ?? [];
  const nextYear = useMemo(() => {
    if (years.length > 0) return Math.max(...years.map((y) => y.year)) + 1;
    return new Date().getUTCFullYear() - 1;
  }, [years]);

  return (
    <section className="max-w-[1200px] space-y-6" data-testid="company-page" data-org-id={orgId}>
      <BackLink />

      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="truncate text-[24px] font-semibold leading-tight text-ink sm:text-[28px]"
            data-testid="company-title"
            data-company-on-screen={name}
          >
            {name}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-soft">
            {cui && <span className="font-mono tabular-nums" data-testid="company-cui">{t("wsV2.home.cui", { cui })}</span>}
            {cui && industryKey && <span aria-hidden>·</span>}
            {industryKey && (
              <span data-testid="company-industry">
                {ORG_INDUSTRIES.some((i) => i.key === industryKey)
                  ? orgIndustryDisplayLabel(industryKey)
                  : industryName ?? industryKey}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setGearOpen(true)}
          data-testid="company-gear"
          aria-label={t("wsV2.company.settings")}
          title={t("wsV2.company.settings")}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-sm border border-rule text-ink-soft transition-colors duration-micro hover:bg-bg-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Settings2 size={17} strokeWidth={1.75} aria-hidden />
        </button>
      </header>

      <div>
        <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          {t("wsV2.company.years")}
        </h2>
        {/* ONE line at every width: tiles never wrap; a phone scrolls them
            sideways. The dashed tile always closes the row. */}
        <div
          className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2 chat-scroll"
          data-testid="company-years"
        >
          {yearsQ.isLoading
            ? [0, 1, 2].map((i) => (
                <div key={i} className="h-[112px] w-[168px] shrink-0 rounded-md bg-bg-2/80" aria-hidden />
              ))
            : years.map((y, i) => (
                <YearTile
                  key={y.period_id}
                  year={y}
                  prior={i > 0 ? years[i - 1]!.year : null}
                  onOpen={() => navigate(dashboardHref(orgId, y.period_id))}
                />
              ))}
          <div className="w-[168px] shrink-0 snap-start">
            <UploadDrop variant="tile" onScreenOrgId={orgId} year={nextYear} />
          </div>
        </div>
        {yearsQ.isError && (
          <p className="mt-2 text-[12.5px] text-alert" role="alert">
            {t("wsV2.company.yearsError")}{" "}
            <button type="button" className="underline" onClick={() => void yearsQ.refetch()}>
              {t("wsV2.company.retry")}
            </button>
          </p>
        )}
        {!yearsQ.isLoading && !yearsQ.isError && years.length === 0 && (
          <p className="mt-2 text-[12.5px] text-ink-soft" data-testid="company-no-years">
            {t("wsV2.company.noYears")}
          </p>
        )}
      </div>

      <CompanySettingsSheet
        open={gearOpen}
        onOpenChange={setGearOpen}
        orgId={orgId}
        name={name}
        industryKey={industryKey}
      />
    </section>
  );
}

function YearTile({ year, prior, onOpen }: { year: CompanyYear; prior: number | null; onOpen: () => void }) {
  const { t } = useTranslation();
  const change = year.revenue_change_pct;
  const currency = (year.currency ?? "RON") as Currency;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`company-year-${year.year}`}
      className="flex min-h-[112px] w-[168px] shrink-0 snap-start flex-col items-start justify-between rounded-md border border-rule bg-surface px-3.5 py-3 text-left transition-colors duration-micro hover:border-rule-strong hover:bg-bg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="font-mono text-[13px] font-medium tabular-nums text-ink">{year.year}</span>
      <span className="text-[17px] font-semibold text-ink" data-testid={`company-year-${year.year}-revenue`}>
        <Money value={year.revenue} fromCurrency={currency} compact />
      </span>
      <span className="text-[11.5px] tabular-nums" data-testid={`company-year-${year.year}-change`}>
        {change === null ? (
          <span className="text-ink-mute">{prior === null ? t("wsV2.company.firstYear") : "—"}</span>
        ) : (
          <>
            <span className={cn(change >= 0 ? "text-success" : "text-alert", "font-medium")}>
              {formatSignedPct(change)}
            </span>{" "}
            {prior !== null && <span className="text-ink-mute">{t("wsV2.company.vsPrior", { year: prior })}</span>}
          </>
        )}
      </span>
    </button>
  );
}

/** "+12.3 %" in the reader's locale; the value is already percentage points. */
function formatSignedPct(pct: number): string {
  const body = new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.abs(pct));
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${body} %`;
}

// ── The gear ───────────────────────────────────────────────────────────

function CompanySettingsSheet({
  open,
  onOpenChange,
  orgId,
  name,
  industryKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  name: string;
  industryKey: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ws = useActiveOrg();
  // Decision rules grade a product catalog — they only mean something while
  // the Products surface is live.
  const productsStatus = useFeatureStatus("products_legacy");
  const showRules = productsStatus === "active";
  const workspace = {
    id: orgId,
    name,
    createdAt: "",
    industryKey,
  };
  // Same rule as the old settings (lib/workspaces canDelete): any live company
  // can be deleted — it is a 30-day soft delete, restorable from Home.
  const canDelete = ws.orgs.length >= 1;

  const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-mute mb-2";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto border-rule bg-bg p-0 sm:max-w-[560px] chat-scroll"
        data-testid="company-settings"
      >
        <SheetHeader className="border-b border-rule-soft px-5 py-4 text-left">
          <SheetTitle className="text-[16px] font-semibold text-ink">
            {t("wsV2.settings.title", { company: name })}
          </SheetTitle>
          <SheetDescription className="sr-only">{t("wsV2.company.settings")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-7 px-5 py-5">
          <section data-testid="company-settings-general">
            <h3 className={heading}>{t("wsV2.settings.general")}</h3>
            <div className="rounded-md border border-rule bg-surface p-4">
              <GeneralSection
                workspace={workspace}
                nameLabel={t("wsV2.settings.companyName")}
                onRename={(next) => void ws.renameWorkspace(orgId, next)}
                onChangeIndustry={(key) => void ws.setWorkspaceIndustry(orgId, key, orgIndustryLabel(key))}
              />
            </div>
          </section>
          {showRules && (
            <section data-testid="company-settings-rules">
              <h3 className={heading}>{t("wsV2.settings.rules")}</h3>
              <div className="rounded-md border border-rule bg-surface p-4">
                <DecisionRulesPanel key={industryKey ?? "none"} industryKey={industryKey} showFinancing={false} applyBar />
              </div>
            </section>
          )}
          <section data-testid="company-settings-financing">
            <h3 className={heading}>{t("wsV2.settings.financing")}</h3>
            <div className="rounded-md border border-rule bg-surface p-4">
              <FinancingSection />
            </div>
          </section>
          <section data-testid="company-settings-danger">
            <h3 className={cn(heading, "text-alert")}>{t("wsV2.settings.danger")}</h3>
            <div className="rounded-md border border-alert/25 bg-surface p-4">
              <DangerZone
                workspace={workspace}
                canDelete={canDelete}
                copy={{
                  title: t("wsV2.settings.deleteTitle"),
                  note: t("wsV2.settings.deleteNote"),
                  button: t("wsV2.settings.deleteButton"),
                  dialogTitle: t("wsV2.settings.deleteDialogTitle", { company: name }),
                  dialogBody: t("wsV2.settings.deleteDialogBody"),
                }}
                onDelete={() => {
                  onOpenChange(false);
                  void ws.archiveWorkspace(orgId).then((ok) => {
                    if (ok) {
                      toast.success(t("wsV2.settings.deleted", { company: name }));
                      navigate("/workspace");
                    } else {
                      toast.error(t("wsV2.settings.cantDelete"));
                    }
                  });
                }}
              />
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
