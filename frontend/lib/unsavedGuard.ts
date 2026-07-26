// unsavedGuard — one place that knows "leaving right now loses edits".
//
// The Workspace settings tab stages its changes (name, industry, decision
// rules) and commits them on "Apply changes"; leaving without applying reverts
// them. The revert is correct but silent, so a user who tuned a dozen
// thresholds and clicked another tab lost the lot with no warning.
//
// A page registers a guard while it's dirty; navigation chokepoints call
// `confirmLeaveUnsaved()` first and stand down if it returns false.
//
// Why a synchronous window.confirm and not the app's Dialog: the router here
// is a plain BrowserRouter (not a data router), so `useBlocker` isn't
// available and a nav click can't be paused while a custom dialog resolves.
// The one surface that CAN afford a styled dialog — the settings tab's own
// "All workspaces" link — keeps using it; this covers everything else.

let activeMessage: string | null = null;

/** Register (or clear, with null) the unsaved-changes warning. Call from an
 *  effect keyed on the page's `dirty` flag, and clear on unmount. */
export function setUnsavedGuard(message: string | null): void {
  activeMessage = message;
}

/** True when something on screen has unapplied edits. */
export function hasUnsavedChanges(): boolean {
  return activeMessage !== null;
}

/**
 * Ask before navigating away. Returns true when the caller may proceed —
 * either because nothing is dirty, or because the user accepted losing the
 * edits (in which case the guard is cleared so the next click doesn't re-ask).
 */
export function confirmLeaveUnsaved(): boolean {
  if (activeMessage === null) return true;
  const proceed = window.confirm(activeMessage);
  if (proceed) activeMessage = null;
  return proceed;
}
