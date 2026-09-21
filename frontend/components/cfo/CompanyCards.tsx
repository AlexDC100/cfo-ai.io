// COMPANY CARDS — pick the company a page works on.
//
// The Forecast and Scenarios pages always work on the company on screen (the
// active workspace; one company per workspace). With no company open, or with
// a company that has no analysed year yet, they show ONE sentence and these
// cards: the user's own companies, each one tap from being the company on
// screen. This is the minimal list the brief allows until the workspace
// redesign's cards component lands; it deliberately carries NO upload control
// (the company page owns uploads), and no figure of any company.
//
// Picking a card switches the active workspace (which clears every cached
// answer of the previous company) and drops the page's ?period= so the new
// company's own latest period resolves — never the previous company's period
// under the new company's name.

import { Building2, ChevronRight } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useWorkspaces } from "@/lib/workspaces";

export interface CompanyCardsProps {
  /** Why the cards are shown: no company at all, or the company on screen
   *  has no analysed year. The sentence above the cards says which. */
  readonly reason: "no_company" | "no_year";
  /** The page's own name, for the sentence ("Forecast", "Scenarios"). */
  readonly pageName: string;
}

export function CompanyCards({ reason, pageName }: CompanyCardsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaces, current, select } = useWorkspaces();

  const onPick = async (id: string) => {
    if (id !== current?.id) await select(id);
    navigate(location.pathname, { replace: false });
  };

  const sentence =
    reason === "no_company"
      ? t("companyCards.noCompany", {
          page: pageName,
          defaultValue: "{{page}} works on one of your companies, and you have none yet.",
        })
      : current
        ? t("companyCards.noYear", {
            page: pageName,
            company: current.name,
            defaultValue:
              "{{company}} has no analysed year yet, so {{page}} has nothing to stand on. Pick another company:",
          })
        : t("companyCards.pick", {
            page: pageName,
            defaultValue: "Pick the company {{page}} works on:",
          });

  return (
    <section data-testid="company-cards" data-reason={reason} className="space-y-3">
      <p data-testid="company-cards-sentence" className="text-[14px] leading-snug text-ink-soft">
        {sentence}
      </p>
      {workspaces.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {workspaces.map((w) => {
            const onScreen = w.id === current?.id;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  data-testid={`company-card-${w.id}`}
                  data-on-screen={onScreen ? "true" : "false"}
                  onClick={() => void onPick(w.id)}
                  className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-rule bg-surface px-4 py-3 text-left transition-colors hover:border-rule-strong hover:bg-bg-2/40"
                >
                  <Building2 size={18} strokeWidth={1.75} className="shrink-0 text-ink-mute" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink">{w.name}</span>
                    <span className="block truncate font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                      {onScreen
                        ? t("companyCards.onScreen", "On screen")
                        : t("companyCards.open", "Open")}
                    </span>
                  </span>
                  <ChevronRight size={16} strokeWidth={1.75} className="shrink-0 text-ink-mute" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export default CompanyCards;
