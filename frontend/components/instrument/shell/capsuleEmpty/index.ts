// THE CAPSULE — suggestions / degraded / limits lane, public surface.
//
// The host (CommandPalette, owned by the answer lane) imports from HERE,
// never from the individual files, so this barrel is the contract.
//
// ── What the host mounts ──────────────────────────────────────────────
//
//   <CapsuleEmptyState … />                   with the input empty —
//                                             the THREE zones (context
//                                             strip / ask / jump)
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

export {
  CapsuleContextStrip,
  type CapsuleContextStripProps,
} from "./CapsuleContextStrip";
export {
  CapsuleSuggestionList,
  type CapsuleSuggestionListProps,
} from "./CapsuleSuggestionList";
export {
  CapsuleJumpList,
  MAX_JUMPS,
  type CapsuleJumpItem,
  type CapsuleJumpListProps,
} from "./CapsuleJumpList";
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
// `useCapsuleRecents` survives for the recall list itself; the visible
// RECENT-QUESTIONS ROW does not. Recents are now reached with ⌘K then
// ArrowUp — a shell-style recall — because a list of things you already
// asked is something you reach for, not something you read every time
// the surface opens. `CapsuleRecentQuestions` was deleted, not hidden.

export { useCapsuleKeys, type CapsuleKeys } from "./capsuleKeys";
export { useCapsuleSnapshot, type CapsuleSnapshotResult } from "./useCapsuleSnapshot";
export { ensureCapsuleEmptyStrings } from "./capsuleEmptyI18n";
