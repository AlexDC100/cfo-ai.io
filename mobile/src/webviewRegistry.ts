// Registry of the mounted tab WebViews so cross-tab coordination works:
//  · after a SIGNED_IN / SIGNED_OUT transition in one tab, the others reload
//    so their supabase-js instances pick up the (shared) localStorage session;
//  · an OAuth deep link arriving at the app level can be forwarded to every
//    mounted web app instance.

export type WebViewHandle = {
  reload: () => void;
  injectJavaScript: (js: string) => void;
};

const registry = new Map<string, WebViewHandle>();

// Auth events can echo between instances (supabase-js cross-context storage
// sync); a short debounce makes a reload storm impossible.
let lastReloadOthersAt = 0;
const RELOAD_DEBOUNCE_MS = 3000;

export function registerWebView(key: string, handle: WebViewHandle): () => void {
  registry.set(key, handle);
  return () => {
    if (registry.get(key) === handle) registry.delete(key);
  };
}

export function reloadOtherWebViews(exceptKey: string): void {
  const now = Date.now();
  if (now - lastReloadOthersAt < RELOAD_DEBOUNCE_MS) return;
  lastReloadOthersAt = now;
  for (const [key, handle] of registry) {
    if (key !== exceptKey) handle.reload();
  }
}

export function broadcastJavaScript(js: string): void {
  for (const handle of registry.values()) handle.injectJavaScript(js);
}
