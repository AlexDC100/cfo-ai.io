// The shell's one screen: the web app rendered in a WebView with native
// affordances layered on — Android hardware back, external links to the
// system browser, OAuth in a system auth session (Google rejects embedded
// WebViews), offline/error recovery, and a first-load spinner.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActionSheetIOS, Alert, AppState } from "react-native";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { Button as UiButton, Host, Image as UiImage, Menu, Section } from "@expo/ui/swift-ui";
import { buttonStyle, foregroundColor, frame, glassEffect } from "@expo/ui/swift-ui/modifiers";
import {
  BackHandler,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
  StatusBar as RNStatusBar,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import NetInfo from "@react-native-community/netinfo";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import { WebView } from "react-native-webview";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from "react-native-svg";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  ShouldStartLoadRequest,
  WebViewMessageEvent,
} from "react-native-webview/lib/WebViewTypes";

import { INTERNAL_HOSTS, OAUTH_REDIRECT, WEB_APP_URL } from "./config";
import { BRAND, PAPER_BG, TERMINAL_BG, palette } from "./theme";
import { registerWebView, reloadOtherWebViews } from "./webviewRegistry";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { NativeSheet, type NativeSheetKind } from "./NativeSheet";
import { NativeComposer, type NativeComposerState } from "./NativeComposer";
import { AppLoader } from "./AppLoader";
import * as DocumentPicker from "expo-document-picker";
import { enforceKeyboardInsets } from "../modules/keyboard-insets";

// Runs before the page's own scripts. `window.ReactNativeWebView` (injected by
// react-native-webview) is what frontend/lib/nativeShell.ts detects; this flag
// is a secondary, earlier-available marker.
// `version` (app.json expo.version) is what the web app's drawer shows under
// the app name inside the shell (2026-09-08).
// Liquid Glass is compiled in only on iOS 26 builds; checked once.
const LIQUID_GLASS = isLiquidGlassAvailable();

/** Lightness < 50% → a dark surface (hsl(h, s%, l%) or #rrggbb). */
const SHELL_THEME_KEY = "cfo:shell-theme:v1";
type StoredTheme = { theme: "light" | "dark"; bg: string | null; accent: string | null };

function isDarkColor(color: string): boolean {
  const hsl = /hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*([\d.]+)%/.exec(color);
  if (hsl) return parseFloat(hsl[1]) < 50;
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    const l = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return l < 0.5;
  }
  return false;
}

// Local notifications (2026-09-10): shown as a banner with sound. They are
// only ever scheduled while the app is in the background (see "notify").
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/** Left-edge strip width and the rightward travel that opens the drawer. */
const EDGE_SWIPE_WIDTH = 22;
const EDGE_SWIPE_TRIGGER = 36;

const BOOTSTRAP_JS = `window.__CFO_NATIVE_SHELL = { platform: ${JSON.stringify(
  Platform.OS,
)}, version: ${JSON.stringify(Constants.expoConfig?.version ?? "")} }; true;`;

type ShellMessage =
  | { source: "cfo-ai"; type: "oauth"; url: string }
  | { source: "cfo-ai"; type: "auth"; event: "SIGNED_IN" | "SIGNED_OUT" }
  // Whether the NATIVE floating burger should show — true while the web
  // app's AppShell is mounted with its drawer closed. Native because a
  // web-fixed button drifts during fling scrolls/overscroll (2026-08-18).
  // `back: true` (2026-09-08): an in-app preview sheet is open — show a
  // BACK chevron in the same spot instead; a tap dispatches action "back".
  | { source: "cfo-ai"; type: "chrome"; burger: boolean; back?: boolean; trash?: boolean; chatTitle?: string }
  // Haptics and background-answer notifications (2026-09-10 per operator).
  | { source: "cfo-ai"; type: "haptic"; kind: "light" | "medium" | "selection" }
  | { source: "cfo-ai"; type: "notify"; title: string; body: string }
  | { source: "cfo-ai"; type: "notify-permission" }
  // Native bottom sheet request (2026-09-08, iOS): present the account /
  // notifications page in a SwiftUI sheet (src/NativeSheet.tsx).
  | { source: "cfo-ai"; type: "sheet"; open?: NativeSheetKind; close?: boolean }
  // The web app's resolved theme — the shell's chrome follows it (2026-09-08).
  | { source: "cfo-ai"; type: "theme"; theme: "light" | "dark"; bg?: string; accent?: string; mode?: "system" | "explicit" }
  // The chat composer, drawn natively (2026-09-10): the page hides its own
  // input in the shell and drives src/NativeComposer.tsx with this.
  | ({ source: "cfo-ai"; type: "composer" } & NativeComposerState)
  // Native dialogs (2026-09-10): a real UIAlertController — action sheet or
  // alert — answered with action "dialog" { id, index } (-1 = dismissed).
  | {
      source: "cfo-ai";
      type: "dialog";
      id: string;
      kind: "actionSheet" | "alert" | "prompt";
      defaultValue?: string;
      title?: string;
      message?: string;
      options: string[];
      destructiveIndex?: number;
      cancelIndex?: number;
    };

type Props = {
  /** Stable key in the webviewRegistry (the tab name). */
  tabKey: string;
  /** Web app route this tab opens on, e.g. "/dashboard". */
  path: string;
};

export function WebAppScreen({ tabKey, path }: Props) {
  // The web app reports its resolved theme (`theme` message); until it does
  // — first paint, /login before the app shell mounts — follow the system.
  const systemScheme = useColorScheme();
  const [webTheme, setWebTheme] = useState<"light" | "dark" | null>(null);
  // The page's exact background colour, reported with the theme — the
  // backdrop must match it to the unit or the page's top fade shows a
  // seam against it during a pull (2026-09-08 per operator).
  const [webBg, setWebBg] = useState<string | null>(null);
  // The app's accent (`--brand`), for the native spotlight glow.
  const [webAccent, setWebAccent] = useState<string | null>(null);
  // First launch paints BEFORE the page can report (2026-09-09 per
  // operator: status-bar icons were wrong until the app loaded). An
  // explicit theme choice is remembered natively and applied at mount;
  // a "follow the system" choice stores nothing, so the system wins.
  const themeReportedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(SHELL_THEME_KEY)
      .then((raw) => {
        if (cancelled || themeReportedRef.current || !raw) return;
        try {
          const s = JSON.parse(raw) as Partial<StoredTheme>;
          if (s.theme !== "light" && s.theme !== "dark") return;
          setWebTheme(s.theme);
          setWebBg(typeof s.bg === "string" ? s.bg : null);
          setWebAccent(typeof s.accent === "string" ? s.accent : null);
        } catch {
          /* corrupt entry — follow the system */
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const scheme = webTheme ?? systemScheme;
  const p = palette(scheme);
  // Root colour behind the page (status-bar strip, keyboard gap, overscroll).
  // Until the page reports: the web canvas tokens (paper / green-black).
  const chromeBg = webBg ?? (scheme === "dark" ? TERMINAL_BG : PAPER_BG);
  const accent = webAccent ?? (scheme === "dark" ? BRAND : "#0E7C6B");
  // Status-bar icons contrast with the ACTUAL chrome colour (2026-09-08
  // per operator: white on Terminal, dark on Paper). Derived from the
  // reported canvas colour's lightness rather than the theme name, and
  // also pushed imperatively — the declarative <StatusBar> alone was seen
  // lagging behind theme changes on iOS.
  const statusStyle: "light" | "dark" = isDarkColor(chromeBg) ? "light" : "dark";
  useEffect(() => {
    RNStatusBar.setBarStyle(statusStyle === "light" ? "light-content" : "dark-content", true);
  }, [statusStyle]);
  // Absolute children anchor to the SafeAreaView's BOX, not its padding —
  // the burger needs the status-bar inset added explicitly.
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const canGoBackRef = useRef(false);
  const oauthInFlightRef = useRef(false);
  const [firstLoadDone, setFirstLoadDone] = useState(false);
  // Boot the native sheet pages a moment after the main page is up, so
  // they never compete with it for the network and present instantly.
  const [warmSheets, setWarmSheets] = useState(false);
  useEffect(() => {
    if (!firstLoadDone || warmSheets) return;
    const t = setTimeout(() => setWarmSheets(true), 1500);
    return () => clearTimeout(t);
  }, [firstLoadDone, warmSheets]);
  const [failed, setFailed] = useState(false);
  const failedRef = useRef(false);
  failedRef.current = failed;
  // Native floating button — driven by the web app's `chrome` messages:
  // "menu" (burger) while the app shell is mounted, "back" while an in-app
  // preview sheet is open, "none" on pages without the shell (login,
  // landing) and while the drawer is open.
  const [chrome, setChrome] = useState<"none" | "menu" | "back">("none");
  // Second disc, top-right (2026-09-10 per operator): delete the open chat.
  // Requested by the page with the burger; a tap dispatches "delete".
  const [trash, setTrash] = useState(false);
  // The open chat's title — the header of the disc's native menu.
  const [chatTitle, setChatTitle] = useState("");
  // Native composer state, as last reported by the chat page.
  const [composer, setComposer] = useState<NativeComposerState>({ show: false });
  // Native bottom sheet currently presented (iOS only).
  const [sheet, setSheet] = useState<NativeSheetKind | null>(null);
  // Edge-swipe tracking (see the strip below).
  const edgeStartRef = useRef(0);
  const edgeFiredRef = useRef(false);

  // Expose this tab's WebView for cross-tab auth reloads / deep-link forwards.
  useEffect(
    () =>
      registerWebView(tabKey, {
        reload: () => webRef.current?.reload(),
        injectJavaScript: (js) => webRef.current?.injectJavaScript(js),
      }),
    [tabKey],
  );

  // Auto-retry a failed load as soon as connectivity returns.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && failedRef.current) {
        setFailed(false);
        webRef.current?.reload();
      }
    });
    return unsubscribe;
  }, []);

  // Android hardware back walks the WebView history before leaving the app.
  // Plain useEffect (not react-navigation's useFocusEffect): the shell has a
  // single always-focused screen since the bottom tab bar was removed.
  useEffect(() => {
    if (Platform.OS !== "android") return undefined;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBackRef.current) {
        webRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  const handleShouldStart = useCallback((req: ShouldStartLoadRequest) => {
    // iOS reports subframe/resource loads too — only police top-frame navigation.
    if (req.isTopFrame === false) return true;
    const { url } = req;
    if (
      url.startsWith("about:") ||
      url.startsWith("data:") ||
      url.startsWith("blob:") ||
      url.startsWith("javascript:")
    ) {
      return true;
    }
    if (url.startsWith(OAUTH_REDIRECT)) return false; // handled by the auth session
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return true;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (INTERNAL_HOSTS.has(parsed.host)) return true;
      void WebBrowser.openBrowserAsync(url).catch(() =>
        Linking.openURL(url).catch(() => {}),
      );
      return false;
    }
    // mailto:, tel:, other app schemes → hand to the OS.
    void Linking.openURL(url).catch(() => {});
    return false;
  }, []);

  // OAuth: the web app sends the provider URL (frontend/lib/auth.tsx posts it
  // when running in the shell); open it in a system auth session and hand the
  // captured cfoai://auth-callback redirect back to the page to finish login.
  const handleNativeOAuth = useCallback(async (url: string) => {
    if (oauthInFlightRef.current) return;
    oauthInFlightRef.current = true;
    try {
      const result = await WebBrowser.openAuthSessionAsync(url, OAUTH_REDIRECT);
      if (result.type === "success" && result.url) {
        webRef.current?.injectJavaScript(
          `window.__cfoNativeAuthCallback && window.__cfoNativeAuthCallback(${JSON.stringify(
            result.url,
          )}); true;`,
        );
      }
    } finally {
      oauthInFlightRef.current = false;
    }
  }, []);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: ShellMessage;
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (message?.source !== "cfo-ai") return;
      if (message.type === "oauth" && typeof message.url === "string") {
        void handleNativeOAuth(message.url);
      } else if (message.type === "auth") {
        // Session changed in this tab — others reread localStorage on reload.
        // SIGNED_OUT only (2026-09-08): supabase-js also emits SIGNED_IN
        // while recovering the stored session on every boot, and the only
        // other WebView today is a native sheet — reloading it on every
        // main-page boot made the two ping-pong.
        if (message.event === "SIGNED_OUT") reloadOtherWebViews(tabKey);
      } else if (message.type === "chrome") {
        setChrome(message.back === true ? "back" : message.burger === true ? "menu" : "none");
        setTrash(message.trash === true && message.burger === true);
        setChatTitle(message.chatTitle ?? "");
      } else if (message.type === "haptic") {
        if (message.kind === "selection") void Haptics.selectionAsync();
        else void Haptics.impactAsync(message.kind === "medium" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
      } else if (message.type === "notify-permission") {
        void Notifications.requestPermissionsAsync().catch(() => {});
      } else if (message.type === "notify") {
        // Only while the app is NOT in the foreground — in the foreground
        // the answer is already on screen.
        if (AppState.currentState !== "active") {
          void Notifications.scheduleNotificationAsync({ content: { title: message.title, body: message.body }, trigger: null }).catch(() => {});
        }
      } else if (message.type === "composer") {
        const { source: _s, type: _t, ...rest } = message;
        setComposer(rest);
      } else if (message.type === "dialog") {
        const reply = (index: number, text?: string) =>
          webRef.current?.injectJavaScript(
            'window.dispatchEvent(new CustomEvent("cfo:native-action",' +
              `{ detail: { action: "dialog", id: ${JSON.stringify(message.id)}, index: ${index}, text: ${JSON.stringify(text ?? null)} } })); true;`,
          );
        const style = scheme === "dark" ? "dark" : "light";
        if (message.kind === "prompt") {
          // Native text-input alert: options = [cancel, confirm].
          Alert.prompt(
            message.title ?? "",
            message.message,
            [
              { text: message.options[0], style: "cancel", onPress: () => reply(-1) },
              { text: message.options[1], onPress: (text?: string) => reply(1, text ?? "") },
            ],
            "plain-text",
            message.defaultValue,
            undefined,
            { userInterfaceStyle: style },
          );
        } else if (message.kind === "actionSheet" && Platform.OS === "ios") {
          ActionSheetIOS.showActionSheetWithOptions(
            {
              title: message.title,
              message: message.message,
              options: message.options,
              destructiveButtonIndex: message.destructiveIndex,
              cancelButtonIndex: message.cancelIndex,
              userInterfaceStyle: style,
            },
            (index) => reply(index),
          );
        } else {
          Alert.alert(
            message.title ?? "",
            message.message,
            message.options.map((text, i) => ({
              text,
              style: i === message.destructiveIndex ? "destructive" : i === message.cancelIndex ? "cancel" : "default",
              onPress: () => reply(i),
            })),
            { cancelable: true, onDismiss: () => reply(message.cancelIndex ?? -1), userInterfaceStyle: style },
          );
        }
      } else if (message.type === "sheet") {
        if (message.open === "account" || message.open === "notifications") setSheet(message.open);
        else if (message.close) setSheet(null);
      } else if (message.type === "theme") {
        themeReportedRef.current = true;
        const bg = typeof message.bg === "string" && message.bg ? message.bg : null;
        const accent = typeof message.accent === "string" && message.accent ? message.accent : null;
        if (message.theme === "light" || message.theme === "dark") setWebTheme(message.theme);
        setWebBg(bg);
        setWebAccent(accent);
        if (message.theme === "light" || message.theme === "dark") {
          const stored: StoredTheme = { theme: message.theme, bg, accent };
          void (message.mode === "system"
            ? AsyncStorage.removeItem(SHELL_THEME_KEY)
            : AsyncStorage.setItem(SHELL_THEME_KEY, JSON.stringify(stored))
          ).catch(() => {});
        }
      }
    },
    [handleNativeOAuth, tabKey],
  );

  // Button tap → `cfo:native-action` CustomEvent; AppShell opens the drawer
  // ("menu") or closes the preview sheet ("back").
  const dispatchAction = useCallback((action: string, payload: Record<string, unknown> = {}) => {
    webRef.current?.injectJavaScript(
      'window.dispatchEvent(new CustomEvent("cfo:native-action",' +
        `{ detail: ${JSON.stringify({ action, ...payload })} })); true;`,
    );
  }, []);

  return (
    // Root colour follows the web app's REPORTED theme (2026-09-08 per
    // operator: a Paper-themed page was sitting on black chrome). Dark stays
    // pure black (2026-08-18: the tinted dark canvas read green in the
    // status-bar strip).
    // No top safe-area edge (2026-09-08 per operator): the page renders
    // edge-to-edge under the status bar, like a native screen. The web app
    // sees the inset as env(safe-area-inset-top) (viewport-fit=cover) where
    // it needs it (drawer, chat panel); the native burger/back button keeps
    // its own inset offset below.
    <SafeAreaView edges={[]} style={[styles.root, { backgroundColor: chromeBg }]}>
      {/* Status-bar icons contrast with the chrome colour. */}
      <StatusBar style={statusStyle} animated />
      {/* The app's spotlight background, drawn NATIVELY under a transparent
          WebView (2026-09-08 per operator): the same soft brand glow the
          web app paints top-left (a 288px blurred disc at -48,-48 →
          centre 96,96), so the whole app shares one background that a
          scroll or pull can never move. */}
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="spot" cx="96" cy="96" r="230" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={accent} stopOpacity={0.1} />
            <Stop offset="1" stopColor={accent} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx="96" cy="96" r="230" fill="url(#spot)" />
      </Svg>
      {/* iOS: shrink the WebView above the keyboard (2026-09-08 per
          operator) so the web app's `position: fixed; bottom: 0` chat
          composer sits exactly on top of it and stays there while the
          conversation scrolls — the hybrid-app "native resize" model
          (Capacitor's default). This is keyboard-controller's
          KeyboardAvoidingView (2026-09-09): the padding follows the
          keyboard's own animation natively, so the WebView's bottom edge
          and the keyboard's top edge move as one; React Native's built-in
          one scheduled the resize from JS and visibly lagged. WKWebView's
          own keyboard inset is cancelled by modules/keyboard-insets.
          Android resizes the window itself (softwareKeyboardLayoutMode
          "resize" default). */}
      <KeyboardAvoidingView
        style={styles.keyboardHost}
        behavior="padding"
        enabled={Platform.OS === "ios"}
      >
        {/* Everything the keyboard pushes up lives in this view: the
            padding the avoiding view animates shrinks it, so the native
            composer pinned to ITS bottom edge rides on the keyboard. */}
        <View style={styles.keyboardHost}>
        <WebView
          ref={webRef}
          source={{ uri: `${WEB_APP_URL}${path}` }}
          // Transparent so the native spotlight behind it shows through (the
          // page paints no background of its own in the shell).
          style={{ flex: 1, backgroundColor: "transparent" }}
          applicationNameForUserAgent="CFOAIApp/1.0"
          injectedJavaScriptBeforeContentLoaded={BOOTSTRAP_JS}
          onMessage={handleMessage}
          onShouldStartLoadWithRequest={handleShouldStart}
          onNavigationStateChange={(nav) => {
            canGoBackRef.current = nav.canGoBack;
          }}
          // Full page (re)load — hide the burger until the new page's AppShell
          // reports chrome again (a reload into /login must not keep it).
          onLoadStart={() => { setChrome("none"); setTrash(false); setComposer({ show: false }); }}
          onLoadEnd={() => {
            setFirstLoadDone(true);
            // WKWebView must not add its own keyboard inset on top of the
            // KeyboardAvoidingView shrink (modules/keyboard-insets).
            enforceKeyboardInsets();
          }}
          // No "< > Done" bar over the keyboard (2026-09-09 per operator).
          hideKeyboardAccessoryView
          // No link preview on a held link (2026-09-10 per operator: only
          // chat items react to a hold).
          allowsLinkPreview={false}
          onError={() => setFailed(true)}
          // iOS can't render in-page downloads (report exports) — system browser.
          onFileDownload={({ nativeEvent }) => {
            void WebBrowser.openBrowserAsync(nativeEvent.downloadUrl).catch(() => {});
          }}
          domStorageEnabled
          sharedCookiesEnabled
          // No iOS edge-swipe back/forward (2026-09-06 per operator): the web
          // app's burger-menu tabs are history entries, so a left-edge swipe on
          // /chat silently "navigated" to the previous tab. Android's hardware
          // back (above) still walks history deliberately.
          allowsBackForwardNavigationGestures={false}
          // Swipe-down refresh on every tab (2026-09-08 per operator) — needs
          // the iOS bounce. The page paints NO background of its own inside
          // the shell (index.css `html.native-shell`), so the bounce moves
          // only the content over this WebView's theme-coloured backdrop;
          // the background itself stays fixed. Android keeps its glow off.
          overScrollMode="never"
          // No zoom in the app (2026-09-08 per operator) — Android's WebView
          // zoom controls/pinch; iOS is handled by the page (viewport meta +
          // touch-action, see frontend/main.tsx).
          setBuiltInZoomControls={false}
          scalesPageToFit={false}
          refreshControlLightMode={scheme === "dark"}
          setSupportMultipleWindows={false}
          allowsInlineMediaPlayback
        />
        {/* The chat composer in Liquid Glass (2026-09-10 per operator) —
            inside the KeyboardAvoidingView so it rides the keyboard with
            the WebView's bottom edge. Being native it always draws over
            the page, so it steps aside whenever the page has something
            over its content — the open drawer, a preview sheet, the
            onboarding — which the page reports by taking the burger away
            (its text survives; the component stays mounted). */}
        <NativeComposer
          state={chrome === "menu" ? composer : { ...composer, show: false }}
          scheme={scheme}
          palette={p}
          accent={accent}
          bottomInset={insets.bottom}
          onSubmit={(text) => dispatchAction("composer-submit", { text })}
          onStop={() => dispatchAction("composer-stop")}
          onDraft={(text) => dispatchAction("composer-draft", { text })}
          onScroll={() => dispatchAction("composer-scroll")}
          onAttach={() => {
            // Native document picker; the page adds the pick to the
            // composer's attachment chips (its attachments are UI-only).
            void DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: false })
              .then((res) => {
                const a = res.canceled ? null : res.assets?.[0];
                if (a) dispatchAction("composer-attach", { name: a.name, size: a.size ?? 0, type: a.mimeType ?? "application/octet-stream" });
              })
              .catch(() => {});
          }}
          onHeight={(height) => dispatchAction("composer-height", { height })}
        />
        </View>
      </KeyboardAvoidingView>

      {/* NATIVE floating button — overlays the WebView top-left, so web
          scrolling/overscroll can never move it. Burger while the web app
          reports its shell is mounted (drawer closed); a BACK chevron while
          an in-app preview sheet is open (2026-09-08 per operator). */}
      {chrome !== "none" && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={chrome === "back" ? "Back" : "Open navigation menu"}
          onPress={() => dispatchAction(chrome)}
          style={[styles.burgerHit, { top: insets.top + 6 }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          activeOpacity={0.85}
        >
          {/* iOS 26 Liquid Glass (expo-glass-effect, 2026-09-08 per
              operator); GlassView falls back to a plain View elsewhere, so
              the tinted-glass styling below covers older iOS and Android. */}
          <GlassView
            glassEffectStyle="regular"
            isInteractive
            colorScheme={scheme === "dark" ? "dark" : "light"}
            style={[
              styles.burger,
              !LIQUID_GLASS && {
                backgroundColor: scheme === "dark" ? "rgba(16, 24, 22, 0.85)" : "rgba(249, 249, 245, 0.88)",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: p.border,
              },
            ]}
          >
            {chrome === "back" ? (
              <View style={[styles.chevron, { borderColor: p.text }]} />
            ) : (
              <>
                <View style={[styles.burgerBar, { backgroundColor: p.text }]} />
                <View style={[styles.burgerBar, { backgroundColor: p.text }]} />
                <View style={[styles.burgerBar, { backgroundColor: p.text }]} />
              </>
            )}
          </GlassView>
        </TouchableOpacity>
      )}
      {/* Chat-options "…" — a NATIVE SwiftUI Menu (2026-09-10 per operator:
          "use the native iOS feature"), top-RIGHT while the web chat page
          has a conversation open: the chat's title as the header, Rename and
          Delete chat as items. Its label is the same 44 pt Liquid Glass disc
          as the burger. Items reach the page as actions "chat-rename" /
          "chat-delete". */}
      {chrome === "menu" && trash && Platform.OS === "ios" && (
        <Host style={[styles.trashHit, { top: insets.top + 6 }]} matchContents>
          <Menu
            label={
              <UiImage
                systemName="ellipsis"
                modifiers={[
                  frame({ width: 44, height: 44 }),
                  glassEffect({ glass: { variant: "regular", interactive: true }, shape: "circle" }),
                  foregroundColor(p.text),
                ]}
              />
            }
            modifiers={[buttonStyle("plain")]}
          >
            <Section title={chatTitle || undefined}>
              <UiButton label="Rename" systemImage="pencil" onPress={() => dispatchAction("chat-rename")} />
              <UiButton label="Delete chat" systemImage="trash" role="destructive" onPress={() => dispatchAction("chat-delete")} />
            </Section>
          </Menu>
        </Host>
      )}

      {/* First-load cover: the page's own loader, drawn natively, on the
          page's own canvas colour — so when the page paints its loader
          underneath and this lifts, nothing visibly changes. */}
      {!firstLoadDone && !failed && (
        <View style={[styles.overlay, { backgroundColor: chromeBg }]}>
          <AppLoader palette={p} accent={accent} />
        </View>
      )}

      {failed && (
        <View style={[styles.overlay, { backgroundColor: p.background }]}>
          <Text style={[styles.errorTitle, { color: p.text }]}>
            Can't reach CFO AI
          </Text>
          <Text style={[styles.errorBody, { color: p.textMute }]}>
            Check your connection — the app retries automatically when you're
            back online.
          </Text>
          <TouchableOpacity
            style={[styles.retryButton, { borderColor: p.border }]}
            onPress={() => {
              setFailed(false);
              webRef.current?.reload();
            }}
          >
            <Text style={[styles.retryLabel, { color: p.tabActive }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
      {/* Edge swipe → open the drawer (2026-09-08 per operator): a thin
          strip along the left edge takes the touch and, once it has moved
          right far enough, dispatches the same "menu" action as the burger.
          Only while the burger is showing (the drawer is closed and the
          app shell is mounted). The WebView's own edge gesture is off. */}
      {chrome === "menu" && (
        <View
          // Starts below the burger so the button's left edge stays tappable.
          style={[styles.edgeSwipe, { top: insets.top + 64 }]}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(e) => {
            edgeStartRef.current = e.nativeEvent.pageX;
            edgeFiredRef.current = false;
          }}
          onResponderMove={(e) => {
            if (edgeFiredRef.current) return;
            if (e.nativeEvent.pageX - edgeStartRef.current > EDGE_SWIPE_TRIGGER) {
              edgeFiredRef.current = true;
              dispatchAction("menu");
            }
          }}
          onResponderRelease={() => {
            edgeFiredRef.current = false;
          }}
        />
      )}
      {Platform.OS === "ios" && (
        <NativeSheet
          kind={sheet}
          warm={warmSheets}
          fallbackBg={chromeBg}
          onClose={() => setSheet(null)}
          onNavigate={(path) => {
            setSheet(null);
            webRef.current?.injectJavaScript(
              `window.dispatchEvent(new CustomEvent("cfo:native-action", { detail: { action: "navigate", path: ${JSON.stringify(
                path,
              )} } })); true;`,
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  edgeSwipe: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: EDGE_SWIPE_WIDTH,
    zIndex: 5,
  },
  // backgroundColor is set inline from the web app's theme.
  root: { flex: 1 },
  keyboardHost: { flex: 1 },
  // Mirrors the web app's dark glass chrome (surface #101816 / border
  // #1E2A26 / ink #E8F1EE) — the app is dark-only, so these are static.
  // Positioning of the floating button (`top` is set inline: safe-area
  // inset + 2). The look lives on the GlassView inside it.
  // 44pt discs (2026-09-10 per operator: a little smaller than 52).
  burgerHit: {
    position: "absolute",
    left: 12,
    height: 44,
    width: 44,
  },
  trashHit: {
    position: "absolute",
    right: 12,
    height: 44,
    width: 44,
  },
  // The Liquid Glass disc: no background/border of its own on iOS 26 (the
  // glass IS the surface); the fallback tint/border is applied inline.
  burger: {
    height: 44,
    width: 44,
    borderRadius: 22,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  // Back chevron: a square showing only its left+bottom edges, rotated 45°.
  chevron: {
    width: 10,
    height: 10,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: "#E8F1EE",
    transform: [{ rotate: "45deg" }],
    marginLeft: 4,
  },
  burgerBar: {
    width: 16,
    height: 2,
    borderRadius: 1,
    backgroundColor: "#E8F1EE",
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: { fontSize: 18, fontWeight: "700", marginBottom: 8 },
  errorBody: { fontSize: 14, textAlign: "center", marginBottom: 20 },
  retryButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryLabel: { fontSize: 15, fontWeight: "600" },
});
