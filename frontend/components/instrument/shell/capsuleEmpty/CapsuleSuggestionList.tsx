// THE CAPSULE — ZONE 2: the ask suggestions.
//
// Rows are QUESTIONS computed from this workspace (lib/capsuleSuggestions),
// never a canned starter set. Three consequences visible here:
//
//   · when the state yields two, TWO render. There is no placeholder row,
//     no "try asking…" filler, and no third slot held open;
//   · when it yields NONE, this renders nothing at all — not a heading
//     with an apology under it. The ask-first surface's whole claim is
//     that its rows are earned, and an empty heading un-earns them;
//   · every row carries its BASIS — where the question came from. The
//     covenant row's basis says the test is a typical Romanian facility,
//     not the user's loan documents, because it is.
//
// ── Why the basis moved onto the same line ────────────────────────────
//
// It used to sit under the question as a second line, making each row
// ~44px of a 5-section stack. The row is now a single 40px line: question
// left, basis right, muted and truncated, with the full text in `title`.
// The honesty is unchanged — the sentence is still there, still per-row —
// and the surface got a third of its height back.
//
// Picking a row does NOT send it. It hands the resolved text to the host,
// which puts it in the input, so the user confirms or edits first — and
// so a suggestion can never spend a model call on its own.

import { useTranslation } from "react-i18next";
import { CornerDownLeft } from "lucide-react";

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
      <div className="px-4 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
        {t("capsuleEmpty.suggest.heading")}
      </div>
      <ul>
        {suggestions.map((s, i) => {
          const idx = indexOffset + i;
          const question = t(s.labelKey, s.labelParams);
          const basis = t(s.basisKey);
          const active = idx === activeIndex;
          return (
            <li key={s.id}>
              <button
                type="button"
                data-testid="capsule-suggestion"
                data-kind={s.kind}
                data-idx={idx}
                role="option"
                aria-selected={active}
                title={`${question} — ${basis}`}
                onClick={() => onPick(question, s)}
                className={`
                  group flex h-10 w-full items-center gap-3 px-4 text-left
                  transition-colors duration-micro
                  ${active ? "bg-bg-2" : "hover:bg-bg-2/60"}
                `}
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {question}
                </span>
                <span className="hidden max-w-[42%] shrink-0 truncate text-[11px] text-ink-mute sm:inline">
                  {basis}
                </span>
                {/* The affordance the row is FOR: this text goes in the
                    box, it is not dispatched. Shown on the row the
                    keyboard owns so the promise is where the eye is. */}
                <CornerDownLeft
                  size={12}
                  strokeWidth={1.75}
                  aria-hidden
                  className={`shrink-0 text-ink-mute transition-opacity duration-micro ${
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-60"
                  }`}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
