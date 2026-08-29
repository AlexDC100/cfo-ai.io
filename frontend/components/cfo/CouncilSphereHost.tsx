// CouncilSphereHost — ONE persistent council-sphere instance, app-wide.
//
// 2026-07-24: the sphere's animation state (canvas simulation, seat
// positions, growth arcs) lives inside the CouncilSphere class instance,
// so mounting it per-page meant every tab switch reset the visual even
// though the scan itself (uploadStore + the module-level council stream)
// kept running. This host mounts the visualizer ONCE in AppShell for the
// lifetime of a scan and merely toggles visibility: on the dashboard's
// scanning view it shows as a fixed layer over the reserved area; on any
// other tab it stays mounted but hidden, its animation loop still
// advancing — so returning shows the sphere exactly where it got to.
//
// Unmounts only when no scan is in flight, so each new scan starts from
// a fresh sphere.

import { useCallback, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";

import { CouncilVisualizer } from "./CouncilVisualizer";
import { InlineErrorBoundary } from "./InlineErrorBoundary";
import { useActivePeriod } from "@/lib/activePeriod";
import { isInFlight, useUploadStore } from "@/lib/uploadStore";

/** Vertical space the dashboard's scanning view reserves above the
 *  sphere: 64px fixed header + the pipeline steps + status line. Keep in
 *  sync with the scanning view's spacer in FinancialStatements.tsx. */
export const SPHERE_TOP_OFFSET = 200;

// ── Pause signal ─────────────────────────────────────────────────────
// The scan view's cancel-confirmation state lives on the page, but the
// sphere lives in THIS persistent host — a module-level flag bridges
// them: while set, the sphere freezes (CouncilSphere `paused`) and
// desaturates.

let spherePaused = false;
const pauseListeners = new Set<() => void>();

export function setScanSpherePaused(v: boolean): void {
  if (spherePaused === v) return;
  spherePaused = v;
  for (const l of pauseListeners) l();
}

/** Imperative read — the debug scan simulator polls this between steps
 *  so the cancel-confirmation state genuinely pauses the process. */
export function isScanSpherePaused(): boolean {
  return spherePaused;
}

function useScanSpherePaused(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    pauseListeners.add(cb);
    return () => { pauseListeners.delete(cb); };
  }, []);
  return useSyncExternalStore(subscribe, () => spherePaused, () => false);
}

// ── Finalize + complete signals ──────────────────────────────────────
// The scan view (ScanProgressView) drives these off the document status:
//   · finalizing — the pipeline reached its last processing step
//     ("almost done"): force the sphere into its end pose (contracting
//     settle + core flare) even before the council stream's own `done`.
//   · complete — the analysis landed: fade the whole sphere layer out so
//     the scan view can hand over to its "Scan complete" card.
// Same module-level-flag bridge as the pause signal above.

let sphereFinalizing = false;
const finalizingListeners = new Set<() => void>();
let sphereComplete = false;
const completeListeners = new Set<() => void>();

export function setScanSphereFinalizing(v: boolean): void {
  if (sphereFinalizing === v) return;
  sphereFinalizing = v;
  for (const l of finalizingListeners) l();
}

export function setScanSphereComplete(v: boolean): void {
  if (sphereComplete === v) return;
  sphereComplete = v;
  for (const l of completeListeners) l();
}

function useScanSphereFinalizing(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    finalizingListeners.add(cb);
    return () => { finalizingListeners.delete(cb); };
  }, []);
  return useSyncExternalStore(subscribe, () => sphereFinalizing, () => false);
}

function useScanSphereComplete(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    completeListeners.add(cb);
    return () => { completeListeners.delete(cb); };
  }, []);
  return useSyncExternalStore(subscribe, () => sphereComplete, () => false);
}

export function sphereViewportHeight(): number {
  if (typeof window === "undefined") return 560;
  // -104: room below the sphere for the scan view's Cancel row, so the
  // whole composition fits the viewport with document scroll locked.
  return Math.max(420, window.innerHeight - SPHERE_TOP_OFFSET - 104);
}

export function CouncilSphereHost({
  sidebarCollapsed = false,
}: {
  /** Mirror of AppShell's rail state — the fixed layer takes the same
   *  left padding as <main>, so the sphere centers on the CONTENT
   *  column's axis (where the pipeline steps center), not the raw
   *  viewport's. */
  sidebarCollapsed?: boolean;
}) {
  const upload = useUploadStore();
  const period = useActivePeriod();
  const location = useLocation();
  const paused = useScanSpherePaused();
  const finalizing = useScanSphereFinalizing();
  const complete = useScanSphereComplete();

  const live =
    upload.current && isInFlight(upload.current.status) ? upload.current : null;
  // Keep painting through the FINALE, not just the fade. `analyzed` makes the
  // doc "not in flight", so this gate used to drop the sphere the instant the
  // analysis landed — and since `complete` only flips a second later (after
  // the convergence), the host unmounted for that exact second and the orbs'
  // pull into the core was never on screen: the sphere just popped out.
  // Holding the mount while `finalizing` keeps the whole sequence visible —
  // converge (~1s) → fade → ghost behind the completion card.
  const docId =
    live?.docId ?? (finalizing || complete ? upload.current?.docId ?? null : null);
  if (!docId) return null;

  // Visible only where a fullscreen scanning view renders: the dashboard
  // (State A — no period loaded yet) and /products (its upload surface
  // swaps to the same scan view while a dataset analysis runs).
  // Everywhere else: mounted but hidden, so the animation keeps evolving
  // off-screen.
  const visible =
    (location.pathname === "/dashboard" && !period.isLoaded) ||
    location.pathname === "/products";
  const height = sphereViewportHeight();

  return (
    <div
      data-testid="council-sphere-host"
      aria-hidden={!visible}
      className={`fixed inset-x-0 z-30 pointer-events-none transition-opacity duration-700 ease-out ${
        sidebarCollapsed ? "lg:pl-[64px]" : "lg:pl-[232px]"
      }`}
      style={{
        top: SPHERE_TOP_OFFSET,
        height,
        visibility: visible ? "visible" : "hidden",
        // Fade the sphere down once the analysis lands so the completion
        // card owns the space — but not to nothing: it settles at a ghost
        // (2026-07-26 per operator) so the sphere is still there, behind
        // the "View results" screen, instead of blinking out of existence.
        opacity: complete ? 0.14 : 1,
      }}
    >
      {/* Mirror the content wrapper's clamp + gutters (AppShell <main>)
          so the sphere's center X equals the steps' center X exactly.
          animate-fade-in eases the sphere in when the scan starts (this
          host mounts once per scan, so it plays once). */}
      <div className="max-w-[1760px] px-4 sm:px-8 lg:px-10 h-full animate-fade-in">
        <InlineErrorBoundary
          tag="CouncilVisualizer"
          label="The council visualizer hit a snag — analysis is still running; watch the steps above."
          onReset={() => { /* visual-only; nothing to reset */ }}
        >
          <CouncilVisualizer
            documentId={docId}
            height={height}
            scale={0.85}
            hideLabels
            paused={paused}
            forceFinal={finalizing || complete}
          />
        </InlineErrorBoundary>
      </div>
    </div>
  );
}
