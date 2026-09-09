// Inside a native sheet's WebView (2026-09-08): the moment the route leaves
// /_native/sheet — a quick action, Settings, the sign-out redirect — ask the
// shell to dismiss the sheet and send the MAIN WebView to that route. The
// sheet WebView itself is torn down right after, so whatever it rendered
// in the meantime never matters.

import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { postToNativeShell } from "@/lib/nativeShell";

export function NativeSheetRouteWatcher() {
  const location = useLocation();
  useEffect(() => {
    if (location.pathname.startsWith("/_native/sheet")) return;
    postToNativeShell({
      source: "cfo-ai",
      type: "sheet",
      navigate: location.pathname + location.search,
    });
  }, [location.pathname, location.search]);
  return null;
}
