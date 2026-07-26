// scanGuard — nothing re-scopes the app while an analysis is running.
//
// Switching month or workspace re-scopes every query on screen (statements,
// ratios, products, valuation) and, for a workspace switch, clears the query
// cache outright. Doing that mid-scan strands the run: the pipeline keeps
// going server-side, but the scan view unmounts, the completion hand-off has
// nowhere to land, and the user is left on a different month wondering where
// their upload went.
//
// So both switches are blocked while `uploadStore` holds an in-flight upload
// — dashboard or products, since either one owns the scan surface. The block
// is deliberately a plain toast, not a modal: the user asked for a switch, we
// say why it didn't happen, and their scan carries on undisturbed.
//
// Terminal states (analyzed / failed) do NOT block: at that point the run is
// over and the surface is just waiting for a click.

import { toast } from "@/components/ui/sonner";
import { isInFlight, readUploadStore } from "@/lib/uploadStore";

/** The upload currently being analyzed, or null. */
export function scanInFlight(): { filename: string } | null {
  const cur = readUploadStore().current;
  if (!cur || !isInFlight(cur.status)) return null;
  return { filename: cur.filename };
}

/**
 * Call at the top of a switch handler:
 *
 *   if (blockedByScan("period")) return;
 *
 * Returns true when a scan is running (and has told the user), false when the
 * caller is free to proceed.
 */
export function blockedByScan(target: "period" | "workspace"): boolean {
  const running = scanInFlight();
  if (!running) return false;
  const what = target === "period" ? "months" : "workspaces";
  toast.warning(`Analysis in progress — switching ${what} is paused`, {
    description: `“${running.filename}” is still being analyzed. This takes a moment; the screen opens by itself when it's done.`,
  });
  return true;
}
