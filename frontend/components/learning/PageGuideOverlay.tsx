// F5.0 Step 3 (CFO AI Learn) — Page guide overlay.
//
// A premium step-by-step page tour with a soft spotlight + captioned
// callout. Used as the "Guide me through the balance sheet" flagship
// demo and reused for every other page that defines a guide.
//
// API:
//   <PageGuideOverlay
//     open={boolean}
//     pageId="balance-sheet"
//     title="Reading the Balance Sheet"
//     steps={[
//       { selector: '[data-guide="assets"]', title: "Assets", body: "…" },
//       ...
//     ]}
//     onClose={() => …}
//   />
//
// Behavior:
//   · For each step, finds the target element via querySelector, reads
//     its bounding rect, paints a 16px-padded rounded "spotlight" mask
//     plus a caption card anchored to the side opposite the most empty
//     viewport space.
//   · Next / Back / Skip controls. Last step → "Done".
//   · Esc closes; backdrop click closes; route change closes via the
//     parent unmounting.
//   · Marks pageId as seen in the LearningMode store on completion.
//   · On reduced-motion users, skips the fade animations.
//
// Performance:
//   · One absolutely-positioned overlay element. No portal — renders in
//     the page tree at the call site. z-index 200 (above stack popovers).
//   · Spotlight position recalculated on viewport resize + scroll via
//     RAF-throttled handler.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useLearningMode } from "@/stores/learningMode";
import { cn } from "@/lib/utils";

export interface GuideStep {
  /** Optional CSS selector to spotlight. When omitted the step displays
   *  as a centered modal (intro / outro steps). */
  selector?: string;
  /** Section eyebrow shown above the title. */
  eyebrow?: string;
  title: string;
  body: ReactNode;
}

interface Props {
  open: boolean;
  pageId: string;
  /** Top-of-tour title (shown on the intro step + each subsequent card
   *  small-print). */
  title: string;
  steps: GuideStep[];
  onClose: () => void;
}

export function PageGuideOverlay({ open, pageId, title, steps, onClose }: Props) {
  const { markTutorialSeen } = useLearningMode();
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Reset to step 0 every time the overlay reopens.
  useEffect(() => {
    if (open) setIdx(0);
  }, [open]);

  // Measure the active step's target on every step change, viewport
  // resize, and scroll. Uses RAF to throttle.
  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const step = steps[idx];
    function measure() {
      if (!step?.selector) {
        setRect(null);
        return;
      }
      const el = document.querySelector(step.selector) as HTMLElement | null;
      if (!el) {
        setRect(null);
        return;
      }
      // Scroll the target into the middle third of the viewport so the
      // caption card has somewhere to live.
      const targetRect = el.getBoundingClientRect();
      const targetTop = targetRect.top + window.scrollY;
      const desiredTop = targetTop - window.innerHeight / 3;
      window.scrollTo({ top: desiredTop, behavior: "smooth" });
      // Wait one frame for the scroll, then read final rect.
      requestAnimationFrame(() => {
        setRect((el as HTMLElement).getBoundingClientRect());
      });
    }
    measure();

    let raf = 0;
    function schedule() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    }
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", schedule, {
      passive: true,
      capture: true,
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
    };
  }, [open, idx, steps]);

  // Esc / nav handlers.
  const handleClose = useCallback(() => {
    markTutorialSeen(pageId);
    onClose();
  }, [markTutorialSeen, pageId, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
      if (e.key === "ArrowRight") setIdx((i) => Math.min(i + 1, steps.length - 1));
      if (e.key === "ArrowLeft") setIdx((i) => Math.max(i - 1, 0));
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, steps.length, handleClose]);

  if (!open) return null;
  const step = steps[idx];
  if (!step) return null;

  const isFirst = idx === 0;
  const isLast = idx === steps.length - 1;

  // Spotlight pad (px around the target rect) + caption position.
  const PAD = 12;
  const spotlight = rect
    ? {
        top: rect.top - PAD,
        left: rect.left - PAD,
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : null;

  // Place caption on the side with more space. Default to below.
  const captionAbove =
    spotlight != null && spotlight.top + spotlight.height + 280 > window.innerHeight;
  const captionTop = spotlight
    ? captionAbove
      ? Math.max(16, spotlight.top - 200)
      : Math.min(window.innerHeight - 240, spotlight.top + spotlight.height + 16)
    : 0;

  return (
    <AnimatePresence>
      <motion.div
        key="guide-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-[200]"
        data-testid="page-guide-overlay"
        data-page-guide={pageId}
        onClick={handleClose}
      >
        {/* Backdrop with spotlight cut-out via SVG mask */}
        <svg
          width="100%"
          height="100%"
          className="absolute inset-0"
          aria-hidden
        >
          <defs>
            <mask id={`guide-mask-${pageId}`}>
              <rect width="100%" height="100%" fill="white" />
              {spotlight && (
                <rect
                  x={spotlight.left}
                  y={spotlight.top}
                  width={spotlight.width}
                  height={spotlight.height}
                  rx={14}
                  fill="black"
                />
              )}
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="rgba(8,12,14,0.72)"
            mask={`url(#guide-mask-${pageId})`}
          />
        </svg>

        {/* Spotlight ring (independent so it can pulse) */}
        {spotlight && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            style={{
              position: "absolute",
              top: spotlight.top,
              left: spotlight.left,
              width: spotlight.width,
              height: spotlight.height,
              borderRadius: 14,
              pointerEvents: "none",
              boxShadow: "0 0 0 1.5px hsl(165, 80%, 60%)",
            }}
          />
        )}

        {/* Caption card */}
        <motion.div
          key={`step-${idx}`}
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.98 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          style={
            spotlight
              ? {
                  position: "absolute",
                  top: captionTop,
                  left: Math.max(
                    16,
                    Math.min(
                      window.innerWidth - 396,
                      spotlight.left + spotlight.width / 2 - 190,
                    ),
                  ),
                  width: 380,
                  maxWidth: "calc(100vw - 32px)",
                }
              : {
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  width: 420,
                  maxWidth: "calc(100vw - 32px)",
                }
          }
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "rounded-2xl",
            "bg-[rgba(18,20,22,0.92)] backdrop-blur-2xl",
            "border border-white/[0.08]",
            "shadow-[0_24px_80px_-12px_rgba(0,0,0,0.65),inset_0_0_0_1px_rgba(255,255,255,0.04)]",
            "p-5",
            "text-white",
          )}
          data-testid="page-guide-card"
        >
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {step.eyebrow && (
                <div className="text-[10px] uppercase tracking-[0.14em] text-[hsl(165,75%,60%)] font-semibold mb-1.5">
                  {step.eyebrow}
                </div>
              )}
              <h3 className="text-[16px] leading-tight font-semibold tracking-tight">
                {step.title}
              </h3>
            </div>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close guide"
              className="
                w-7 h-7 rounded-full
                bg-white/[0.06] hover:bg-white/[0.14]
                grid place-items-center
                text-white/75 hover:text-white
                transition-colors
                shrink-0 -mt-0.5 -mr-0.5
              "
            >
              <X className="w-3 h-3" />
            </button>
          </header>

          <div className="mt-3 text-[13.5px] leading-relaxed text-white/85">
            {step.body}
          </div>

          <footer className="mt-5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              {steps.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1 rounded-full transition-all",
                    i === idx
                      ? "w-5 bg-[hsl(165,75%,60%)]"
                      : "w-1.5 bg-white/25",
                  )}
                />
              ))}
              <span className="ml-2 text-[10.5px] uppercase tracking-[0.1em] text-white/45">
                {title} · {idx + 1}/{steps.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {!isFirst && (
                <button
                  type="button"
                  onClick={() => setIdx((i) => i - 1)}
                  className="
                    inline-flex items-center gap-1
                    text-[12px] font-medium
                    text-white/70 hover:text-white
                    px-2.5 py-1.5 rounded-md
                    transition-colors
                  "
                  data-testid="page-guide-back"
                >
                  <ChevronLeft className="w-3 h-3" /> Back
                </button>
              )}
              {!isLast ? (
                <button
                  type="button"
                  onClick={() => setIdx((i) => i + 1)}
                  className="
                    inline-flex items-center gap-1
                    text-[12px] font-semibold
                    text-[rgba(18,20,22,0.95)] bg-white hover:bg-white/90
                    px-3 py-1.5 rounded-md
                    transition-colors
                  "
                  data-testid="page-guide-next"
                >
                  Next <ChevronRight className="w-3 h-3" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleClose}
                  className="
                    inline-flex items-center gap-1
                    text-[12px] font-semibold
                    text-[rgba(18,20,22,0.95)] bg-[hsl(165,75%,60%)] hover:bg-[hsl(165,75%,55%)]
                    px-3 py-1.5 rounded-md
                    transition-colors
                  "
                  data-testid="page-guide-done"
                >
                  Got it
                </button>
              )}
            </div>
          </footer>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
