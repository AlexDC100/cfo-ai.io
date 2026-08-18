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
//     unmount (sign-out → /login).
//
// Native → web:
//   · window.__cfoNativeAuthCallback(<redirect url>) with the OAuth redirect
//     it captured (cfoai://auth-callback#access_token=…), installed below via
//     installNativeAuthCallback().
//   · a `cfo:native-action` CustomEvent ({ detail: { action: "menu" } })
//     dispatched on window when the native burger is tapped — AppShell
//     listens and opens the sidebar drawer.
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
  | { source: "cfo-ai"; type: "chrome"; burger: boolean };

type ShellWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void };
  __cfoNativeAuthCallback?: (redirectUrl: string) => void;
};

function shellWindow(): ShellWindow | null {
  return typeof window !== "undefined" ? (window as ShellWindow) : null;
}

export function isNativeShell(): boolean {
  return typeof shellWindow()?.ReactNativeWebView?.postMessage === "function";
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
