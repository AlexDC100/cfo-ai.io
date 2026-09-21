// SAVED SCENARIOS — this company's own, and only this company's (gate F6).
//
// What is saved is the REQUEST (template id + the reader's lever overrides),
// through `lib/savedScenarios` into org_prefs.prefs.scenarios of the company
// ON SCREEN, named explicitly on every read and write. Opening one sends the
// request to the engine again, so it always paints what the engine serves
// today. The list is keyed by the company's id in the query cache, and every
// listed entry names that company: a Scandia scenario never shows on Agras.
//
// "Save scenario" is the page's ONE primary action.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, X } from "lucide-react";

import {
  deleteSavedScenario,
  loadSavedScenarios,
  saveScenario,
  type SavedScenario,
} from "@/lib/savedScenarios";

export interface SavedScenariosProps {
  readonly orgId: string;
  readonly periodId: string;
  readonly periodLabel: string | null;
  readonly templateId: string;
  readonly templateName: string;
  readonly overrides: Record<string, { values: (string | null)[] }>;
  /** A saved scenario was opened: the page re-asks the engine for it. */
  onOpen(saved: SavedScenario): void;
}

export const savedScenariosKey = (orgId: string) => ["saved-scenarios", orgId] as const;

export function SavedScenarios({
  orgId,
  periodId,
  periodLabel,
  templateId,
  templateName,
  overrides,
  onOpen,
}: SavedScenariosProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const list = useQuery({
    queryKey: savedScenariosKey(orgId),
    queryFn: () => loadSavedScenarios(orgId),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const save = useMutation({
    mutationFn: () =>
      saveScenario(orgId, {
        name: name.trim() || templateName,
        templateId,
        overrides,
        periodId,
        periodLabel,
      }),
    onSuccess: (next) => {
      qc.setQueryData(savedScenariosKey(orgId), next);
      setName("");
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteSavedScenario(orgId, id),
    onSuccess: (next) => qc.setQueryData(savedScenariosKey(orgId), next),
  });
  const saved = (list.data ?? []).filter((s) => s.orgId === orgId);
  const error = save.error ?? remove.error ?? list.error;

  return (
    <section
      data-testid="scenarios-saved"
      data-org-id={orgId}
      className="rounded-xl border border-rule bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-mono text-[11px] uppercase tracking-wider text-ink-mute">
          {t("scenarios.saved.title", "Saved scenarios")}
        </h2>
        <label className="sr-only" htmlFor="scenario-save-name">
          {t("scenarios.saved.nameLabel", "Scenario name")}
        </label>
        <input
          id="scenario-save-name"
          data-testid="scenarios-save-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={templateName}
          maxLength={80}
          className="h-9 w-full min-w-0 rounded-lg border border-rule bg-bg px-3 text-[13px] text-ink placeholder:text-ink-mute sm:w-56"
        />
        <button
          type="button"
          data-testid="scenarios-save"
          data-primary-action="true"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-brand-d disabled:opacity-60"
        >
          <Bookmark size={14} strokeWidth={2} aria-hidden />
          {save.isPending
            ? t("scenarios.saved.saving", "Saving…")
            : t("scenarios.saved.save", "Save scenario")}
        </button>
      </div>
      {error ? (
        <p data-testid="scenarios-saved-error" className="mt-2 text-[12px] leading-snug text-alert">
          {t("scenarios.saved.error", "The scenario could not be saved or read: {{message}}", {
            message: error instanceof Error ? error.message : String(error),
          })}
        </p>
      ) : null}
      {saved.length === 0 ? (
        <p data-testid="scenarios-saved-empty" className="mt-2 text-[12px] leading-snug text-ink-soft">
          {list.isPending
            ? t("scenarios.saved.loading", "Reading this company's saved scenarios…")
            : t(
                "scenarios.saved.empty",
                "No saved scenario for this company yet. A saved scenario keeps the template and your levers, and re-runs them through the engine when you open it.",
              )}
        </p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2" data-testid="scenarios-saved-list">
          {saved.map((s) => (
            <li
              key={s.id}
              data-testid={`scenarios-saved-${s.id}`}
              data-org-id={s.orgId}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-rule bg-bg-2/40 pl-3 pr-1"
            >
              <button
                type="button"
                data-testid={`scenarios-saved-open-${s.id}`}
                onClick={() => onOpen(s)}
                className="min-w-0 truncate py-1 text-[12.5px] text-ink hover:underline"
              >
                {s.name}
                <span className="ml-1.5 font-mono text-[9.5px] uppercase tracking-wider text-ink-mute">
                  {t(`scenarios.template.${s.templateId}.name`, s.templateId)}
                </span>
              </button>
              <button
                type="button"
                data-testid={`scenarios-saved-remove-${s.id}`}
                aria-label={t("scenarios.saved.remove", "Remove {{name}}", { name: s.name })}
                onClick={() => remove.mutate(s.id)}
                className="rounded-full p-1 text-ink-mute hover:bg-bg-2 hover:text-ink"
              >
                <X size={12} strokeWidth={2} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default SavedScenarios;
