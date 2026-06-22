// useDocsPanelOpen — shared open/close state for the Documents slide-out.
//
// Persisted to localStorage so the panel state survives reload AND so
// every consumer (the header pill + the panel itself) reads the same
// flag without prop-drilling. Keyboard shortcut (Cmd/Ctrl+D) is wired
// once in the hook and toggles the same store.
//
// Per the spec: per-device, not per-user — the user's preference on
// their laptop may differ from their iPad. localStorage is the right
// place; the DB would be cross-device-weird.

import { useCallback, useEffect, useSyncExternalStore } from "react";

const STORAGE_KEY = "cfoai.docs_panel.open";
const EVENT = "cfoai-docs-panel-changed";

function read(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function write(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* quota */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: open }));
}

function subscribe(cb: () => void): () => void {
  const onChange = () => cb();
  window.addEventListener(EVENT, onChange);
  // Sync across tabs via the storage event too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useDocsPanelOpen(): [boolean, (next: boolean) => void] {
  const open = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => write(next), []);

  // Cmd/Ctrl+D toggles. Wired once at the hook level; multiple consumers
  // each install a listener but they all call the same setter — idempotent.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        write(!read());
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return [open, set];
}
