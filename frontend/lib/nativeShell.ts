// ─────────────────────────────────────────────────────────────────────────────
// Native mobile shell bridge (the mobile/ Expo app).
//
// The iOS/Android apps are a React Native shell that renders this web app in
// per-tab WebViews (see mobile/README.md). react-native-webview injects
// `window.ReactNativeWebView` into every page it hosts — its presence is the
// one reliable "are we inside the native shell?" signal. In a normal browser
// every export here is inert: isNativeShell() is false, postToNativeShell()
// no-ops, and nothing about web behavior changes.
//
// Message protocol (web → native, JSON via postMessage):
//   { source: "cfo-ai", type: "oauth", url }   — open the OAuth provider in
//     the system browser (Google rejects embedded WebViews with
//     "disallowed_useragent"; Apple discourages them too).
//   { source: "cfo-ai", type: "auth", event }  — a SIGNED_IN / SIGNED_OUT
//     transition; the shell reloads its other tabs so their supabase-js
//     instances re-read the (shared) localStorage session.
//   { source: "cfo-ai", type: "chrome", burger } — whether the shell should
//     show its NATIVE floating burger button (2026-08-18). The button is
//     native (overlaid on the WebView) so scrolling/overscroll can never
//     move it — a web-fixed button visibly drifted during fling scrolls.
//     AppShell posts true on mount, false while the drawer is open and on
//     unmount (sign-out → /login). `back: true` (2026-09-08) swaps the
//     burger for a BACK chevron while an in-app preview sheet is open
//     (lib/previewSheet.ts); tapping it dispatches action "back".
//
// Native → web:
//   · window.__cfoNativeAuthCallback(<redirect url>) with the OAuth redirect
//     it captured (cfoai://auth-callback#access_token=…), installed below via
//     installNativeAuthCallback().
//   · a `cfo:native-action` CustomEvent ({ detail: { action: "menu" | "back" } })
//     dispatched on window when the native button is tapped — AppShell
//     opens the sidebar drawer ("menu") or closes the preview sheet ("back").
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OAuth redirect the shell's system-browser auth session captures. Must match
 * the `scheme` in mobile/app.json and be allowlisted in Supabase →
 * Authentication → URL Configuration → Redirect URLs.
 */
export const NATIVE_OAUTH_REDIRECT = "cfoai://auth-callback";

/** Native → web: CustomEvent fired on window when the shell's native burger
 *  button is tapped. detail: { action: "menu" }. */
export const NATIVE_ACTION_EVENT = "cfo:native-action";

type NativeShellMessage =
  | { source: "cfo-ai"; type: "oauth"; url: string }
  | { source: "cfo-ai"; type: "auth"; event: "SIGNED_IN" | "SIGNED_OUT" }
  | { source: "cfo-ai"; type: "chrome"; burger: boolean; back?: boolean }
  // Native bottom sheets (2026-09-08, iOS): `open` asks the shell to present
  // a SwiftUI sheet hosting a second WebView on /_native/sheet/<kind>; from
  // INSIDE that sheet, `close` dismisses it and `navigate` asks the shell to
  // dismiss it and route the MAIN WebView to `path`.
  | { source: "cfo-ai"; type: "sheet"; open?: NativeSheetKind; close?: boolean; navigate?: string }
  // The web app's RESOLVED theme (2026-09-08): the shell paints its own
  // chrome (root view behind the page, WebView backdrop, status-bar icons)
  // to match, so a Paper-themed page no longer sits on black chrome.
  // `bg` (2026-09-08): the page's exact background colour (the `--bg`
  // token as an `hsl(h, s%, l%)` string RN can parse) so the shell's
  // backdrop matches to the unit — an approximated colour showed as a
  // seam where the page's top fade met the backdrop during a pull.
  // `accent` (2026-09-08): the `--brand` token, same form — the shell draws
  // the app's spotlight glow NATIVELY behind a transparent WebView so the
  // background never moves with a scroll or pull.
  // `mode` (2026-09-09): whether the theme is the user's explicit choice or
  // follows the system — the shell remembers an explicit choice so the NEXT
  // launch paints status-bar icons and chrome right before the page loads.
  // "transient" (a full-screen overlay with its own colours) is applied
  // but never remembered.
  | { source: "cfo-ai"; type: "theme"; theme: "light" | "dark"; bg?: string; accent?: string; mode?: "system" | "explicit" | "transient" };

type ShellWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void };
  __cfoNativeAuthCallback?: (redirectUrl: string) => void;
  /** Injected before any script runs (mobile/src/WebAppScreen BOOTSTRAP_JS). */
  __CFO_NATIVE_SHELL?: { platform?: string; version?: string; sheet?: string };
};

function shellWindow(): ShellWindow | null {
  return typeof window !== "undefined" ? (window as ShellWindow) : null;
}

export function isNativeShell(): boolean {
  return typeof shellWindow()?.ReactNativeWebView?.postMessage === "function";
}

export type NativeSheetKind = "account" | "notifications";

/** Which native sheet THIS WebView is rendering, or null in the main one. */
export function nativeSheetKind(): NativeSheetKind | null {
  const k = shellWindow()?.__CFO_NATIVE_SHELL?.sheet;
  return k === "account" || k === "notifications" ? k : null;
}

/** The shell can present SwiftUI sheets — iOS only. */
export function nativeSheetsSupported(): boolean {
  return isNativeShell() && shellWindow()?.__CFO_NATIVE_SHELL?.platform === "ios";
}

/** Ask the shell for a native sheet. False (do it in-page) where unsupported. */
export function openNativeSheet(kind: NativeSheetKind): boolean {
  if (!nativeSheetsSupported()) return false;
  postToNativeShell({ source: "cfo-ai", type: "sheet", open: kind });
  return true;
}

export function closeNativeSheet(): void {
  postToNativeShell({ source: "cfo-ai", type: "sheet", close: true });
}

/** The native app's version (mobile/app.json `expo.version`), or null
 *  outside the shell / on a shell build that predates the field. */
export function nativeShellVersion(): string | null {
  const v = shellWindow()?.__CFO_NATIVE_SHELL?.version;
  return typeof v === "string" && v ? v : null;
}

export function postToNativeShell(message: NativeShellMessage): void {
  const w = shellWindow();
  if (!w?.ReactNativeWebView) return;
  try {
    w.ReactNativeWebView.postMessage(JSON.stringify(message));
  } catch {
    /* shell torn down mid-navigation — nothing to do */
  }
}

/**
 * Register the handler the shell invokes with the captured OAuth redirect.
 * Returns an uninstaller (safe to call in a React effect cleanup).
 */
export function installNativeAuthCallback(
  handler: (redirectUrl: string) => void,
): () => void {
  const w = shellWindow();
  if (!w || !isNativeShell()) return () => {};
  w.__cfoNativeAuthCallback = handler;
  return () => {
    if (w.__cfoNativeAuthCallback === handler) delete w.__cfoNativeAuthCallback;
  };
}
