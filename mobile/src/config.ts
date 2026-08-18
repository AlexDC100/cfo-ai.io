// ─────────────────────────────────────────────────────────────────────────────
// Native shell configuration.
//
// The mobile app is a React Native shell around the existing web app
// (https://cfo-ai.io) — every feature surface is the web app itself, rendered
// in a single WebView with native chrome (system OAuth, back handling).
// Navigation is the web app's own burger menu, opened from the floating
// burger button the web app renders top-left inside the shell.
// See mobile/README.md for the architecture notes.
// ─────────────────────────────────────────────────────────────────────────────

import Constants from "expo-constants";

const DEFAULT_WEB_APP_URL = "https://cfo-ai.io";

const extra = (Constants.expoConfig?.extra ?? {}) as { webAppUrl?: string };

/**
 * Origin the shell loads. Override per-build with EXPO_PUBLIC_WEB_APP_URL
 * (e.g. a LAN Vite dev server: EXPO_PUBLIC_WEB_APP_URL=http://192.168.1.20:5173
 * npx expo start) or via `expo.extra.webAppUrl` in app.json.
 */
export const WEB_APP_URL: string = (
  process.env.EXPO_PUBLIC_WEB_APP_URL || extra.webAppUrl || DEFAULT_WEB_APP_URL
).replace(/\/+$/, "");

/**
 * Hosts allowed to navigate INSIDE the WebView. Anything else that the user
 * taps (external articles, socials, Stripe checkout receipts opened as links,
 * mailto:) opens in the system browser instead of trapping them in the shell.
 */
export const INTERNAL_HOSTS: ReadonlySet<string> = new Set(
  [
    safeHost(WEB_APP_URL),
    "cfo-ai.io",
    "www.cfo-ai.io",
    // Supabase auth/storage links (email confirmations route through here).
    "cjclenykwlngqvapmisb.supabase.co",
  ].filter((h): h is string => !!h),
);

/**
 * OAuth redirect captured by the shell's system-browser auth session.
 * Must match `scheme` in app.json AND be allowlisted in Supabase →
 * Authentication → URL Configuration → Redirect URLs.
 */
export const OAUTH_REDIRECT = "cfoai://auth-callback";

/**
 * Web app route the shell opens on. Every surface (chat, workspace, markets,
 * settings, products, decisions…) is reachable through the web app's own
 * burger-menu navigation — the native bottom tab bar was removed 2026-08-18.
 */
export const HOME_PATH = "/dashboard";

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
