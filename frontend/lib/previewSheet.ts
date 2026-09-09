// previewSheet — where a generated PREVIEW document opens.
//
// Previews (example trial balances, template views, staged/uploaded file
// previews) are HTML documents the app builds at click time. In a browser
// they open in a real second tab via window.open + document.write. Inside
// the iOS/Android shell that is broken in two different ways: Android has
// multiple windows disabled, so the preview replaced the app in the same
// WebView; iOS WKWebView has no window-open handler at all, so
// `window.open("", "_blank")` navigated the WebView to about:blank AND
// returned null — the document was never written and the user saw a blank
// screen with no way back (2026-09-08 per operator).
//
// In the shell the preview is therefore rendered IN the app: a full-screen
// sheet (<PreviewSheet/>, mounted by AppShell) over the page it was opened
// from. Opening pushes one history entry, so the Android hardware back, the
// shell's native back button (the floating burger turns into a back chevron
// while a sheet is open — see AppShell's `chrome` message) and
// closePreviewSheet() all converge on history.back(), and the page
// underneath is exactly where the user left it.
//
// Browsers keep the second-tab behavior unchanged; the handle returned by
// openPreviewSheet() hides which of the two is in play.

import { isNativeShell } from "@/lib/nativeShell";

export interface PreviewSheetState {
  id: number;
  /** Shown in the sheet header (file name / template name). */
  title: string;
  /** Full HTML document to render (generated previews). */
  html: string | null;
  /** A URL to render instead (PDFs / images that preview natively). */
  url: string | null;
  /** Route the sheet was opened from — the header names that tab. */
  fromPath: string;
}

export interface PreviewHandle {
  /** Replace the preview's content with a full HTML document. */
  write(html: string): void;
  /** Point the preview at a URL (PDF/image/blob) instead of HTML. */
  navigate(url: string): void;
  close(): void;
}

const HISTORY_KEY = "cfoPreviewSheet";

let current: PreviewSheetState | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
let popInstalled = false;

function emit(): void {
  listeners.forEach((l) => l());
}

export function subscribePreviewSheet(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPreviewSheet(): PreviewSheetState | null {
  return current;
}

// Leaving the sheet's history entry (hardware back, native back button,
// closePreviewSheet) closes it. Landing back ON it (forward) is ignored —
// the content is gone by then, and a forward swipe is disabled in the
// shell anyway.
function onPopState(e: PopStateEvent): void {
  if (!current) return;
  const state = e.state as Record<string, unknown> | null;
  if (state?.[HISTORY_KEY] === current.id) return;
  current = null;
  emit();
}

function openInApp(title: string): PreviewHandle {
  const id = nextId++;
  current = {
    id,
    title,
    html: null,
    url: null,
    fromPath: window.location.pathname + window.location.search,
  };
  if (!popInstalled) {
    window.addEventListener("popstate", onPopState);
    popInstalled = true;
  }
  try {
    // Keep the router's own state fields; add ours on top.
    const base = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.pushState({ ...base, [HISTORY_KEY]: id }, "", window.location.href);
  } catch {
    /* history unavailable — the sheet still opens; close() clears directly */
  }
  emit();
  const alive = () => current?.id === id;
  return {
    write(html) {
      if (!alive()) return;
      current = { ...current!, html, url: null };
      emit();
    },
    navigate(url) {
      if (!alive()) return;
      current = { ...current!, url, html: null };
      emit();
    },
    close() {
      if (alive()) closePreviewSheet();
    },
  };
}

/** Close the open in-app sheet (no-op when none is open). */
export function closePreviewSheet(): void {
  if (!current) return;
  const state = window.history.state as Record<string, unknown> | null;
  if (state?.[HISTORY_KEY] === current.id) {
    // popstate clears `current` and notifies.
    window.history.back();
  } else {
    current = null;
    emit();
  }
}

function openInTab(): PreviewHandle | null {
  const tab = window.open("", "_blank");
  if (!tab) return null; // popup-blocked — callers already bail on null
  return {
    write(html) {
      tab.document.open();
      tab.document.write(html);
      tab.document.close();
    },
    navigate(url) {
      tab.location.href = url;
    },
    close() {
      tab.close();
    },
  };
}

/**
 * Open a preview surface synchronously (call it inside the click gesture so
 * a browser doesn't popup-block it), then fill it with write()/navigate().
 * Returns null only when a browser blocked the popup.
 */
export function openPreviewSheet(title: string): PreviewHandle | null {
  return isNativeShell() ? openInApp(title) : openInTab();
}

/** Open a URL that previews natively (PDF / image / blob). */
export function openPreviewUrl(url: string, title: string): void {
  if (isNativeShell()) {
    openInApp(title).navigate(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}
