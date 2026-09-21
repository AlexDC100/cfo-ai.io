// THE CASE SWITCH — Bază · Optimist · Pesimist, then the reader's own cases.
//
// An engine case is a lever set the ENGINE defines (its labels are served);
// a saved case is the reader's own set — the case it starts from plus the
// sliders they moved — stored per company (lib/forecastCases.ts, gate F6) and
// never shown on another company. Choosing either sends a request to the
// engine; nothing here holds a figure.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";

import { pick, type CockpitCase } from "@/lib/forecastCockpit";
import type { SavedForecastCase } from "@/lib/forecastCases";

export type ActiveCase = { kind: "engine"; id: string } | { kind: "saved"; id: string };

export function CaseSwitch({
  cases,
  saved,
  active,
  lang,
  canSave,
  dirty,
  saving,
  saveError,
  onEngineCase,
  onSavedCase,
  onSave,
  onDelete,
}: {
  cases: readonly CockpitCase[];
  saved: readonly SavedForecastCase[];
  active: ActiveCase;
  lang: string;
  /** A company is on screen and the reader is signed in. */
  canSave: boolean;
  /** The sliders differ from the active case: there is something to save. */
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  onEngineCase: (id: string) => void;
  onSavedCase: (c: SavedForecastCase) => void;
  onSave: (name: string) => void;
  onDelete: (c: SavedForecastCase) => void;
}) {
  const { t } = useTranslation();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const pill = (isActive: boolean) =>
    `inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors duration-micro ${
      isActive
        ? "bg-surface text-ink shadow-sm ring-1 ring-rule-strong"
        : "text-ink-soft hover:text-ink"
    }`;

  return (
    <div data-testid="cockpit-cases" className="flex flex-wrap items-center gap-2">
      <div
        role="radiogroup"
        aria-label={t("forecast.cockpit.cases.aria", "Case")}
        className="flex flex-wrap items-center gap-1 rounded-lg bg-bg-2 p-1"
      >
        {cases.map((c) => {
          const isActive = active.kind === "engine" && active.id === c.id;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={isActive}
              data-testid={`cockpit-case-${c.id}`}
              onClick={() => onEngineCase(c.id)}
              className={pill(isActive)}
            >
              {pick(c.label, lang)}
            </button>
          );
        })}
        {saved.map((c) => {
          const isActive = active.kind === "saved" && active.id === c.id;
          return (
            <span key={c.id} className="group inline-flex items-center">
              <button
                type="button"
                role="radio"
                aria-checked={isActive}
                data-testid={`cockpit-saved-${c.id}`}
                data-saved-org={c.orgId}
                onClick={() => onSavedCase(c)}
                className={pill(isActive)}
              >
                {c.name}
              </button>
              <button
                type="button"
                data-testid={`cockpit-saved-delete-${c.id}`}
                aria-label={t("forecast.cockpit.cases.delete", "Delete {{name}}", { name: c.name })}
                onClick={() => onDelete(c)}
                className="ml-0.5 rounded p-0.5 text-ink-mute opacity-60 hover:text-ink group-hover:opacity-100"
              >
                <X size={12} strokeWidth={2} aria-hidden />
              </button>
            </span>
          );
        })}
      </div>

      {canSave ? (
        naming ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              onSave(trimmed);
              setNaming(false);
              setName("");
            }}
          >
            <input
              autoFocus
              data-testid="cockpit-save-name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setNaming(false);
                }
              }}
              placeholder={t("forecast.cockpit.cases.namePlaceholder", "Name this case")}
              className="h-8 w-44 rounded-md border border-rule bg-surface px-2 text-[13px] text-ink placeholder:text-ink-mute"
            />
            <button
              type="submit"
              data-testid="cockpit-save-confirm"
              disabled={saving || name.trim() === ""}
              className="h-8 rounded-md border border-rule px-2.5 text-[12.5px] font-medium text-ink hover:bg-bg-2 disabled:opacity-50"
            >
              {t("forecast.cockpit.cases.saveConfirm", "Save")}
            </button>
          </form>
        ) : (
          <button
            type="button"
            data-testid="cockpit-save"
            disabled={saving}
            onClick={() => setNaming(true)}
            title={
              dirty
                ? undefined
                : t("forecast.cockpit.cases.saveHint", "Move a slider, then save the set as your own case")
            }
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-ink-soft hover:text-ink disabled:opacity-50"
          >
            <Plus size={13} strokeWidth={2} aria-hidden />
            {t("forecast.cockpit.cases.save", "Save my case")}
          </button>
        )
      ) : null}
      {saveError ? (
        <span data-testid="cockpit-save-error" className="text-[12px] text-alert">
          {saveError}
        </span>
      ) : null}
    </div>
  );
}
