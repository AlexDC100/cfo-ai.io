// CFO AI native shell — a single WebView into the web app. Navigation is the
// web app's own burger menu (the native bottom tab bar was removed 2026-08-18);
// see src/WebAppScreen.tsx and mobile/README.md for the architecture.

import React, { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Linking from "expo-linking";

import { HOME_PATH, OAUTH_REDIRECT } from "./src/config";
import { WebAppScreen } from "./src/WebAppScreen";
import { broadcastJavaScript } from "./src/webviewRegistry";

export default function App() {
  // Fallback for OAuth redirects that arrive as a plain deep link instead of
  // resolving the WebBrowser auth session (some Android browsers). Forwarded
  // to the mounted web app instance, which completes login.
  // (Cold-start links aren't handled — an auth session that died with the app
  // simply restarts from the login screen.)
  useEffect(() => {
    const sub = Linking.addEventListener("url", ({ url }) => {
      if (!url.startsWith(OAUTH_REDIRECT)) return;
      broadcastJavaScript(
        `window.__cfoNativeAuthCallback && window.__cfoNativeAuthCallback(${JSON.stringify(
          url,
        )}); true;`,
      );
    });
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      {/* Light icons always — the shell chrome is black regardless of the
          system scheme (the web app is dark-only). */}
      <StatusBar style="light" />
      <WebAppScreen tabKey="Main" path={HOME_PATH} />
    </SafeAreaProvider>
  );
}
