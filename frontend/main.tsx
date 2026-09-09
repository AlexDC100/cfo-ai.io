import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { isNativeShell } from "@/lib/nativeShell";
import "./index.css";
import { installDevBackendCircuitBreaker } from "./lib/devBackendCircuitBreaker";
import { setupQueryPersistence } from "./lib/queryPersist";

// Dev-only: stop a not-running local backend from spamming ERR_CONNECTION_REFUSED
// and making every page retry a doomed round-trip. No-op in production.
installDevBackendCircuitBreaker();

// Hydrate the TanStack Query cache from localStorage BEFORE first render so a
// reload / return visit paints pages from cached data instantly (staleTime
// still governs background revalidation). See lib/queryPersist.ts.
setupQueryPersistence();

// Native shell: the document paints no background of its own (index.css
// `html.native-shell`) — the WebView's theme-coloured backdrop is the
// background, so swipe-down refresh moves only the content (2026-09-08).
if (isNativeShell()) {
  document.documentElement.classList.add("native-shell");
  // No pinch/double-tap zoom in the app (2026-09-08 per operator). The
  // meta covers Android's WebView; iOS ignores user-scalable but honours
  // `touch-action: pan-x pan-y` on the root (index.css `html.native-shell`).
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover");
}

createRoot(document.getElementById("root")!).render(<App />);
