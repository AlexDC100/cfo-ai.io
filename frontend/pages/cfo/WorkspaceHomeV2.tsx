// WorkspaceHomeV2 — /workspace, screen 1 of the workspace redesign.
//
//   Your companies
//   ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
//   ┆        Drop a file here  [Choose a file] ┆   ← the one primary action
//   └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘
//   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
//   │ Scandia SRL │ │ Agras SA    │ │ …           │   ← click → company page
//   │ CUI 1234567 │ │ CUI 7654321 │ │             │
//   │ Revenue 2025│ │ Revenue 2024│ │             │
//   │ 413.7 M RON │ │ 118.6 M RON │ │             │
//   └─────────────┘ └─────────────┘ └─────────────┘
//
// One company per workspace: the cards ARE the workspaces. A company is made
// by dropping its document (a new CUI creates it) — there is no separate
// "create workspace" wizard on this screen. Soft-deleted companies stay
// restorable here for their 30 days.

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, RotateCcw } from "lucide-react";

import { Money } from "@/components/ui/Money";
import { toast } from "@/components/ui/sonner";
import { UploadDrop } from "@/components/cfo/upload/UploadDrop";
import { daysUntilPurge, useActiveOrg, type Organization } from "@/lib/org";
import { fetchCompanyDirectory, fetchCompanyYears } from "@/lib/uploadsApi";
import type { Currency } from "@/lib/rates";

export default function WorkspaceHomeV2() {
  const { t } = useTranslation();
  const { org: active, orgs, archived, loading, loadError, refresh, restoreWorkspace } = useActiveOrg();

  const ids = orgs.map((o) => o.id);
  const dirQ = useQuery({
    queryKey: ["company-directory", ...ids],
    queryFn: () => fetchCompanyDirectory(ids),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });

  return (
    <section className="max-w-[1200px] space-y-6" data-testid="workspace-home">
      <header>
        <h1 className="text-[24px] font-semibold leading-tight text-ink sm:text-[28px]">{t("wsV2.home.title")}</h1>
        <p className="mt-1.5 max-w-[640px] text-[13px] leading-relaxed text-ink-soft">{t("wsV2.home.subtitle")}</p>
      </header>

      <UploadDrop variant="zone" onScreenOrgId={active?.id ?? null} />

      {loadError ? (
        <div className="rounded-md border border-rule bg-surface px-5 py-6 text-center" data-testid="workspace-home-error">
          <p className="text-[13.5px] text-ink">{t("wsV2.home.loadError")}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-3 inline-flex h-8 items-center rounded-sm border border-rule px-3.5 text-[12.5px] font-medium text-ink hover:bg-bg-2"
          >
            {t("wsV2.home.retry")}
          </button>
        </div>
      ) : loading && orgs.length === 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[128px] rounded-md bg-bg-2/80" />
          ))}
        </div>
      ) : orgs.length === 0 ? (
        <p className="text-[13px] text-ink-soft" data-testid="workspace-home-empty">
          {t("wsV2.home.empty")}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="company-cards">
          {orgs.map((o) => (
            <li key={o.id}>
              <CompanyCard org={o} cui={dirQ.data?.[o.id]?.cui ?? null} />
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <div data-testid="workspace-home-deleted">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-mute">
            {t("wsV2.home.recentlyDeleted")}
          </h2>
          <ul className="divide-y divide-rule-soft rounded-md border border-rule bg-surface">
            {archived.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] text-ink">{o.name}</p>
                  <p className="text-[11.5px] text-ink-mute">
                    {t("wsV2.home.purgeIn", { count: daysUntilPurge(o) })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void restoreWorkspace(o.id).then((ok) => {
                      if (!ok) toast.error(t("wsV2.home.cantRestore"));
                    })
                  }
                  data-testid={`workspace-home-restore-${o.id}`}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border border-rule px-3 text-[12.5px] font-medium text-ink hover:bg-bg-2"
                >
                  <RotateCcw size={13} strokeWidth={1.75} aria-hidden />
                  {t("wsV2.home.restore")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function CompanyCard({ org, cui }: { org: Organization; cui: string | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const yearsQ = useQuery({
    queryKey: ["company-years", org.id],
    queryFn: () => fetchCompanyYears(org.id),
    staleTime: 30_000,
  });
  const latest = yearsQ.data && yearsQ.data.length > 0 ? yearsQ.data[yearsQ.data.length - 1]! : null;

  return (
    <button
      type="button"
      onClick={() => navigate(`/workspace/${encodeURIComponent(org.id)}`)}
      data-testid={`company-card-${org.id}`}
      className="group flex h-full w-full flex-col gap-3 rounded-md border border-rule bg-surface p-4 text-left transition-colors duration-micro hover:border-rule-strong hover:bg-bg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex w-full items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-ink" data-testid="company-card-name">
            {org.name}
          </p>
          <p className="mt-0.5 font-mono text-[11.5px] tabular-nums text-ink-mute" data-testid="company-card-cui">
            {cui ? t("wsV2.home.cui", { cui }) : t("wsV2.home.noCui")}
          </p>
        </div>
        <ChevronRight size={16} className="mt-0.5 shrink-0 text-ink-mute transition-colors group-hover:text-ink" aria-hidden />
      </div>
      <div className="mt-auto" data-testid="company-card-revenue">
        {latest ? (
          <>
            <p className="text-[11px] uppercase tracking-[0.1em] text-ink-mute">
              {t("wsV2.home.latestRevenue", { year: latest.year })}
            </p>
            <p className="text-[18px] font-semibold text-ink">
              <Money value={latest.revenue} fromCurrency={(latest.currency ?? "RON") as Currency} compact />
            </p>
          </>
        ) : (
          <p className="text-[12px] text-ink-mute">{yearsQ.isLoading ? " " : t("wsV2.home.noYears")}</p>
        )}
      </div>
    </button>
  );
}
