// THE CAPSULE — suggestions / degraded / limits lane, public surface.
//
// The host (CommandPalette, owned by the answer lane) imports from HERE,
// never from the individual files, so this barrel is the contract.
//
// ── What the host mounts ──────────────────────────────────────────────
//
//   <CapsuleEmptyState onPick={…} />          with the input empty
//   <CapsuleAskRowNotice block={…} />         inside the Ask ROW, in place
//                                             of its own label, when
//                                             `block` is non-null
//   <CapsuleAskUnavailable block={…} />       under the rows (optional —
//                                             the empty state already
//                                             renders it for itself)
//   <CapsuleScopeLabel scope={…} />           beside a rendered answer
//
// ── What the host calls ───────────────────────────────────────────────
//
//   useCapsuleKeys()                → { userKey, orgKey }
//   useCapsuleAskAvailability(uk)   → { available, block }
//   reserveCapsuleAsk(userKey)      before dispatching a model call
//   releaseCapsuleAsk(userKey)      if that call never left
//   rememberCapsuleQuestion(ok, q)  after a question is actually sent
//   useCapsuleRecall(orgKey)        for ⌘K → ArrowUp
//
// Nothing here mutates workspace data, and nothing here can dispatch a
// model call: `reserveCapsuleAsk` returns permission, never a request.

export {
  CapsuleEmptyState,
  CapsuleEmptyStateView,
  type CapsuleEmptyStateProps,
  type CapsuleEmptyStateViewProps,
  type CapsulePickSource,
} from "./CapsuleEmptyState";

export { CapsuleContextZone, type CapsuleContextZoneProps } from "./CapsuleContextZone";
export {
  CapsuleSuggestionList,
  type CapsuleSuggestionListProps,
} from "./CapsuleSuggestionList";
export {
  CapsuleRecentQuestions,
  RECENT_PILLS,
  type CapsuleRecentQuestionsProps,
} from "./CapsuleRecentQuestions";
export {
  CapsuleAskRowNotice,
  CapsuleAskUnavailable,
  type CapsuleAskNoticeProps,
  type CapsuleAskUnavailableProps,
} from "./CapsuleAskUnavailable";
export { CapsuleScopeLabel, type CapsuleScopeLabelProps } from "./CapsuleScopeLabel";

export {
  scopeOfAnswer,
  scopeLabelKey,
  scopeHintKey,
  type CapsuleAnswerScope,
  type CapsuleScopeInput,
} from "./capsuleScope";

export {
  useCapsuleAskAvailability,
  capsuleAskRowLabelKey,
  type CapsuleAskAvailability,
  type CapsuleAskBlock,
} from "./useCapsuleAsk";

export {
  ASK_BURST_LIMIT,
  ASK_MIN_GAP_MS,
  ASK_WINDOW_MS,
  checkCapsuleAsk,
  releaseCapsuleAsk,
  reserveCapsuleAsk,
  resetCapsuleAskGuard,
  useCapsuleAskThrottle,
  type CapsuleAskDecision,
  type CapsuleAskThrottle,
} from "./capsuleAskGuard";

export {
  MAX_RECENTS,
  MAX_RECENT_LENGTH,
  capsuleRecents,
  clearCapsuleRecents,
  rememberCapsuleQuestion,
  resetCapsuleRecentsCache,
  useCapsuleRecall,
  useCapsuleRecents,
  type CapsuleRecall,
} from "./capsuleRecents";

export { useCapsuleKeys, type CapsuleKeys } from "./capsuleKeys";
export { useCapsuleSnapshot, type CapsuleSnapshotResult } from "./useCapsuleSnapshot";
export { ensureCapsuleEmptyStrings } from "./capsuleEmptyI18n";
