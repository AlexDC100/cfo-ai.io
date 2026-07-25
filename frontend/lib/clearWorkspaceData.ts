// clearWorkspaceData — wipe the DEVICE-LOCAL, workspace-scoped data caches on a
// workspace switch (and sign-out).
//
// Most tabs re-scope to the selected workspace automatically: they read through
// react-query with an `X-Org-Id` header, and `switchOrg` calls
// `queryClient.clear()`, so a switch forces a fresh, correctly-scoped fetch.
//
// A handful of surfaces, though, cache their data in a SINGLE global
// localStorage entry that is NOT keyed by workspace:
//   · the SKU "active run" (Products / onboarding upload preview)   — aicfo.*
//   · the Budget-vs-Actual comparison dataset (Variance)            — cfo:budget-comparison:v1
//   · the benchmark peer list (Benchmark / Public Companies)        — cfo:benchmark-peers:v1
//
// Because they aren't per-workspace, they'd otherwise show whichever workspace
// last populated them regardless of which one is selected. Clearing them on a
// switch keeps those tabs honest — they show the selected workspace's data
// (re-fetched from the server) instead of the previous one's. The dropped
// caches are re-derivable (re-upload / re-add), and the server copies (where
// they exist) repopulate via react-query.

import { clearActiveRun } from "@/lib/runStore";
import { clearPeers } from "@/lib/benchmarkPeersStore";

const BUDGET_KEY = "cfo:budget-comparison:v1";

export function clearWorkspaceScopedData(): void {
  try {
    // SKU active-run + analysis + raw rows + alerts + per-SKU decisions.
    clearActiveRun();
  } catch { /* non-fatal */ }
  try {
    // Benchmark peer tickers.
    clearPeers();
  } catch { /* non-fatal */ }
  try {
    // Budget-vs-Actual dataset. The store subscribes to `storage` events, so
    // dispatch one after removing the key to notify any live subscriber.
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(BUDGET_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: BUDGET_KEY }));
    }
  } catch { /* non-fatal */ }
}
