// workspaceName.ts — the user-chosen workspace name (set in the Workspace
// onboarding). Stored in localStorage and exposed as a tiny reactive hook so
// surfaces like the TopHeader tagline update the instant it changes (same tab
// via a custom event, other tabs via the native `storage` event) without a
// page reload.

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

/** Reactive read of the workspace name. Re-renders on change (this tab or
 *  another tab). Empty string when unset. */
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
