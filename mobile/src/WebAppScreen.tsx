// The shell's one screen: the web app rendered in a WebView with native
// affordances layered on — Android hardware back, external links to the
// system browser, OAuth in a system auth session (Google rejects embedded
// WebViews), offline/error recovery, and a first-load spinner.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import NetInfo from "@react-native-community/netinfo";
import * as WebBrowser from "expo-web-browser";
import { WebView } from "react-native-webview";
import type {
  ShouldStartLoadRequest,
  WebViewMessageEvent,
} from "react-native-webview/lib/WebViewTypes";

import { INTERNAL_HOSTS, OAUTH_REDIRECT, WEB_APP_URL } from "./config";
import { BRAND, palette } from "./theme";
import { registerWebView, reloadOtherWebViews } from "./webviewRegistry";

// Runs before the page's own scripts. `window.ReactNativeWebView` (injected by
// react-native-webview) is what frontend/lib/nativeShell.ts detects; this flag
// is a secondary, earlier-available marker.
const BOOTSTRAP_JS = `window.__CFO_NATIVE_SHELL = { platform: ${JSON.stringify(
  Platform.OS,
)} }; true;`;

type ShellMessage =
  | { source: "cfo-ai"; type: "oauth"; url: string }
  | { source: "cfo-ai"; type: "auth"; event: "SIGNED_IN" | "SIGNED_OUT" }
  // Whether the NATIVE floating burger should show — true while the web
  // app's AppShell is mounted with its drawer closed. Native because a
  // web-fixed button drifts during fling scrolls/overscroll (2026-08-18).
  | { source: "cfo-ai"; type: "chrome"; burger: boolean };

type Props = {
  /** Stable key in the webviewRegistry (the tab name). */
  tabKey: string;
  /** Web app route this tab opens on, e.g. "/dashboard". */
  path: string;
};

export function WebAppScreen({ tabKey, path }: Props) {
  const scheme = useColorScheme();
  const p = palette(scheme);
  // Absolute children anchor to the SafeAreaView's BOX, not its padding —
  // the burger needs the status-bar inset added explicitly.
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const canGoBackRef = useRef(false);
  const oauthInFlightRef = useRef(false);
  const [firstLoadDone, setFirstLoadDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const failedRef = useRef(false);
  failedRef.current = failed;
  // Native burger visibility — driven by the web app's `chrome` messages;
  // false on pages without the app shell (login, landing).
  const [showBurger, setShowBurger] = useState(false);

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
        reloadOtherWebViews(tabKey);
      } else if (message.type === "chrome") {
        setShowBurger(message.burger === true);
      }
    },
    [handleNativeOAuth, tabKey],
  );

  // Burger tap → `cfo:native-action` CustomEvent; AppShell opens the drawer.
  const openMenu = useCallback(() => {
    webRef.current?.injectJavaScript(
      'window.dispatchEvent(new CustomEvent("cfo:native-action",' +
        '{ detail: { action: "menu" } })); true;',
    );
  }, []);

  return (
    // Root stays BLACK regardless of system scheme (2026-08-18 per operator:
    // the status-bar strip read green from the dark palette's tinted
    // background) — the web app is dark-only, so black chrome always matches.
    <SafeAreaView edges={["top"]} style={styles.root}>
      <WebView
        ref={webRef}
        source={{ uri: `${WEB_APP_URL}${path}` }}
        style={{ flex: 1, backgroundColor: p.background }}
        applicationNameForUserAgent="CFOAIApp/1.0"
        injectedJavaScriptBeforeContentLoaded={BOOTSTRAP_JS}
        onMessage={handleMessage}
        onShouldStartLoadWithRequest={handleShouldStart}
        onNavigationStateChange={(nav) => {
          canGoBackRef.current = nav.canGoBack;
        }}
        // Full page (re)load — hide the burger until the new page's AppShell
        // reports chrome again (a reload into /login must not keep it).
        onLoadStart={() => setShowBurger(false)}
        onLoadEnd={() => setFirstLoadDone(true)}
        onError={() => setFailed(true)}
        // iOS can't render in-page downloads (report exports) — system browser.
        onFileDownload={({ nativeEvent }) => {
          void WebBrowser.openBrowserAsync(nativeEvent.downloadUrl).catch(() => {});
        }}
        domStorageEnabled
        sharedCookiesEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        setSupportMultipleWindows={false}
        allowsInlineMediaPlayback
      />

      {/* NATIVE floating burger — overlays the WebView top-left, so web
          scrolling/overscroll can never move it. Shown only while the web
          app reports its shell is mounted (drawer closed). */}
      {showBurger && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Open navigation menu"
          onPress={openMenu}
          style={[styles.burger, { top: insets.top + 12 }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <View style={styles.burgerBar} />
          <View style={styles.burgerBar} />
          <View style={styles.burgerBar} />
        </TouchableOpacity>
      )}

      {!firstLoadDone && !failed && (
        <View style={[styles.overlay, { backgroundColor: p.background }]}>
          <ActivityIndicator size="large" color={BRAND} />
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  // Mirrors the web app's dark glass chrome (surface #101816 / border
  // #1E2A26 / ink #E8F1EE) — the app is dark-only, so these are static.
  burger: {
    position: "absolute",
    // `top` is set inline: safe-area inset + 12.
    left: 12,
    height: 44,
    width: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#1E2A26",
    backgroundColor: "rgba(16, 24, 22, 0.85)",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  burgerBar: {
    width: 18,
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
