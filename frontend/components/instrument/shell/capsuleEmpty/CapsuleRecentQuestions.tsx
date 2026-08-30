// THE CAPSULE — recent questions, inside the context zone.
//
// A compact pill row, not a history page: the last few questions, capped
// at three, with the ⌘K → ArrowUp recall hint carrying the rest. Full
// history lives in /chat; this is "what was I just asking about".
//
// Renders NOTHING when there are no recents — the empty state's own rule.

import { useTranslation } from "react-i18next";

import "./capsuleEmptyI18n";

/** How many pills fit before the row stops being a glance. The rest are
 *  reachable with ArrowUp. */
export const RECENT_PILLS = 3;

export interface CapsuleRecentQuestionsProps {
  recents: readonly string[];
  onPick: (question: string) => void;
  onClear?: () => void;
}

export function CapsuleRecentQuestions({
  recents,
  onPick,
  onClear,
}: CapsuleRecentQuestionsProps) {
  const { t } = useTranslation();
  if (recents.length === 0) return null;

  return (
    <div
      data-testid="capsule-recents"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-rule-soft px-4 py-2"
    >
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
        {t("capsuleEmpty.recents.heading")}
      </span>
      {recents.slice(0, RECENT_PILLS).map((q) => (
        <button
          key={q}
          type="button"
          data-testid="capsule-recent"
          onClick={() => onPick(q)}
          title={q}
          className="
            max-w-[220px] truncate rounded-full border border-rule bg-bg-2 px-2.5 py-0.5
            text-[11.5px] text-ink-soft transition-colors duration-micro
            hover:border-rule hover:text-ink
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
          "
        >
          {q}
        </button>
      ))}
      <span className="text-[11px] text-ink-mute">{t("capsuleEmpty.recents.recallHint")}</span>
      {onClear && (
        <button
          type="button"
          data-testid="capsule-recents-clear"
          aria-label={t("capsuleEmpty.recents.clearLabel")}
          onClick={onClear}
          className="
            ml-auto text-[11px] text-ink-mute transition-colors duration-micro
            hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
          "
        >
          {t("capsuleEmpty.recents.clear")}
        </button>
      )}
    </div>
  );
}
