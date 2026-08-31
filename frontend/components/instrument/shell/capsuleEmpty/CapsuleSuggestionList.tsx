// THE CAPSULE — ZONE 2: the asks, as QUESTION CHIPS.
//
// Questions computed from this workspace (lib/capsuleSuggestions), never
// a canned starter set. Three consequences are unchanged: two render
// when the state yields two, none renders nothing at all rather than a
// heading with an apology under it, and picking one NEVER sends — it
// hands the resolved text to the host, which puts it in the composer.
//
// ══ WHAT CHANGED IN THE CRAFT PASS, AND WHY ═══════════════════════════
//
// These used to be 40px full-bleed ROWS, and the four navigation rows
// below them were 40px full-bleed rows too. Identical geometry, identical
// weight, identical right-aligned muted trailing text. A reader scanning
// the surface saw one list of eight equivalent things and had no way to
// know that the top three were sentences they could SAY and the bottom
// four were places they could GO.
//
// A chip is the shape of an utterance. Pill, hairline, hugging its own
// text, wrapping in a loose group — the same object a chat surface uses
// for "the next thing you might say", which is exactly what these are.
// The navigation rows stayed rows. The two are now different objects
// because they are different kinds of thing, which is the only honest
// reason to make two things look different.
//
// ── The basis moved, and did not disappear ────────────────────────────
//
// Every suggestion carries a BASIS — where the question came from — and
// the covenant one carries a disclaimer that matters: the test is a
// typical Romanian facility, not the reader's loan documents. That
// sentence cannot ride inside a pill; a chip the width of a paragraph is
// not a chip, and it stops reading as something you could say.
//
// So it is stated TWICE, in the two places it has to be true:
//   · per chip, in `aria-label` — a screen-reader user hears the
//     question and its basis as one utterance, which is strictly more
//     than the old row's separate muted span gave them;
//   · once visibly, as ONE muted line under the group, carrying the
//     DEDUPLICATED bases. Three chips drawn from one source say their
//     source once.
// `capsuleEmpty.test.tsx` asserts both halves. Neither is optional.
//
// ── No `title` ────────────────────────────────────────────────────────
//
// The old row set `title={question — basis}`, which the browser renders
// as a native tooltip: a grey OS-drawn box, in the OS font, restating
// text that was already fully visible one pixel away. It was one of the
// seven complaints. `aria-label` carries the same string to the readers
// who need it and paints nothing.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import "./capsuleEmptyI18n";
import "../capsuleCraftI18n";
import type { CapsuleSuggestion } from "@/lib/capsuleSuggestions";

export interface CapsuleSuggestionListProps {
  suggestions: readonly CapsuleSuggestion[];
  /** Receives the RESOLVED question text — what belongs in the composer. */
  onPick: (question: string, suggestion: CapsuleSuggestion) => void;
  /** Index of the chip the palette's keyboard currently owns, when the
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

  const resolved = useMemo(
    () =>
      suggestions.map((s) => ({
        s,
        question: t(s.labelKey, s.labelParams),
        basis: t(s.basisKey),
      })),
    [suggestions, t],
  );

  // Deduplicated, order preserved. Three chips from one source state
  // that source once; three chips from three sources state all three.
  const bases = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of resolved) {
      if (!r.basis || seen.has(r.basis)) continue;
      seen.add(r.basis);
      out.push(r.basis);
    }
    return out;
  }, [resolved]);

  // Fewer, not filler — and none at all renders nothing, not a message
  // pretending to be a chip.
  if (resolved.length === 0) return null;

  return (
    <div data-testid="capsule-suggestions" className="px-3.5 pb-1 pt-2.5">
      <ul className="flex flex-wrap gap-2">
        {resolved.map(({ s, question, basis }, i) => {
          const idx = indexOffset + i;
          const active = idx === activeIndex;
          return (
            <li key={s.id} className="max-w-full">
              <button
                type="button"
                data-testid="capsule-suggestion"
                data-row-source="suggestion"
                data-kind={s.kind}
                data-idx={idx}
                role="option"
                aria-selected={active}
                // NO `title`. See the header.
                aria-label={t("capsuleCraft.suggest.aria", { question, basis })}
                onClick={() => onPick(question, s)}
                className={`
                  max-w-full truncate rounded-[10px] border px-3 py-[7px]
                  text-left text-[12.5px] leading-5
                  transition-colors duration-micro
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                  ${
                    active
                      ? "border-brand/40 bg-brand-tint text-ink"
                      : "border-rule bg-bg-2/40 text-ink-soft hover:border-rule-strong hover:bg-bg-2 hover:text-ink"
                  }
                `}
              >
                {question}
              </button>
            </li>
          );
        })}
      </ul>

      {/* The honesty, once, quietly. */}
      {bases.length > 0 && (
        <p
          data-testid="capsule-suggestion-basis"
          className="mt-2.5 text-[10.5px] leading-snug text-ink-soft"
        >
          {bases.join(t("capsuleCraft.suggest.basisJoin"))}
        </p>
      )}
    </div>
  );
}
