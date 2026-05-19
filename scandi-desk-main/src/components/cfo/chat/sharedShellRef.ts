// Module-level singleton holding a reference to the currently mounted
// CFOChatShell (page variant only). Set by the /chat page on mount,
// read by AppShell.openAskCfoAi() to decide whether clicking the
// top-header "Ask CFO AI" button should:
//   · focus the live composer in the page (when set), or
//   · open the slide-over panel (when unset — i.e. the user is on
//     another route).
//
// A module-level mutable singleton is the pragmatic choice here:
// React Context would force every page to subscribe, and it's used in
// exactly one place — by a non-React callback inside AppShell. Plain
// global ref is fine and easy to reason about.

import type { CFOChatShellHandle } from "./CFOChatShell";

let current: CFOChatShellHandle | null = null;

export function setChatShellRef(handle: CFOChatShellHandle | null): void {
  current = handle;
}

export function getChatShellRef(): CFOChatShellHandle | null {
  return current;
}
