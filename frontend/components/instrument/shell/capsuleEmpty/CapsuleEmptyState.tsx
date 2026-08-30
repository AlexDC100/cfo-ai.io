// THE CAPSULE — the resting state. TWO ZONES, and no third.
//
//   1. CONTEXT STRIP  one line — which period, its verdict, what is
//                     missing, and the missing thing is a button
//   2. ASK            up to three question CHIPS computed from THIS
//                     workspace. Zero is a legal answer
//
// ── The craft pass removed a zone ─────────────────────────────────────
//
// There used to be a third: four destinations under a "Jump to…" label.
// It is gone from the RESTING surface, and this is the one subtraction
// in the pass that costs something, so it is worth stating plainly.
//
// What it bought: the resting card is now context + chips + composer,
// and every pixel above the composer is a sentence the reader could say.
// That is the whole claim of an ask-first surface, and four navigation
// rows sitting under the questions were the last thing contradicting it
// — same 40px geometry as the suggestions, same muted right-hand text,
// so the eye read one undifferentiated list of eight.
//
// What it costs: at rest, nothing on screen says you can also jump.
// The mitigation is that navigation is one keystroke away and always
// was — the router answers every character for free, and the first
// keystroke paints the destinations under their own label. `MAX_JUMPS`,
// `rankByUsage` and `CapsuleJumpList` are all still here and still
// wired; the host renders them the moment there is a query.
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
  /** The former zone 3. The live host now passes NOTHING here — see the
   *  module header. Kept in the contract because the ranking, the cap
   *  and the row component are all still live behind the first
   *  keystroke, and a view that cannot render them would make that
   *  impossible to prove from one place. */
  jumps?: readonly CapsuleJumpItem[];
  onPick: (question: string, source: CapsulePickSource) => void;
  onJump?: (item: CapsuleJumpItem) => void;
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
  jumps = [],
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
      {/* ONE MUTED LINE, not a section. It is the honest answer to
          "what should I ask?" when the workspace has nothing to
          volunteer, and an honest answer that occupies a heading, a
          rule and a block of its own is a section apologising. */}
      {showEmptyLine && (
        <p
          data-testid="capsule-suggestions-empty"
          className="px-3.5 pb-1 pt-1 text-[11.5px] leading-snug text-ink-soft"
        >
          {t("capsuleEmpty.suggest.empty")}
        </p>
      )}
      {/* Renders nothing for an empty list, which is what the live host
          passes. The flat keyboard order still continues from the chips
          above, derived rather than hard-coded, for any caller that does
          supply rows. */}
      <CapsuleJumpList
        items={jumps}
        onPick={onJump ?? (() => {})}
        activeIndex={activeIndex}
        indexOffset={indexOffset + suggestions.length}
      />
      {askBlock && <CapsuleAskUnavailable block={askBlock} onRetry={onRetryAi} />}
    </div>
  );
}

export interface CapsuleEmptyStateProps {
  onPick: (question: string, source: CapsulePickSource) => void;
  jumps?: readonly CapsuleJumpItem[];
  onJump?: (item: CapsuleJumpItem) => void;
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
