// THE DIAL — Simple-mode statement disclosure toggle (Prompt 12, Part C §2).
//
// Statements in Simple open totals-first: only the rows the builders mark
// as headline/total rows are visible, and this toggle expands to the full
// instrument table (comfortable density — the untouched Pro rendering).
// Rendered ONLY in Simple mode; Pro never sees it.

import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import "./storyI18n";

export function ShowAllLinesToggle({
  open,
  onToggle,
  testid,
}: {
  open: boolean;
  onToggle: () => void;
  testid?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="my-2 flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-testid={testid ?? "statement-show-all"}
        className="inline-flex h-7 items-center gap-1.5 rounded-full border border-rule bg-bg-2 px-3 text-[12px] font-medium text-ink transition-colors duration-micro hover:border-rule-strong hover:bg-bg"
      >
        {open ? t("story.statements.showKey") : t("story.statements.showAll")}
        <ChevronDown
          size={13}
          strokeWidth={2}
          className={`text-ink-mute transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {!open && (
        <span className="text-[11.5px] text-ink-mute">{t("story.statements.keyOnlyNote")}</span>
      )}
    </div>
  );
}
