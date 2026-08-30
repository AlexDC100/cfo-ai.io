// THE CAPSULE — the empty state.
//
// What you see with the Capsule open and nothing typed:
//
//   1. CONTEXT ZONE — which period, what the engine's verdict on it is,
//      what the workspace is missing, and the last few questions.
//   2. UP TO THREE SUGGESTIONS — computed from that same state. Not a
//      starter menu: if the workspace yields one question, ONE renders.
//   3. THE CALM STATE — when the assistant is down or the ask budget is
//      cooling, a notice sits under the rows; the router's navigate,
//      entity and action lanes above it keep working untouched.
//
// Two components:
//   · `CapsuleEmptyStateView` — pure props, no hooks. The gate drives
//     this one, which is why the gate needs no query client, no router
//     and no auth provider.
//   · `CapsuleEmptyState` — the connected mount point. The Capsule's
//     host (CommandPalette, owned by the answer lane) renders THIS.
//
// Picking a row NEVER sends. It hands the resolved question text back so
// the host can put it in the input — a suggestion cannot spend a model
// call by itself.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import "./capsuleEmptyI18n";
import { useViewMode } from "@/lib/viewMode";
import {
  buildCapsuleContext,
  buildCapsuleSuggestions,
  type CapsuleContextModel,
  type CapsuleSuggestion,
  type CapsuleWorkspaceSnapshot,
} from "@/lib/capsuleSuggestions";
import { CapsuleContextZone } from "./CapsuleContextZone";
import { CapsuleRecentQuestions } from "./CapsuleRecentQuestions";
import { CapsuleSuggestionList } from "./CapsuleSuggestionList";
import { CapsuleAskUnavailable } from "./CapsuleAskUnavailable";
import { useCapsuleAskAvailability, type CapsuleAskBlock } from "./useCapsuleAsk";
import { useCapsuleSnapshot } from "./useCapsuleSnapshot";
import { useCapsuleKeys } from "./capsuleKeys";
import { clearCapsuleRecents, useCapsuleRecents } from "./capsuleRecents";

/** Where a picked question came from — the host may want to distinguish
 *  a recalled question (already asked once) from a fresh suggestion. */
export type CapsulePickSource = "suggestion" | "recent";

export interface CapsuleEmptyStateViewProps {
  context: CapsuleContextModel;
  trustLabel: string | null;
  suggestions: readonly CapsuleSuggestion[];
  recents: readonly string[];
  onPick: (question: string, source: CapsulePickSource) => void;
  onClearRecents?: () => void;
  /** Non-null renders the calm notice. Never carries an error string —
   *  see CapsuleAskUnavailable's header. */
  askBlock?: CapsuleAskBlock | null;
  onRetryAi?: () => void;
  /** Flat keyboard index the host currently owns, if it wires arrows
   *  through the suggestion rows. */
  activeIndex?: number;
  indexOffset?: number;
}

export function CapsuleEmptyStateView({
  context,
  trustLabel,
  suggestions,
  recents,
  onPick,
  onClearRecents,
  askBlock = null,
  onRetryAi,
  activeIndex = -1,
  indexOffset = 0,
}: CapsuleEmptyStateViewProps) {
  const { t } = useTranslation();

  // The one place "fewer, not filler" becomes visible: with a period
  // loaded and nothing to suggest, we say so in one quiet line rather
  // than padding to three.
  const showEmptyLine = suggestions.length === 0 && !!context.periodLabel;

  return (
    <div data-testid="capsule-empty-state">
      <CapsuleContextZone context={context} trustLabel={trustLabel} />
      <CapsuleRecentQuestions
        recents={recents}
        onPick={(q) => onPick(q, "recent")}
        onClear={onClearRecents}
      />
      <CapsuleSuggestionList
        suggestions={suggestions}
        onPick={(q) => onPick(q, "suggestion")}
        activeIndex={activeIndex}
        indexOffset={indexOffset}
      />
      {showEmptyLine && (
        <p
          data-testid="capsule-suggestions-empty"
          className="px-4 py-3 text-[12px] leading-relaxed text-ink-mute"
        >
          {t("capsuleEmpty.suggest.empty")}
        </p>
      )}
      {askBlock && <CapsuleAskUnavailable block={askBlock} onRetry={onRetryAi} />}
    </div>
  );
}

export interface CapsuleEmptyStateProps {
  onPick: (question: string, source: CapsulePickSource) => void;
  /** Wired to whatever the host can re-run. Omitted, no Retry renders. */
  onRetryAi?: () => void;
  activeIndex?: number;
  indexOffset?: number;
}

/** The mount point. See the module header for what the host renders. */
export function CapsuleEmptyState({
  onPick,
  onRetryAi,
  activeIndex,
  indexOffset,
}: CapsuleEmptyStateProps) {
  const mode = useViewMode();
  const { snapshot, trustLabel } = useCapsuleSnapshot();
  const { userKey, orgKey } = useCapsuleKeys();
  const recents = useCapsuleRecents(orgKey);
  const { block } = useCapsuleAskAvailability(userKey);

  const context = useMemo(() => buildCapsuleContext(snapshot), [snapshot]);
  const suggestions = useMemo(
    () => buildCapsuleSuggestions(snapshot, mode),
    [snapshot, mode],
  );

  return (
    <CapsuleEmptyStateView
      context={context}
      trustLabel={trustLabel}
      suggestions={suggestions}
      recents={recents}
      onPick={onPick}
      onClearRecents={() => clearCapsuleRecents(orgKey)}
      askBlock={block}
      onRetryAi={onRetryAi}
      activeIndex={activeIndex}
      indexOffset={indexOffset}
    />
  );
}

export type { CapsuleWorkspaceSnapshot };
