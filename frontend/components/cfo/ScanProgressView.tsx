// ScanProgressView — the fullscreen scanning surface: pipeline steps
// pinned at the top, live status line, and a spacer the PERSISTENT
// council sphere (CouncilSphereHost, mounted in AppShell) paints over.
//
// Extracted from FinancialStatements' inline scanning view (2026-07-24)
// so /products shows the exact same scan experience for SKU-dataset
// uploads. Step labels are caller-supplied (the document pipeline emits
// the same statuses either way; only the wording differs per surface).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";

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

// SKU pipeline emits queued → extracting → mapping → narrating → analyzed —
// it NEVER passes through 'computing' (see pipeline.py's scope=='sku'
// branch). The steps therefore map 1:1 onto the four statuses that actually
// occur; a fifth step would sit dark forever and make the scan look stuck.
export const SKU_DATASET_STEPS = [
  "Detect format",
  "Extract rows",
  "Roll up SKUs",
  "Generate briefing",
] as const;

const STATUS_ORDINAL: Record<string, number> = {
  queued: 0, extracting: 1, mapping: 2, computing: 3, narrating: 4, analyzed: 5, failed: 0,
};

// Products (SKU) mapping — 4 processing steps, no 'computing' stage.
// 'computing' kept as an alias of mapping so a stray status can't render
// step 0.
export const SKU_STATUS_ORDINAL: Record<string, number> = {
  queued: 0, extracting: 1, mapping: 2, computing: 2, narrating: 3, analyzed: 4, failed: 0,
};

// Rotating "what the AI is doing" lines per status. The long stages
// (extraction + narration are live model calls that can run 60s+) cycle
// through their lines every few seconds so the scan reads as alive instead
// of freezing on one string. Single-line statuses just hold.
const TB_STATUS_MESSAGES: Record<string, string[]> = {
  queued: ["Queued for analysis…"],
  extracting: [
    "Reading the document…",
    "Detecting the trial-balance layout…",
    "Extracting account balances…",
    "Checking debits against credits…",
  ],
  mapping: [
    "Mapping accounts to statements…",
    "Rebuilding your P&L and balance sheet…",
  ],
  computing: [
    "Computing ratios…",
    "Scoring liquidity and leverage…",
    "Running the credit model…",
  ],
  narrating: [
    "Generating insights…",
    "Writing your briefing…",
    "Drafting recommendations…",
  ],
  analyzed: ["Analysis ready"],
  failed: ["Analysis failed"],
};

export const SKU_STATUS_MESSAGES: Record<string, string[]> = {
  queued: ["Queued for analysis…"],
  extracting: [
    "Reading your sales file…",
    "Detecting the column layout…",
    "Identifying SKU descriptors…",
    "Parsing revenue, volume and margin columns…",
  ],
  mapping: [
    "Extracting SKU rows…",
    "Rolling up brands and categories…",
    "Classifying the portfolio…",
  ],
  computing: [
    "Rolling up brands and categories…",
    "Classifying the portfolio…",
  ],
  narrating: [
    "Analyzing portfolio performance…",
    "Writing your executive briefing…",
    "Drafting recommendations…",
  ],
  analyzed: ["Analysis ready"],
  failed: ["Analysis failed"],
};

// i18n bridge — the step/message constants above are exported and consumed
// by pages this file doesn't own (FinancialStatements / Products pass them
// back in as props), so their SHAPE stays "English literal strings". The
// view translates each known literal to its locale string at render time;
// unknown strings fall through untouched. Exported so those same pages can
// translate the step labels wherever they render them directly (e.g. the
// idle pipeline preview on /products).
export const SCAN_TEXT_KEYS: Record<string, string> = {
  // Step labels
  "Detect format": "scan.steps.detectFormat",
  "Extract data": "scan.steps.extractData",
  "Rebuild statements": "scan.steps.rebuildStatements",
  "Calculate ratios": "scan.steps.calculateRatios",
  "Generate recs": "scan.steps.generateRecs",
  "Extract rows": "scan.steps.extractRows",
  "Roll up SKUs": "scan.steps.rollUpSkus",
  "Generate briefing": "scan.steps.generateBriefing",
  // Status lines — trial balance
  "Queued for analysis…": "productsX.inflight.stage.queued",
  "Reading the document…": "scan.msg.readingDocument",
  "Detecting the trial-balance layout…": "scan.msg.detectingTbLayout",
  "Extracting account balances…": "scan.msg.extractingBalances",
  "Checking debits against credits…": "scan.msg.checkingDebits",
  "Mapping accounts to statements…": "scan.msg.mappingAccounts",
  "Rebuilding your P&L and balance sheet…": "scan.msg.rebuildingStatements",
  "Computing ratios…": "scan.msg.computingRatios",
  "Scoring liquidity and leverage…": "scan.msg.scoringLiquidity",
  "Running the credit model…": "scan.msg.runningCreditModel",
  "Generating insights…": "scan.msg.generatingInsights",
  "Writing your briefing…": "scan.msg.writingBriefing",
  "Drafting recommendations…": "scan.msg.draftingRecs",
  "Analysis ready": "toasts.analysisComplete",
  "Analysis failed": "productsX.toast.analysisFailed",
  // Status lines — SKU dataset
  "Reading your sales file…": "scan.msg.readingSalesFile",
  "Detecting the column layout…": "scan.msg.detectingColumns",
  "Identifying SKU descriptors…": "scan.msg.identifyingSkus",
  "Parsing revenue, volume and margin columns…": "scan.msg.parsingColumns",
  "Extracting SKU rows…": "scan.msg.extractingSkuRows",
  "Rolling up brands and categories…": "scan.msg.rollingUpBrands",
  "Classifying the portfolio…": "scan.msg.classifyingPortfolio",
  "Analyzing portfolio performance…": "scan.msg.analyzingPerformance",
  "Writing your executive briefing…": "scan.msg.writingExecBriefing",
};

export function ScanProgressView({
  status,
  steps = TRIAL_BALANCE_STEPS as unknown as string[],
  statusOrdinals = STATUS_ORDINAL,
  statusMessages = TB_STATUS_MESSAGES,
  onCancel,
  onViewResults,
  completeTitle,
  completeBody,
  completeCta,
}: {
  status: DocumentStatus;
  steps?: readonly string[];
  /** Per-surface status → step-index mapping. The SKU pipeline never emits
   *  'computing', so /products passes SKU_STATUS_ORDINAL (4 steps) — without
   *  it one step never lights and the walk looks stuck. */
  statusOrdinals?: Record<string, number>;
  /** Per-surface rotating detail lines under the steps — what the AI is
   *  doing right now. Long stages cycle their lines every few seconds. */
  statusMessages?: Record<string, string[]>;
  /** Renders a Cancel button under the sphere. Dismisses the scan VIEW
   *  (clearUpload) — the backend pipeline itself keeps running. */
  onCancel?: () => void;
  /** When provided, the view drives the sphere's "almost done" end pose +
   *  completion fade, and — once the analysis lands — replaces the sphere
   *  with a centered "Scan complete" card whose button calls this to open
   *  the results. Omitted by surfaces (e.g. /products) that hand off to
   *  their own post-analysis view. */
  onViewResults?: () => void;
  /** Completion-card copy. Defaults describe a trial-balance scan; /products
   *  passes SKU wording so the card never promises statements it didn't
   *  build. Only used when onViewResults is wired. */
  completeTitle?: string;
  completeBody?: string;
  completeCta?: string;
}) {
  const { t } = useTranslation();
  // Translate a known English literal (step label / status line) to the
  // active language; unknown strings pass through unchanged.
  const trText = (s: string) => (SCAN_TEXT_KEYS[s] ? t(SCAN_TEXT_KEYS[s]) : s);
  const resolvedCompleteTitle = completeTitle ?? t("scan.completeTitle");
  const resolvedCompleteBody = completeBody ?? t("scan.completeBody");
  const resolvedCompleteCta = completeCta ?? t("scan.viewResults");
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

  const currentOrdinal = statusOrdinals[shownStatus] ?? 0;
  // Rotating detail line — cycles through the stage's messages so long
  // model calls (extraction / narration) read as live work, not a freeze.
  const messages = statusMessages[shownStatus] ?? [shownStatus];
  const [msgIdx, setMsgIdx] = useState(0);
  useEffect(() => {
    setMsgIdx(0);
    const count = statusMessages[shownStatus]?.length ?? 1;
    if (count <= 1) return;
    const id = setInterval(() => setMsgIdx((i) => (i + 1) % count), 4000);
    return () => clearInterval(id);
  }, [shownStatus, statusMessages]);
  const statusLabel = trText(messages[Math.min(msgIdx, messages.length - 1)]);
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

  // Drive the persistent sphere's finale off the document status
  // (2026-07-26 per operator): the moment the analysis lands, EVERY orb is
  // pulled into the core (the sphere's `contracting` finale — seats, packets
  // and thoughts all converge within ~1s), and only THEN does the layer fade
  // out for the completion card. Previously the end pose was forced for the
  // whole LAST STEP (a narration stage can run a minute, so the convergence
  // played way too early) while the fade started at the same instant as
  // `analyzed` — so the final pull was never visible as a finish gesture.
  // We can't see the future, so "1 second before finished" is implemented as
  // "converge for 1 second AT finish, fade after".
  // Only when onViewResults is set — otherwise the sphere is left to the
  // council stream's own choreography (e.g. /products).
  useEffect(() => {
    if (!onViewResults || !completing) return;
    setScanSphereFinalizing(true); // orbs → core, layer still fully visible
    const t = setTimeout(() => setScanSphereComplete(true), 1000); // then fade
    return () => {
      clearTimeout(t);
      setScanSphereFinalizing(false);
      setScanSphereComplete(false);
    };
  }, [onViewResults, completing]);

  // The scanning view is a fixed, viewport-fitted composition (steps +
  // sphere + cancel) — lock document scroll while it's up so the page
  // can't be scrolled out from under the fixed sphere layer.
  //
  // Snap to the top FIRST (2026-07-26): the sphere layer is fixed to the
  // viewport but the steps are in normal flow, so starting a scan from a
  // scrolled page (the Products dropzone sits well below the fold) locked
  // the scroll where it was and left the steps tucked under the fixed
  // header — which is why they only looked right after a tab switch reset
  // the scroll position.
  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Short-viewport fix (2026-08-02, operator-reported): on small windows the
  // completion card (icon + copy + "View results") lands BELOW the fold —
  // and with the scroll lock above still active the user literally cannot
  // reach the button, so the scan reads as "Analysis ready → nothing".
  // Once the scan completes the lock has no job left (nothing is animating
  // under the viewport), so release it and bring the card into view.
  useEffect(() => {
    if (!completing) return;
    document.body.style.overflow = "";
    const t = setTimeout(() => {
      document
        .querySelector('[data-testid="scan-complete-card"]')
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 1300); // just after the card's 1.2s fade-in delay
    return () => clearTimeout(t);
  }, [completing]);

  // Refresh / tab-close guard while a scan is in flight. Browsers show
  // their own generic "changes you made may not be saved" prompt — the
  // custom string below is ignored by modern browsers but setting
  // returnValue is what ARMS the prompt.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = t("scan.leaveWarning");
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [t]);
  return (
    // animate-fade-in — the steps panel (and, visually, the sphere the
    // fixed host paints over the spacer) eases in when the scan view
    // takes over.
    <div className="space-y-4 animate-fade-in" data-testid="upload-scanning-fullscreen">
      {/* Pipeline steps — shifted down (2026-07-26 per operator) so they sit
          lower, just above the fixed council sphere. `pt-8` is the safe limit:
          the sphere is a fixed overlay at SPHERE_TOP_OFFSET and the steps must
          stay above it, so this drops them as far as possible without the
          status line colliding with the sphere. */}
      {/* MOBILE stepper (2026-08-04 native-mobile pass) — five full text
          labels in a 375px row collided; phones get slim progress segments
          with ONLY the current step named beneath ("Pasul 3 din 5 —
          Reconstruire situații"), crossfading 200ms between steps. The
          desktop circle-row below is untouched (hidden sm:flex). */}
      <div
        className={`sm:hidden pt-6 px-1 transition-opacity duration-300 ${completing ? "opacity-0 pointer-events-none" : ""}`}
        data-testid="upload-pipeline-mobile"
      >
        <div className="flex items-center gap-1.5" role="progressbar"
          aria-valuemin={1} aria-valuemax={steps.length}
          aria-valuenow={Math.min(currentOrdinal + 1, steps.length)}
          aria-label={t("productsX.empty.pipelineAria")}
        >
          {steps.map((label, i) => (
            <span
              key={label}
              className={`h-1.5 flex-1 rounded-full transition-colors duration-200 ease-out ${
                i < currentOrdinal
                  ? "ask-ai-anim-fill [animation-duration:10s]"
                  : i === currentOrdinal
                  ? "bg-brand/45"
                  : "bg-rule/50"
              }`}
            />
          ))}
        </div>
        <div className="relative h-[38px] mt-3 text-center" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={Math.min(currentOrdinal, steps.length - 1)}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="text-[13px] font-medium text-ink"
            >
              <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-mute block mb-0.5">
                {t("scan.stepOf", {
                  current: Math.min(currentOrdinal + 1, steps.length),
                  total: steps.length,
                })}
              </span>
              {trText(steps[Math.min(currentOrdinal, steps.length - 1)])}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
      <ol
        className="relative w-full max-w-[720px] mx-auto hidden sm:flex items-start justify-between gap-2 pt-8"
        aria-label={t("productsX.empty.pipelineAria")}
        data-testid="upload-pipeline"
      >
        {/* Progress connector — rendered as ONE SEGMENT PER GAP between
            adjacent circles, inset 22px on each side of the h-10 (40px) circles
            so the bar NEVER runs under a circle. A completed segment (both its
            circles reached — `i < currentOrdinal`) carries the animated brand
            gradient (ask-ai-anim-fill); pending gaps stay a faint rail. Shared
            by every scanning screen (dashboard + products).

            top-[50px] centers the 4px bar on the 40px circles' center line:
            the ol's pt-8 (32px) pushes the circles down, so their center sits
            at 32 + 20 = 52px and the bar starts at 52 − 2. MUST move in step
            with that padding — the bars are positioned against the ol, not
            the circles, which is exactly how they drifted when pt-8 landed
            without this offset following (operator-reported misalignment). */}
        {steps.length > 1 &&
          steps.slice(0, -1).map((_, i) => {
            const segFilled = i < currentOrdinal;
            return (
              <span
                key={`seg-${i}`}
                aria-hidden
                className={`absolute top-[50px] h-1 rounded-full transition-colors duration-500 ${
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
                {trText(label)}
              </span>
            </li>
          );
        })}
      </ol>
      {/* Live status line — crossfades between the rotating detail lines so
          each change registers as movement. Fixed height so the layout below
          (sphere spacer) never shifts as lines swap. */}
      <div aria-live="polite" className={`relative h-[20px] text-center ${completing ? "max-sm:opacity-0" : ""} transition-opacity duration-300`}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={statusLabel}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 0.5, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="text-[13px] font-medium text-ink"
          >
            {statusLabel}
          </motion.p>
        </AnimatePresence>
      </div>
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
      {/* Scan complete — the sphere first pulls every orb into the core
          (~1s, see the finale effect above), then fades; this centered card
          fades in over the same space once that sequence is underway. The
          1.2s delay = 1s convergence + the fade's first beat. Only when the
          caller wired onViewResults. */}
      {completing && (
        <motion.div
          key="scan-complete"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 1.2, ease: "easeOut" }}
          className="absolute inset-x-0 z-40 flex flex-col items-center gap-3 text-center px-5"
          style={{ top: "calc(50% - 96px)" }}
          data-testid="scan-complete-card"
        >
          {/* Draw-in checkmark (native-mobile pass): the circle sweeps and
              the check strokes in — the finish should feel like a reward,
              not a static icon. Pure SVG stroke animation (see
              .scan-check-* in index.css), starts with the card's fade. */}
          <span className="relative inline-flex items-center justify-center h-16 w-16 rounded-full bg-brand/12">
            <svg viewBox="0 0 52 52" className="h-12 w-12" aria-hidden>
              <circle
                cx="26" cy="26" r="23" fill="none"
                className="scan-check-circle"
              />
              <path
                d="M15 27l7.5 7.5L37.5 19" fill="none"
                className="scan-check-mark"
              />
            </svg>
          </span>
          <h3 className="text-[20px] font-semibold text-ink">{resolvedCompleteTitle}</h3>
          <p className="text-[13.5px] text-ink-soft max-w-[340px] leading-relaxed">
            {resolvedCompleteBody}
          </p>
          <button
            type="button"
            onClick={onViewResults}
            data-testid="scan-view-results"
            className="
              mt-2 inline-flex items-center justify-center
              w-full max-w-[360px] min-h-[52px] sm:w-auto sm:min-h-0 sm:h-10 px-6
              rounded-xl ask-ai-anim-fill [animation-duration:10s]
              border border-brand/40 text-ink text-[14px] sm:text-[13px] font-semibold
              hover:border-brand/60 active:scale-[0.98] transition-[transform,border-color] duration-150
            "
          >
            {resolvedCompleteCta}
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
                  {t("scan.cancelPrompt")}
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
                    {t("scan.keepAnalyzing")}
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
                    {t("scan.yesCancel")}
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
                  {t("common.cancel")}
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
