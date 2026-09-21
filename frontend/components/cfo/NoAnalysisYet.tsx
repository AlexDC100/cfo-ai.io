// NoAnalysisYet — the dashboard's empty state in the workspace redesign.
//
// The current dashboard's empty state IS an upload surface (hero, drop zone,
// example files). The redesign has exactly one upload component and it does
// not live here: a file dropped on this screen goes through the app-wide drop
// (components/cfo/upload), and the button below leads to the company page,
// whose dashed next-year tile takes the file. One primary action.

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useActiveOrg } from "@/lib/org";

export function NoAnalysisYet() {
  const { t } = useTranslation();
  const { org } = useActiveOrg();
  return (
    <section
      className="mx-auto max-w-[560px] rounded-md border border-rule bg-surface px-6 py-10 text-center"
      data-testid="dashboard-no-analysis"
    >
      <h1 className="text-[18px] font-semibold text-ink">{t("wsV2.dashboard.emptyTitle")}</h1>
      <p className="mx-auto mt-2 max-w-[44ch] text-[13px] leading-relaxed text-ink-soft">
        {t("wsV2.dashboard.emptyBody")}
      </p>
      <Link
        to={org ? `/workspace/${encodeURIComponent(org.id)}` : "/workspace"}
        data-testid="dashboard-no-analysis-open"
        className="mt-5 inline-flex h-9 items-center justify-center rounded-sm bg-brand px-4 text-[13px] font-medium text-paper transition-colors duration-micro hover:bg-brand-dark"
      >
        {org ? t("wsV2.dashboard.openCompany", { company: org.name }) : t("wsV2.dashboard.openCompanies")}
      </Link>
    </section>
  );
}
