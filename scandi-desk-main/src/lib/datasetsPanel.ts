// useDatasetsPanelOpen — open/close state for the Products /
// sales-datasets slide-out. Same pattern as useDocsPanelOpen but
// scoped to a different localStorage key and a different keyboard
// shortcut (Cmd/Ctrl+Shift+D) so the two panels don't collide on
// the same chord.

import { useCallback, useEffect, useSyncExternalStore } from "react";

const STORAGE_KEY = "cfoai.datasets_panel.open";
const EVENT = "cfoai-datasets-panel-changed";

function read(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
}
function write(open: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, open ? "1" : "0"); } catch { /* quota */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: open }));
}
function subscribe(cb: () => void): () => void {
  const onChange = () => cb();
  window.addEventListener(EVENT, onChange);
  const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) cb(); };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useDatasetsPanelOpen(): [boolean, (next: boolean) => void] {
  const open = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => write(next), []);

  // Cmd/Ctrl+Shift+D — distinct from the Docs panel's Cmd+D so users
  // can have one open without flipping the other.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        write(!read());
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return [open, set];
}
