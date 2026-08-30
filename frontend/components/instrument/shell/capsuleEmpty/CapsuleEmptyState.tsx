// THE CAPSULE — the empty state. THREE ZONES, and no fourth.
//
//   1. CONTEXT STRIP  one line — which period, its verdict, what is
//                     missing, and the missing thing is a button
//   2. ASK            up to three questions computed from THIS
//                     workspace. Zero is a legal answer
//   3. JUMP           four destinations under one label, last
//
// ── What was removed, and where it went ───────────────────────────────
//
// The surface used to stack FIVE sections — period status, recent
// questions, a workspace suggestion, actions, and every page — eighteen
// rows shown to a reader who had not yet said a word. That is a menu, and
// a menu is what you build when you do not know what the surface is for.
//
//   · the context BLOCK  → the context STRIP (one line)
//   · recent questions   → ⌘K then ArrowUp, a shell-style recall. It is
//                          a thing you reach for, not a thing you read
//   · actions + pages    → behind typing. The router already answers
//                          every keystroke for free; the four most-used
//                          destinations stay visible as the reminder
//   · the "Ask a question" ROW → deleted. Typing prose IS asking, and a
//                          verb does not need a row to sit in
//
// ── The rule the zones share ──────────────────────────────────────────
//
// Every zone renders nothing rather than something empty. No zone owns a
// fixed height, so the panel's height is the sum of what is actually
// true — which is what makes the dead space at the bottom of the old
// panel impossible to reintroduce by accident.
//
// Two components:
//   · `CapsuleEmptyStateView` — pure props, no hooks. The gate drives
//     this one, which is why the gate needs no query client, no router
//     and no auth provider.
//   · `CapsuleEmptyState` — the connected mount point. The Capsule's
//     host (CommandPalette) renders THIS.
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
import { CapsuleContextStrip } from "./CapsuleContextStrip";
import { CapsuleJumpList, MAX_JUMPS, type CapsuleJumpItem } from "./CapsuleJumpList";
import { CapsuleSuggestionList } from "./CapsuleSuggestionList";
import { CapsuleAskUnavailable } from "./CapsuleAskUnavailable";
import { useCapsuleAskAvailability, type CapsuleAskBlock } from "./useCapsuleAsk";
import { useCapsuleSnapshot } from "./useCapsuleSnapshot";
import { useCapsuleKeys } from "./capsuleKeys";

/** Where a picked question came from. Kept as a union even though the
 *  "recent" source now arrives through ArrowUp rather than a row — the
 *  host still distinguishes the two when it records a question. */
export type CapsulePickSource = "suggestion" | "recent";

export interface CapsuleEmptyStateViewProps {
  context: CapsuleContextModel;
  trustLabel: string | null;
  suggestions: readonly CapsuleSuggestion[];
  /** Zone 3. The host ranks these; this file only renders them. */
  jumps: readonly CapsuleJumpItem[];
  onPick: (question: string, source: CapsulePickSource) => void;
  onJump: (item: CapsuleJumpItem) => void;
  onFixUnattached?: (periodId: string) => void;
  onUpload?: () => void;
  /** Non-null renders the calm notice. Never carries an error string —
   *  see CapsuleAskUnavailable's header. */
  askBlock?: CapsuleAskBlock | null;
  onRetryAi?: () => void;
  /** Increments once per Tier-0 resolution — the status dot's one pulse. */
  pulseKey?: number;
  /** Flat keyboard index the host owns across BOTH lists. */
  activeIndex?: number;
  /** Where zone 2 starts in that flat order. Zone 3 follows it. */
  indexOffset?: number;
}

export function CapsuleEmptyStateView({
  context,
  trustLabel,
  suggestions,
  jumps,
  onPick,
  onJump,
  onFixUnattached,
  onUpload,
  askBlock = null,
  onRetryAi,
  pulseKey = 0,
  activeIndex = -1,
  indexOffset = 0,
}: CapsuleEmptyStateViewProps) {
  const { t } = useTranslation();

  // "Fewer, not filler" made visible: with a period loaded and nothing to
  // suggest, ONE quiet line says so rather than three invented questions.
  // It is the honest empty state, and it renders only when there IS a
  // period — a workspace with nothing loaded is explained by the strip
  // above, and saying it twice is a stutter.
  const showEmptyLine = suggestions.length === 0 && !!context.periodLabel;

  return (
    <div data-testid="capsule-empty-state">
      <CapsuleContextStrip
        context={context}
        trustLabel={trustLabel}
        onFixUnattached={onFixUnattached}
        onUpload={onUpload}
        pulseKey={pulseKey}
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
          className="px-4 pb-1 pt-2.5 text-[12px] leading-relaxed text-ink-soft"
        >
          {t("capsuleEmpty.suggest.empty")}
        </p>
      )}
      {/* Zone 3 continues the SAME flat keyboard order zone 2 started, so
          ArrowDown walks suggestions then jumps without a discontinuity —
          and the offset is derived, never a second hard-coded base. */}
      <CapsuleJumpList
        items={jumps}
        onPick={onJump}
        activeIndex={activeIndex}
        indexOffset={indexOffset + suggestions.length}
      />
      {askBlock && <CapsuleAskUnavailable block={askBlock} onRetry={onRetryAi} />}
    </div>
  );
}

export interface CapsuleEmptyStateProps {
  onPick: (question: string, source: CapsulePickSource) => void;
  jumps: readonly CapsuleJumpItem[];
  onJump: (item: CapsuleJumpItem) => void;
  onFixUnattached?: (periodId: string) => void;
  onUpload?: () => void;
  /** Wired to whatever the host can re-run. Omitted, no Retry renders. */
  onRetryAi?: () => void;
  pulseKey?: number;
  activeIndex?: number;
  indexOffset?: number;
}

/** The mount point. See the module header for what the host renders. */
export function CapsuleEmptyState({
  onPick,
  jumps,
  onJump,
  onFixUnattached,
  onUpload,
  onRetryAi,
  pulseKey,
  activeIndex,
  indexOffset,
}: CapsuleEmptyStateProps) {
  const mode = useViewMode();
  const { snapshot, trustLabel } = useCapsuleSnapshot();
  const { userKey } = useCapsuleKeys();
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
      jumps={jumps}
      onPick={onPick}
      onJump={onJump}
      onFixUnattached={onFixUnattached}
      onUpload={onUpload}
      askBlock={block}
      onRetryAi={onRetryAi}
      pulseKey={pulseKey}
      activeIndex={activeIndex}
      indexOffset={indexOffset}
    />
  );
}

export { MAX_JUMPS };
export type { CapsuleJumpItem, CapsuleWorkspaceSnapshot };
