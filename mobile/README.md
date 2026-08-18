# CFO AI — iOS & Android app (`mobile/`)

React Native (Expo SDK 57) **hybrid shell**: native OAuth, native back/offline
handling — and every feature surface is the existing web app
(`https://cfo-ai.io`) rendered in a single WebView. Navigation is the web
app's own burger menu (the native bottom tab bar was removed 2026-08-18).
Feature parity with the website is by construction: whatever ships on the web
ships here, with zero mobile release needed. Individual surfaces can be
rewritten as fully native screens later.

This package is self-contained (own `package.json` / `node_modules`); it does
not touch the web build at the repo root.

## Architecture

```
App.tsx                    single WebAppScreen (no native tab bar)
src/WebAppScreen.tsx       one WebView into the web app, plus:
                           · Android hardware back → WebView history
                           · external links → system browser
                           · OAuth → system auth session (see below)
                           · offline detection + auto-retry, first-load spinner
                           · iOS file downloads → system browser
src/config.ts              WEB_APP_URL, internal-host allowlist, HOME_PATH
src/webviewRegistry.ts     WebView registry (auth reloads, deep-link forwards)
src/theme.ts               shell chrome colors mirroring the web design tokens
```

## Navigation inside the shell

Inside the shell the web app hides its entire TopHeader; the one piece of
native chrome is a floating burger button pinned top-left, rendered by
`WebAppScreen` (native so web scrolling/overscroll can never move it). The
web app's AppShell drives its visibility via `{ type: "chrome", burger }`
messages (off on login/landing and while the drawer is open); a tap injects
a `cfo:native-action` CustomEvent, which AppShell maps to opening the
sidebar drawer — month stepper, currency toggle, nav groups and the account
row. Everything else (imports, new chat, …) uses each page's own in-page
buttons.

Web-side counterpart: `frontend/lib/nativeShell.ts` (+ guarded branches in
`frontend/lib/auth.tsx`). All of it is inert in a normal browser — detection is
`window.ReactNativeWebView`, which only exists inside the shell.

## OAuth (Google / Apple)

Google **blocks** sign-in inside embedded WebViews (`disallowed_useragent`), so
the shell runs OAuth in the system browser:

1. Web app (in shell) calls `signInWithOAuth` → gets the provider URL with
   `skipBrowserRedirect: true` and `redirectTo: cfoai://auth-callback`, posts
   it to the shell.
2. Shell opens it via `WebBrowser.openAuthSessionAsync`, captures the
   `cfoai://auth-callback#access_token=…` redirect.
3. Shell injects the redirect back into the page; `auth.tsx` completes the
   session (`setSession` / `exchangeCodeForSession`).

**One-time setup required:** add `cfoai://auth-callback` under Supabase →
Authentication → URL Configuration → **Redirect URLs**. Until then, Google and
Apple login in the app will bounce back to the login screen (email/password is
unaffected).

## Run it

```bash
cd mobile
npm install
npx expo start          # scan the QR with Expo Go (iOS/Android)
```

Point at a local web build instead of prod (device and PC on the same LAN):

```bash
EXPO_PUBLIC_WEB_APP_URL=http://192.168.1.20:5173 npx expo start
```

Note for Android + plain-HTTP dev servers: release builds block cleartext
traffic. Expo Go allows it; for a dev build add `expo-build-properties` with
`android.usesCleartextTraffic: true`, or just test against `https://cfo-ai.io`.

## Store builds (EAS)

```bash
npm i -g eas-cli
eas login
eas build:configure
eas build --platform ios       # App Store / TestFlight
eas build --platform android   # Play Store (AAB)
```

Bundle ids are set in `app.json` (`io.cfoai.app` for both platforms). Replace
the placeholder icons/splash in `assets/` with CFO AI branding before
submitting.

## Known limitations (acceptable for v1)

- **In-page blob downloads** (HTML report export) may not save on iOS; the
  shell falls back to opening download URLs in the system browser. Direct-URL
  downloads work.
- **Cold-start OAuth deep links** aren't replayed — if the app is killed
  mid-login, the user just signs in again.
