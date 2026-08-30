// THE CAPSULE — the three suggestions.
//
// Rows are QUESTIONS computed from this workspace (lib/capsuleSuggestions),
// never a canned starter set. Two consequences visible here:
//
//   · when the state yields two, TWO render. There is no placeholder row,
//     no "try asking…" filler, and no third slot held open;
//   · every row carries its BASIS line — where the question came from.
//     The covenant row's basis says the test is a typical Romanian
//     facility, not the user's loan documents, because it is.
//
// Picking a row does NOT send it. It fills the Capsule's input, exactly
// like the chat empty state's cards, so the user confirms or edits first —
// and so a suggestion can never spend a model call on its own.

import { useTranslation } from "react-i18next";

import "./capsuleEmptyI18n";
import type { CapsuleSuggestion } from "@/lib/capsuleSuggestions";

export interface CapsuleSuggestionListProps {
  suggestions: readonly CapsuleSuggestion[];
  /** Receives the RESOLVED question text — what belongs in the input. */
  onPick: (question: string, suggestion: CapsuleSuggestion) => void;
  /** Index of the row the palette's keyboard currently owns, when the
   *  host wires arrow keys through this list. -1 for none. */
  activeIndex?: number;
  /** Base for `data-idx`, so the host can keep one flat keyboard order
   *  across its own rows and these. */
  indexOffset?: number;
}

export function CapsuleSuggestionList({
  suggestions,
  onPick,
  activeIndex = -1,
  indexOffset = 0,
}: CapsuleSuggestionListProps) {
  const { t } = useTranslation();

  // Fewer, not filler — and none at all renders nothing, not a message
  // pretending to be a row.
  if (suggestions.length === 0) return null;

  return (
    <div data-testid="capsule-suggestions">
      <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
        {t("capsuleEmpty.suggest.heading")}
      </div>
      <ul>
        {suggestions.map((s, i) => {
          const idx = indexOffset + i;
          const question = t(s.labelKey, s.labelParams);
          return (
            <li key={s.id}>
              <button
                type="button"
                data-testid="capsule-suggestion"
                data-kind={s.kind}
                data-idx={idx}
                role="option"
                aria-selected={idx === activeIndex}
                onClick={() => onPick(question, s)}
                className={`
                  flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left
                  transition-colors duration-micro
                  ${idx === activeIndex ? "bg-bg-2" : "hover:bg-bg-2/60"}
                `}
              >
                <span className="w-full truncate text-[13px] text-ink">{question}</span>
                <span className="w-full truncate text-[11px] text-ink-mute">
                  {t(s.basisKey)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
