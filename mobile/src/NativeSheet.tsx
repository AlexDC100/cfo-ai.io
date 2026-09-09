// Native iOS bottom sheet (2026-09-08 per operator) hosting a second WebView
// on the web app's /_native/sheet/<kind> route — the account surface or the
// notifications list. A SwiftUI sheet (UISheetPresentationController under
// the hood: card look, grabber, medium/large detents, swipe-to-dismiss) via
// @expo/ui. The two WebViews share localStorage, so the sheet sees the same
// Supabase session as the main page.
//
// Messages from the sheet's page:
//   · { type: "sheet", close }          — dismiss
//   · { type: "sheet", navigate: path } — dismiss and route the MAIN WebView
//   · { type: "auth", event: SIGNED_OUT } — sign-out inside the sheet:
//                                          reload the main WebView, dismiss

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { BottomSheet, Group, Host, RNHostView } from "@expo/ui/swift-ui";
import { frame, presentationBackground, presentationDetents, presentationDragIndicator } from "@expo/ui/swift-ui/modifiers";
import Constants from "expo-constants";
import { WEB_APP_URL } from "./config";
import { registerWebView, reloadOtherWebViews } from "./webviewRegistry";

export type NativeSheetKind = "account" | "notifications";

type SheetMessage =
  | { source: "cfo-ai"; type: "sheet"; close?: boolean; navigate?: string }
  | { source: "cfo-ai"; type: "auth"; event: "SIGNED_IN" | "SIGNED_OUT" }
  | { source: "cfo-ai"; type: string };

type Props = {
  /** Which sheet to show; null = none presented. */
  kind: NativeSheetKind | null;
  /** Backdrop until the sheet's page reports its own canvas colour. */
  fallbackBg: string;
  onClose: () => void;
  /** A jump launched inside the sheet — route the main WebView there. */
  onNavigate: (path: string) => void;
};

const SHEET_KEY = "sheet";

/** The web app reports colours as `hsl(h, s%, l%)`; SwiftUI modifiers want
 *  hex. Anything unparseable falls back to the given default. */
function toHex(color: string, fallback: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color.trim())) return color.trim();
  const m = /hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/.exec(color);
  if (!m) return fallback;
  const h = parseFloat(m[1]) / 360, sat = parseFloat(m[2]) / 100, l = parseFloat(m[3]) / 100;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = sat * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function NativeSheet({ kind, fallbackBg, onClose, onNavigate }: Props) {
  const webRef = useRef<WebView>(null);
  const presented = kind !== null;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!kind) setLoaded(false);
  }, [kind]);
  // SwiftUI modifiers are kept STABLE for a presentation — changing them
  // re-evaluates the sheet body and re-creates the hosted React Native
  // tree (a second WebView boot). The main page's canvas colour is the
  // same theme, so it is the one colour the sheet needs.
  const modifiers = useMemo(
    () => [
      presentationDetents(["medium", "large"]),
      presentationDragIndicator("visible"),
      presentationBackground(toHex(fallbackBg, "#000000")),
      // Fill the sheet at every detent (2026-09-08 per operator: "content
      // cut off by a black band") — without this the hosted view kept the
      // size it was first given and the rest of a taller sheet was bare
      // backdrop.
      frame({ maxWidth: 100000, maxHeight: 100000 }),
    ],
    [fallbackBg],
  );
  // In the registry so a sign-out here reloads the main WebView (and a
  // sign-in/out there reloads this one) through the existing mechanism.
  useEffect(
    () =>
      registerWebView(SHEET_KEY, {
        reload: () => webRef.current?.reload(),
        injectJavaScript: (js) => webRef.current?.injectJavaScript(js),
      }),
    [],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: SheetMessage;
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (message?.source !== "cfo-ai") return;
      if (message.type === "sheet") {
        const m = message as { close?: boolean; navigate?: string };
        if (typeof m.navigate === "string") onNavigate(m.navigate);
        else if (m.close) onClose();
      } else if (message.type === "auth") {
        // Only a SIGN-OUT is a transition here: supabase-js also emits
        // SIGNED_IN while RECOVERING the stored session on every boot, and
        // acting on that reloaded the main page (which then reloaded this
        // sheet…) each time a sheet opened while signed in.
        if ((message as { event?: string }).event !== "SIGNED_OUT") return;
        reloadOtherWebViews(SHEET_KEY);
        onClose();
      }
    },
    [onClose, onNavigate],
  );

  // Same marker the main WebView gets, plus which sheet this page is.
  const bootstrap = `window.__CFO_NATIVE_SHELL = { platform: "ios", version: ${JSON.stringify(
    Constants.expoConfig?.version ?? "",
  )}, sheet: ${JSON.stringify(kind ?? "")} }; true;`;

  return (
    // The Host only needs to be in the view hierarchy for the sheet to
    // present from; it draws nothing and takes no touches.
    <Host style={styles.host} pointerEvents="none">
      <BottomSheet
        isPresented={presented}
        onIsPresentedChange={(next) => {
          if (!next) onClose();
        }}
        // Belt: a swipe-dismiss that skipped the change callback left `kind`
        // set, and the next request for the same sheet was a no-op — the
        // "press it several times" symptom (2026-09-08 per operator).
        onDismiss={onClose}
      >
        <Group modifiers={modifiers}>
          <RNHostView>
            <View style={[styles.body, { backgroundColor: fallbackBg }]}>
              {kind && (
                <WebView
                  ref={webRef}
                  source={{ uri: `${WEB_APP_URL}/_native/sheet/${kind}` }}
                  style={styles.web}
                  applicationNameForUserAgent="CFOAIApp/1.0"
                  injectedJavaScriptBeforeContentLoaded={bootstrap}
                  onMessage={handleMessage}
                  domStorageEnabled
                  sharedCookiesEnabled
                  setSupportMultipleWindows={false}
                  allowsBackForwardNavigationGestures={false}
                  scalesPageToFit={false}
                  setBuiltInZoomControls={false}
                  onLoadStart={() => setLoaded(false)}
                  onLoadEnd={() => setLoaded(true)}
                />
              )}
              {kind && !loaded && (
                // The page is a fresh boot of the web app each open; show a
                // native spinner until it has painted rather than a blank
                // sheet. (Vite dev serves unbundled modules — production
                // builds load in a fraction of the time.)
                <View pointerEvents="none" style={styles.loading}>
                  <ActivityIndicator color={isDark(fallbackBg) ? "#ffffff" : "#000000"} />
                </View>
              )}
            </View>
          </RNHostView>
        </Group>
      </BottomSheet>
    </Host>
  );
}

/** Rough lightness test on a hex/hsl colour string. */
function isDark(color: string): boolean {
  const hex = toHex(color, "#000000");
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 < 0.5;
}

const styles = StyleSheet.create({
  host: { position: "absolute", left: 0, top: 0, width: 1, height: 1, opacity: 0 },
  body: { flex: 1 },
  web: { flex: 1, backgroundColor: "transparent" },
  loading: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
});
