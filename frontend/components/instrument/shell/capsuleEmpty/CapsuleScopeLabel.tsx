// THE CAPSULE — scope honesty label (Part F.6).
//
// Sits with the answer. Says, in words, whether what you just read came
// from your books. The general-knowledge label is the loud one on
// purpose: a well-written answer about DSCR mechanics is indistinguishable
// from a well-written answer about YOUR DSCR unless something says which
// it is.
//
// Matches the chat surface's existing honesty rule ("No workspace loaded
// — open-domain mode"), moved from a mode banner to a per-answer label,
// because the Capsule mixes both in one stream.

import { useTranslation } from "react-i18next";

import "./capsuleEmptyI18n";
import { Chip, type ChipTone } from "@/components/instrument/Panel";
import {
  scopeHintKey,
  scopeLabelKey,
  type CapsuleAnswerScope,
} from "./capsuleScope";

// `books` is the unremarkable case and stays quiet. `general` is INFO,
// not caution: answering a general finance question is a feature, not a
// fault. `mixed` is the one that earns caution — it is the only state a
// reader can misread as fully grounded.
const SCOPE_TONE: Record<CapsuleAnswerScope, ChipTone> = {
  books: "neutral",
  general: "info",
  mixed: "caution",
};

export interface CapsuleScopeLabelProps {
  scope: CapsuleAnswerScope;
  /** Formatted period label. Null falls back to the period-free wording
   *  rather than rendering an empty interpolation. */
  periodLabel?: string | null;
  /** Render the explanatory line under the chip. */
  showHint?: boolean;
}

export function CapsuleScopeLabel({
  scope,
  periodLabel = null,
  showHint = true,
}: CapsuleScopeLabelProps) {
  const { t } = useTranslation();
  const hint = showHint ? scopeHintKey(scope) : null;

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Chip tone={SCOPE_TONE[scope]} data-testid="capsule-scope" data-scope={scope}>
        {t(scopeLabelKey(scope, !!periodLabel), { period: periodLabel ?? "" })}
      </Chip>
      {hint && (
        <span data-testid="capsule-scope-hint" className="text-[11px] leading-relaxed text-ink-mute">
          {t(hint)}
        </span>
      )}
    </span>
  );
}
