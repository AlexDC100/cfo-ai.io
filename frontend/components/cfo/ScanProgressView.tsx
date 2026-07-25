// ScanProgressView — the fullscreen scanning surface: pipeline steps
// pinned at the top, live status line, and a spacer the PERSISTENT
// council sphere (CouncilSphereHost, mounted in AppShell) paints over.
//
// Extracted from FinancialStatements' inline scanning view (2026-07-24)
// so /products shows the exact same scan experience for SKU-dataset
// uploads. Step labels are caller-supplied (the document pipeline emits
// the same statuses either way; only the wording differs per surface).

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, CheckCircle2 } from "lucide-react";

import type { DocumentStatus } from "@/lib/supabase";

import {
  setScanSpherePaused,
  setScanSphereFinalizing,
  setScanSphereComplete,
  sphereViewportHeight,
} from "./CouncilSphereHost";

export const TRIAL_BALANCE_STEPS = [
  "Detect format",
  "Extract data",
  "Rebuild statements",
  "Calculate ratios",
  "Generate recs",
] as const;

export const SKU_DATASET_STEPS = [
  "Detect format",
  "Extract rows",
  "Roll up SKUs",
  "Classify portfolio",
  "Generate briefing",
] as const;

const STATUS_ORDINAL: Record<string, number> = {
  queued: 0, extracting: 1, mapping: 2, computing: 3, narrating: 4, analyzed: 5, failed: 0,
};

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued for analysis…",
  extracting: "Reading the document…",
  mapping: "Mapping accounts…",
  computing: "Computing ratios…",
  narrating: "Generating insights…",
  analyzed: "Analysis ready",
  failed: "Analysis failed",
};

export function ScanProgressView({
  status,
  steps = TRIAL_BALANCE_STEPS as unknown as string[],
  onCancel,
  onViewResults,
}: {
  status: DocumentStatus;
  steps?: readonly string[];
  /** Renders a Cancel button under the sphere. Dismisses the scan VIEW
   *  (clearUpload) — the backend pipeline itself keeps running. */
  onCancel?: () => void;
  /** When provided, the view drives the sphere's "almost done" end pose +
   *  completion fade, and — once the analysis lands — replaces the sphere
   *  with a centered "Scan complete" card whose button calls this to open
   *  the results. Omitted by surfaces (e.g. /products) that hand off to
   *  their own post-analysis view. */
  onViewResults?: () => void;
}) {
  // Cancel is two-step: the first press pauses + desaturates the sphere
  // (via the host's pause signal) and swaps the button for an inline
  // confirmation; only confirming actually dismisses the scan view.
  const [confirming, setConfirming] = useState(false);

  // While confirming, the whole scanning process reads as PAUSED: the
  // debug simulator genuinely halts (it polls the pause signal), and
  // for real pipelines — which the browser cannot pause server-side —
  // the steps/status display freezes at its current stage and catches
  // up when the user keeps analyzing.
  const frozenStatus = useRef(status);
  if (!confirming) frozenStatus.current = status;
  const shownStatus = confirming ? frozenStatus.current : status;

  const currentOrdinal = STATUS_ORDINAL[shownStatus] ?? 0;
  const statusLabel = STATUS_LABEL[shownStatus] ?? shownStatus;
  const sphereHeight = sphereViewportHeight();
  const isComplete = shownStatus === "analyzed";
  // The completion hand-off (fade sphere → "Scan complete" card) is only
  // wired when the caller supplies onViewResults (the dashboard). Surfaces
  // without it keep the plain scanning view through to analyzed.
  const completing = isComplete && !!onViewResults;
  useEffect(() => {
    setScanSpherePaused(confirming);
    return () => setScanSpherePaused(false);
  }, [confirming]);

  // Drive the persistent sphere's end pose + fade off the document status.
  //   · finalizing when the LAST processing step is active ("almost done"):
  //     the sphere settles into its final pose before the analysis lands.
  //   · complete once analyzed: the sphere layer fades out (host handles it)
  //     so the completion card below owns the space.
  // Only when onViewResults is set — otherwise the sphere is left to the
  // council stream's own choreography (e.g. /products).
  useEffect(() => {
    if (!onViewResults) return;
    setScanSphereFinalizing(currentOrdinal >= steps.length - 1);
    return () => setScanSphereFinalizing(false);
  }, [onViewResults, currentOrdinal, steps.length]);
  useEffect(() => {
    if (!onViewResults) return;
    setScanSphereComplete(completing);
    return () => setScanSphereComplete(false);
  }, [onViewResults, completing]);

  // The scanning view is a fixed, viewport-fitted composition (steps +
  // sphere + cancel) — lock document scroll while it's up so the page
  // can't be scrolled out from under the fixed sphere layer.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Refresh / tab-close guard while a scan is in flight. Browsers show
  // their own generic "changes you made may not be saved" prompt — the
  // custom string below is ignored by modern browsers but setting
  // returnValue is what ARMS the prompt.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "An analysis is still running — leaving now will lose its progress.";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return (
    // animate-fade-in — the steps panel (and, visually, the sphere the
    // fixed host paints over the spacer) eases in when the scan view
    // takes over.
    <div className="space-y-4 animate-fade-in" data-testid="upload-scanning-fullscreen">
      {/* Pipeline steps — top of the page. */}
      <ol
        className="relative w-full max-w-[720px] mx-auto flex items-start justify-between gap-2 pt-1"
        aria-label="Analysis pipeline"
        data-testid="upload-pipeline"
      >
        {/* Progress connector — rendered as ONE SEGMENT PER GAP between
            adjacent circles, inset 22px on each side of the h-10 (40px) circles
            so the bar NEVER runs under a circle. A completed segment (both its
            circles reached — `i < currentOrdinal`) carries the animated brand
            gradient (ask-ai-anim-fill); pending gaps stay a faint rail. Shared
            by every scanning screen (dashboard + products). top-[18px] centers
            the 4px bar on the 40px circles' center line. */}
        {steps.length > 1 &&
          steps.slice(0, -1).map((_, i) => {
            const segFilled = i < currentOrdinal;
            return (
              <span
                key={`seg-${i}`}
                aria-hidden
                className={`absolute top-[18px] h-1 rounded-full transition-colors duration-500 ${
                  segFilled ? "ask-ai-anim-fill [animation-duration:10s]" : "bg-rule/50"
                }`}
                style={{
                  left: `calc(${((i + 0.5) / steps.length) * 100}% + 22px)`,
                  width: `calc(${(1 / steps.length) * 100}% - 44px)`,
                }}
              />
            );
          })}
        {steps.map((label, i) => {
          const done = i < currentOrdinal;
          const active = i === currentOrdinal;
          return (
            <li key={label} className="relative flex-1 min-w-0 flex flex-col items-center text-center">
              {/* Matches the Workspace onboarding Stepper: a completed step
                  fills with the animated brand gradient + glow and swaps its
                  number for a check; the active step gets the brand-tint ring;
                  pending steps stay neutral with a 0-padded number. */}
              <span className={`
                relative z-10 inline-flex items-center justify-center
                h-10 w-10 rounded-full text-[13px] font-semibold tabular-nums
                transition-all duration-300
                ${done
                  ? "ask-ai-anim-fill [animation-duration:10s] border border-brand/50 text-ink shadow-[0_0_12px_rgba(92,211,197,0.55)]"
                  : active
                  ? "bg-brand/15 text-brand-d ring-2 ring-brand/30"
                  : "bg-bg-2 text-ink-mute border border-rule"}
              `}>
                {/* Slow sonar glow while active; when the next step starts
                    this overlay's opacity fades out (700ms) instead of the
                    pulse snapping off mid-cycle. */}
                <span
                  aria-hidden
                  className={`absolute -inset-px rounded-full step-pulse transition-opacity duration-700 ease-out ${active ? "opacity-100" : "opacity-0"}`}
                />
                {done ? <Check size={18} strokeWidth={2.5} className="relative z-10" /> : `0${i + 1}`}
              </span>
              <span className={`mt-2 text-[11.5px] uppercase tracking-[0.08em] font-medium leading-tight max-w-[100px] ${active ? "text-ink" : "text-ink-mute"}`}>
                {label}
              </span>
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="text-center text-[13px] font-medium text-ink opacity-50">
        {statusLabel}
      </p>
      {/* Council sphere — rendered by the PERSISTENT CouncilSphereHost
          in AppShell (a fixed layer over this area), never here: a
          per-page mount would reset the sphere's animation on every
          tab switch. This spacer just reserves the layout height the
          fixed layer paints over. The Cancel block anchors INSIDE it,
          just under the sphere's visible bottom edge: the sphere is
          centred in this box with visual radius ≈ 230 (intrinsic) ×
          0.85 (host scale) ≈ 196px, +16px — the same gap rhythm as the
          steps (space-y-4). Keep the 212 in sync with the host's
          scale. */}
      <div className="relative" style={{ height: sphereHeight }}>
      {/* Scan complete — once the analysis lands the sphere fades out (the
          host handles that) and this centered card fades in over the same
          space, with the button that opens the results. Delayed slightly so
          the sphere is on its way out before the card appears. Only when the
          caller wired onViewResults. */}
      {completing && (
        <motion.div
          key="scan-complete"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4, ease: "easeOut" }}
          className="absolute inset-x-0 z-40 flex flex-col items-center gap-3 text-center px-4"
          style={{ top: "calc(50% - 56px)" }}
          data-testid="scan-complete-card"
        >
          <span className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-brand/15 text-brand-d">
            <CheckCircle2 size={30} strokeWidth={1.75} />
          </span>
          <h3 className="text-[19px] font-semibold text-ink">Scan complete</h3>
          <p className="text-[13px] text-ink-soft max-w-[340px] leading-relaxed">
            Your analysis is ready — statements, ratios, valuation and
            recommendations have been rebuilt.
          </p>
          <button
            type="button"
            onClick={onViewResults}
            data-testid="scan-view-results"
            className="mt-1 inline-flex items-center justify-center h-10 px-5 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors"
          >
            View results
          </button>
        </motion.div>
      )}
      {/* Cancel — first press pauses + grayscales the sphere and asks
          for confirmation; confirming dismisses the scan view (the
          analysis itself continues server-side and still lands when
          done). The fixed sphere layer is pointer-events-none at z-30,
          so z-40 keeps these buttons clickable above it. Hidden once the
          completion card takes over. */}
      {onCancel && !completing && (
        <div
          className="absolute inset-x-0 z-40 flex flex-col items-center gap-2.5"
          style={{ top: "calc(50% + 260px)" }}
        >
          {/* Crossfade between the Cancel button and the confirmation
              block — mode="wait" fades one fully out before the other
              fades in. */}
          <AnimatePresence mode="wait" initial={false}>
            {confirming ? (
              <motion.div
                key="scan-cancel-confirming"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col items-center gap-2.5"
              >
                <p className="text-[13px] font-medium text-ink" aria-live="polite">
                  Cancel this analysis?
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    data-testid="scan-cancel-keep"
                    className="
                      inline-flex items-center justify-center h-9 px-4 rounded-lg
                      border border-rule bg-surface text-[12.5px] font-medium text-ink
                      hover:bg-bg-2/60 hover:border-rule-strong transition-colors
                    "
                  >
                    Keep analyzing
                  </button>
                  <button
                    type="button"
                    onClick={onCancel}
                    data-testid="scan-cancel-confirm"
                    className="
                      inline-flex items-center justify-center h-9 px-4 rounded-lg
                      border border-red-500/40 bg-surface text-[12.5px] font-medium text-red-700 dark:text-red-300
                      hover:bg-red-500/10 transition-colors
                    "
                  >
                    Yes, cancel
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="scan-cancel-idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  data-testid="scan-cancel"
                  className="
                    inline-flex items-center justify-center h-9 px-4 rounded-lg
                    border border-red-500/40 bg-surface text-[12.5px] font-medium text-red-700 dark:text-red-300
                    hover:bg-red-500/10 transition-colors
                  "
                >
                  Cancel
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      </div>
    </div>
  );
}
