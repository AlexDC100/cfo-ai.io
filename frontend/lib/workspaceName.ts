// workspaceName.ts — the active workspace's display name.
//
// Historically this was a standalone localStorage string, written during
// onboarding and read by the TopHeader tagline + sidebar identity. Now that a
// workspace IS an organization (lib/org.ts), the name belongs to the
// `organizations` row and this module is a thin read-through so those surfaces
// didn't have to change.
//
// The localStorage copy is kept purely as a first-paint cache: the org list
// resolves asynchronously, and without it the header would flash empty on
// every reload. lib/org.ts pushes the authoritative name in via
// `writeWorkspaceName` whenever the active workspace resolves or changes.

import { useEffect, useState } from "react";

const KEY = "cfoai:v1:workspace-name";
const EVENT = "cfoai:workspace-name-changed";

export function readWorkspaceName(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeWorkspaceName(name: string): void {
  try {
    if (name) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — fail soft */
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* SSR / older browsers */
  }
}

/** Reactive read of the active workspace name. Re-renders on change (this tab
 *  or another tab). Empty string when unset. */
export function useWorkspaceName(): string {
  const [name, setName] = useState<string>(readWorkspaceName);
  useEffect(() => {
    const sync = () => setName(readWorkspaceName());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return name;
}
