// F5.0 Phase 1.5 — The 2026-grade learning popover.
//
// Desktop: floating panel anchored to the trigger rect, frosted-glass
// chrome, framer-motion enter/exit, manual outside-click via pointerdown.
// Mobile: full-width bottom sheet with drag-to-dismiss via vaul.
//
// Performance:
//   · ONE motion.div per popover (the container). Inner sections fade in
//     via CSS transition tied to a progressive-rendering state machine
//     so the first paint is just header+value (≤16ms after click).
//   · Concept lookup is in-memory cache (see useConcept) — no async on
//     the open path.
//   · Outside-tap uses pointerdown with capture + a one-RAF delay so the
//     opening click doesn't immediately close us.
//
// Recursion:
//   · Receives its data via PopoverStackEntry — knows nothing about
//     where in the stack it lives, except `depth` and `isTop`.
//   · Back button calls onBack (pops one level). Close calls onClose
//     (clears all). Esc → onBack (handled in PopoverStackProvider).
//   · Parent stack entries fade slightly when a new one stacks on top.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion } from "framer-motion";
import {
  ChevronLeft,
  X,
  Sparkles,
  Calculator,
  FileText,
  MessageCircle,
  ArrowRight,
} from "lucide-react";
import { Drawer } from "vaul";
import { useNavigate } from "react-router-dom";
import { useConcept } from "@/hooks/useConcept";
import { useLearningMode } from "@/stores/learningMode";
import { useReportingMetrics } from "./ReportingContextProvider";
// LEARN-FIX-1 — PopoverStackRenderer is mounted at the App root, OUTSIDE
// ReportingContextProvider (which lives deep in FinancialStatements).
// That means useReportingMetrics() returns the empty default context
// and lineItems is always []. To break that boundary without a full
// provider-tree refactor, the popover reads the active period directly
// from useActivePeriod() — a URL-bound zustand+ReactQuery hook that
// works regardless of where it's invoked. Whoever wins the eventual
// refactor (move PopoverStackRenderer inside the provider, OR migrate
// the provider to a global store) just removes this direct read.
import { useActivePeriod } from "@/lib/activePeriod";
// LEARN-FIX-2 — same workaround for the ReportingMetrics snapshot
// (revenue / ebitda / total_debt etc.) so the FORMULA path inside
// the popover renders real operand values. Without this the EBIT
// popover showed `Revenue 0 RON − COGS 0 RON − OpEx 0 RON`.
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePopoverStack, type PopoverStackEntry } from "./PopoverStackProvider";
import { InteractiveFormula } from "./InteractiveFormula";
import { formatValue } from "./valueFormat";
import {
  staticSourceAccounts,
  resolveSourceAccountsForConcept,
  assertConceptCompositionMatches,
  type ResolvedSourceAccount,
} from "@/lib/learning/sourceAccountMap";
import { CompositionBreakdown } from "./CompositionBreakdown";
import { StaticInterpretation } from "./StaticInterpretation";
import { cn } from "@/lib/utils";
import type {
  ValueFormat,
  FormulaSpec,
  AccountTrace,
} from "@/lib/learning/concepts/_schema";

interface Props {
  entry: PopoverStackEntry;
  /** 0-indexed depth in the stack. 0 = bottom-most. */
  depth: number;
  /** Is this the foreground popover? */
  isTop: boolean;
  /** Total stack size — used to dim non-top popovers. */
  stackSize: number;
  onBack: () => void;
  onClose: () => void;
}

export function LearningPopover(props: Props) {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileSheet {...props} />;
  return <DesktopPanel {...props} />;
}

// ─── Desktop floating panel ─────────────────────────────────────────

function DesktopPanel({
  entry,
  depth,
  isTop,
  stackSize,
  onBack,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position the panel relative to the trigger rect. Re-runs on mount
  // and on window resize / scroll (throttled to RAF).
  useLayoutEffect(() => {
    function computePosition() {
      const rect = entry.triggerRect;
      const container = containerRef.current;
      if (!container) return;
      const panelWidth = container.offsetWidth;
      const panelHeight = container.offsetHeight;
      const margin = 12;
      const stackOffset = depth * 6; // each level pushes down 6px

      if (!rect) {
        // No trigger rect — center on viewport.
        setPos({
          top: Math.max(margin, (window.innerHeight - panelHeight) / 2),
          left: Math.max(margin, (window.innerWidth - panelWidth) / 2),
        });
        return;
      }

      // Prefer below the trigger, else above.
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      let top: number;
      if (spaceBelow >= panelHeight + margin) {
        top = rect.bottom + 8 + stackOffset;
      } else if (spaceAbove >= panelHeight + margin) {
        top = rect.top - panelHeight - 8 + stackOffset;
      } else {
        // Squeeze.
        top = Math.max(margin, window.innerHeight - panelHeight - margin);
      }
      // Horizontally clamp into viewport, prefer aligned with trigger left.
      const left = Math.min(
        Math.max(margin, rect.left + rect.width / 2 - panelWidth / 2),
        window.innerWidth - panelWidth - margin,
      );
      setPos({ top, left });
    }

    computePosition();

    let raf = 0;
    function schedule() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(computePosition);
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
  }, [entry.triggerRect, depth]);

  // Outside-click handler — only the TOP popover gets it. Uses
  // pointerdown + capture + a single-RAF skip so we don't auto-close on
  // the click that just opened us. Tapping a value INSIDE the popover
  // pushes a new entry (handled in InteractiveFormula) — those events
  // happen on a descendant node so `contains` keeps us open.
  useEffect(() => {
    if (!isTop) return;
    let armed = false;
    const arm = requestAnimationFrame(() => {
      armed = true;
    });
    function handler(e: PointerEvent) {
      if (!armed) return;
      const c = containerRef.current;
      if (!c) return;
      if (c.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("pointerdown", handler, { capture: true });
    return () => {
      cancelAnimationFrame(arm);
      document.removeEventListener("pointerdown", handler, { capture: true });
    };
  }, [isTop, onClose]);

  return (
    <>
      {/* Backdrop only behind the bottom-most popover so the stack itself
       *  isn't obscured by repeated darkening. Click-through? No — the
       *  backdrop catches stray taps. */}
      {depth === 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[140] bg-black/15 pointer-events-none"
          aria-hidden
        />
      )}
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0, y: 6, scale: 0.97 }}
        animate={{
          opacity: isTop ? 1 : 0.55,
          y: 0,
          scale: 1,
          filter: isTop ? "blur(0px)" : "blur(0.5px)",
        }}
        exit={{ opacity: 0, y: 4, scale: 0.98 }}
        transition={{
          duration: 0.18,
          ease: [0.16, 1, 0.3, 1],
        }}
        style={pos ?? { opacity: 0 }}
        className={cn(
          "fixed z-[150]",
          "w-[380px] max-w-[calc(100vw-24px)]",
          // LEARN-FIX-3 (2026-06-14): cap height + scroll internally so
          // tall content (e.g. Total Debt composition + Ask CFO AI footer)
          // doesn't extend past the viewport. The outer rounded shell
          // keeps its visual clipping via `overflow-hidden`; the inner
          // `learn-pop-content` div handles the scroll.
          "max-h-[80dvh]",
          "rounded-2xl",
          "bg-[rgba(18,20,22,0.86)] backdrop-blur-2xl",
          "border border-white/[0.08]",
          "shadow-[0_24px_80px_-12px_rgba(0,0,0,0.65),inset_0_0_0_1px_rgba(255,255,255,0.04)]",
          "overflow-hidden",
          "pointer-events-auto",
          "text-white",
          "flex flex-col",
        )}
        role="dialog"
        aria-modal="false"
        data-testid={`learn-pop-${entry.conceptKey}`}
        data-stack-depth={depth}
        data-stack-top={isTop ? "1" : "0"}
      >
        <PopoverContent
          entry={entry}
          depth={depth}
          stackSize={stackSize}
          onBack={onBack}
          onClose={onClose}
        />
      </motion.div>
    </>
  );
}

// ─── Mobile bottom sheet (vaul) ─────────────────────────────────────

function MobileSheet({
  entry,
  depth,
  isTop,
  stackSize,
  onBack,
  onClose,
}: Props) {
  // Vaul handles drag-to-dismiss. Each stack entry is its own drawer;
  // they slide up over each other. Dismissing the top fires onBack
  // (= pop), not onClose, so the stack peels back one level at a time.
  // Tapping the X header button calls onClose to nuke the stack.
  const [open, setOpen] = useState(true);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // Vaul fires this on drag-down dismiss OR backdrop tap.
      // Use a microtask so the close animation completes first.
      queueMicrotask(() => {
        // If we're the top, pop one. If not (rare — shouldn't happen on
        // mobile since only top is reachable), close all.
        if (isTop) onBack();
        else onClose();
      });
    }
  };

  // LEARN-MOBILE (2026-06-16) — Nested sheets stack 1.5dvh higher per
  // level. dvh units survive iOS Safari address-bar collapse; px-based
  // marginBottom did not because the sheet's anchor is bottom-0.
  const stackLiftDvh = (stackSize - 1 - depth) * 1.5;

  return (
    <Drawer.Root
      open={open}
      onOpenChange={handleOpenChange}
      // Only the base sheet scales the background. Nested sheets would
      // double-scale and over-darken the page underneath.
      shouldScaleBackground={depth === 0}
    >
      <Drawer.Portal>
        {/* Backdrop — base sheet only. Nested sheets sit on top of the
            base's backdrop so we don't compound dimming or get a
            confusing fade-in when peeling back the stack. */}
        {depth === 0 && (
          <Drawer.Overlay
            className={cn(
              "fixed inset-0 z-[140]",
              "bg-black/55 backdrop-blur-sm",
            )}
          />
        )}
        <Drawer.Content
          className={cn(
            // Z-stack: nested sheets sit above earlier ones.
            "fixed bottom-0 inset-x-0",
            "w-full max-w-full",
            "bg-[rgba(18,20,22,0.96)] backdrop-blur-2xl",
            "rounded-t-3xl",
            "border-t border-white/[0.08]",
            // F2/F6: dvh keeps the sheet bounded against the visible
            // viewport (handles iOS Safari address-bar chrome). Use a
            // FIXED height (not max-h-only) so the inner flex column
            // can give the scroll region a real `flex-1 min-h-0`.
            "h-[92dvh] max-h-[92dvh]",
            // F2: clear the home-indicator gesture zone on iPhones.
            // `env(safe-area-inset-bottom)` is 0 on devices without one.
            "pb-[env(safe-area-inset-bottom)]",
            "shadow-[0_-12px_60px_-8px_rgba(0,0,0,0.6)]",
            "flex flex-col",
            "text-white",
          )}
          style={{
            // Nested sheets rise via translate so they cascade visually
            // without disturbing the bottom anchor. depth=0 stays put.
            transform:
              stackLiftDvh > 0 ? `translateY(-${stackLiftDvh}dvh)` : undefined,
            zIndex: 150 + depth,
          }}
          data-testid={`learn-pop-mobile-${entry.conceptKey}`}
          data-stack-depth={depth}
        >
          {/* Drag handle — vaul auto-drags from this header zone. We
              do NOT pass data-vaul-no-drag here, so swipe-down on the
              handle dismisses the sheet. */}
          <div
            className="flex justify-center pt-3 pb-2 shrink-0"
            aria-hidden
          >
            <div className="w-9 h-1 rounded-full bg-white/25" />
          </div>
          {/* F7: scrollable body marked `data-vaul-no-drag` — internal
              scroll wins inside the content area. The user can scroll
              freely; sheet only dismisses via handle drag or backdrop
              tap. `overscroll-contain` stops scroll bubble to the
              underlying page. `flex-1 min-h-0` gives the scroll region
              the leftover height inside the fixed-height parent. */}
          <div
            data-vaul-no-drag
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
          >
            <PopoverContent
              entry={entry}
              depth={depth}
              stackSize={stackSize}
              onBack={onBack}
              onClose={onClose}
            />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

// ─── Shared popover content (header → value → formula → benchmark → narrative)

function PopoverContent({
  entry,
  depth,
  stackSize,
  onBack,
  onClose,
}: {
  entry: PopoverStackEntry;
  depth: number;
  stackSize: number;
  onBack: () => void;
  onClose: () => void;
}) {
  const { concept, context } = useConcept(entry.conceptKey);
  const {
    metrics: providerMetrics,
    currency,
    locale,
    lineItems: providerLineItems,
  } = useReportingMetrics();
  // LEARN-FIX-1 — direct read of active-period lineItems so the
  // composition view works even though the popover renderer sits
  // outside ReportingContextProvider. Prefer the provider's lineItems
  // when populated (host page wanted explicit override); otherwise
  // fall through to the URL-driven active period.
  const activePeriod = useActivePeriod();
  const lineItems =
    providerLineItems && providerLineItems.length > 0
      ? providerLineItems
      : activePeriod.lineItems;
  // LEARN-FIX-2 — same fallback for metrics. When the provider is
  // missing (PopoverStackRenderer at App root vs ReportingContextProvider
  // deep in FinancialStatements), the popover's formula computation
  // reads from this fallback. Without it, EBIT showed Revenue 0 / COGS 0.
  const fallbackMetrics = useMemo(
    () => buildReportingMetricsSnapshot(activePeriod.statements ?? null),
    [activePeriod.statements],
  );
  const hasProviderMetrics =
    providerMetrics && Object.keys(providerMetrics).length > 0;
  const metrics = hasProviderMetrics ? providerMetrics : fallbackMetrics;

  // Progressive section rendering — first frame = header + value;
  // second frame = formula; third frame = benchmark + narrative.
  // Keeps the perceived open latency ≤16ms even when the formula has
  // 5+ nested components.
  // F5.0 Step 1.7 — progressive render removed.
  //
  // The earlier RAF-staged render (stage 0 → 1 → 2) shaved a frame off
  // the first-paint cost, but a closure-capture race with Framer Motion's
  // mount sequence left stage stuck at 0 on every depth>0 popover —
  // breaking the recursion's formula + Ask CFO AI sections. The fix is
  // to just render everything in one pass. The popover is ~6 short
  // sections; React 18 + Vite output handles this in well under the
  // 100ms target even on mid-range hardware. Re-introduce staging only
  // if a real perf budget breach shows up.
  const stage = 2;

  // Resolve format + computation. If the concept isn't registered we
  // still render a graceful fallback (the "concept not registered"
  // message in the body) so we never crash the page.
  const fmt: ValueFormat =
    entry.formatOverride ??
    inferFormatFromKey(entry.conceptKey, concept?.category);
  const fullCtx = {
    ...context,
    metrics,
    currency,
    locale,
    // LEARN-FIX-1 — engine per-account amounts available to concept
    // computation() functions + the composition view.
    lineItems,
  };
  const formula: FormulaSpec | null = concept?.computation
    ? concept.computation(fullCtx, entry.value)
    : null;
  // F5.0 Phase 6 — when the concept exposes a sourceTrace() function,
  // resolve it now so we can render a public-market source block below.
  // RAS concepts don't define sourceTrace (they use staticSourceAccounts
  // instead) so this stays null for them and the legacy trial-balance
  // block continues to render.
  const sourceTrace = concept?.sourceTrace
    ? concept.sourceTrace(fullCtx, entry.value)
    : null;

  // Sentiment classifier — feeds the badge + the narrative tint.
  const sentiment = concept?.interpretation
    ? concept.interpretation.getSentiment(entry.value, fullCtx)
    : "neutral";
  const narrative = concept?.interpretation
    ? concept.interpretation.getNarrative(entry.value, fullCtx)
    : null;

  // Choose definition + name in active locale, with English fallback.
  const name = concept?.name[locale] ?? concept?.name.en ?? entry.conceptKey;
  const definition =
    concept?.shortDefinition[locale] ?? concept?.shortDefinition.en ?? null;
  // Plain-English layer (F5.0 spec: friendly version above finance-grade definition).
  const plainEnglish =
    concept?.plainEnglish?.[locale] ?? concept?.plainEnglish?.en ?? null;
  const { mode: learningMode } = useLearningMode();
  const showPlainEnglish = plainEnglish && learningMode !== "off";

  return (
    <div className="learn-pop-content flex-1 min-h-0 overflow-y-auto overscroll-contain">
      {/* ── Header ────────────────────────────────────────────────── */}
      <header className="relative px-5 pt-5 pb-3 flex items-start justify-between gap-3">
        {/* Subtle top edge highlight */}
        <div
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          {depth > 0 && (
            <button
              type="button"
              onClick={onBack}
              data-testid="learn-pop-back"
              className="
                text-[10.5px] uppercase tracking-[0.14em] font-medium
                text-white/55 hover:text-white/85
                inline-flex items-center gap-1 mb-1.5
                transition-colors
              "
            >
              <ChevronLeft className="w-3 h-3" />
              Back
            </button>
          )}
          <h3 className="text-[15.5px] font-medium leading-tight tracking-[-0.005em] text-white">
            {name}
          </h3>
          {concept?.category && (
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/45 mt-1.5 font-medium">
              {concept.category}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid="learn-pop-close"
          aria-label="Close"
          className="
            w-7 h-7 rounded-full
            bg-white/[0.06] hover:bg-white/[0.14]
            grid place-items-center
            text-white/75 hover:text-white
            transition-colors
            shrink-0
            -mt-0.5 -mr-0.5
          "
        >
          <X className="w-3 h-3" />
        </button>
      </header>

      {/* ── Headline value ────────────────────────────────────────── */}
      <div className="px-5 py-4 border-b border-white/[0.06]">
        <div className="text-[32px] font-light tabular-nums tracking-[-0.012em] leading-none text-white">
          {formatValue(entry.value, fmt, { currency, full: false })}
        </div>
        {sentiment !== "neutral" && (
          <SentimentBadge sentiment={sentiment} />
        )}
      </div>

      {/* ── Plain-English layer (guided/subtle modes only) ─────────── */}
      {showPlainEnglish && (
        <div
          className="px-5 py-4 border-b border-white/[0.06] bg-[hsl(173,57%,55%)]/[0.04]"
          data-testid="learn-pop-plain-english"
        >
          <div className="text-[10px] uppercase tracking-[0.14em] text-[hsl(173,57%,65%)]/80 font-medium mb-1.5">
            In plain English
          </div>
          <p className="text-[13.5px] leading-relaxed text-white/90">
            {plainEnglish}
          </p>
        </div>
      )}

      {/* ── Definition ────────────────────────────────────────────── */}
      {definition && (
        <div className="px-5 py-4 border-b border-white/[0.06]">
          {showPlainEnglish && (
            <div className="text-[10px] uppercase tracking-[0.14em] text-white/35 font-medium mb-1.5">
              Formally
            </div>
          )}
          <p className="text-[13px] leading-relaxed text-white/75">
            {definition}
          </p>
        </div>
      )}

      {/* ── Computation (formula OR source-account trace) ─────────── */}
      {stage >= 1 && formula && formula.tokens.length > 0 && (
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <SectionLabel icon={<Calculator className="w-3 h-3" />} text="How it's computed" />
          <div className="mt-3">
            <InteractiveFormula spec={formula} />
          </div>
          <p className="text-[10.5px] text-white/45 mt-3">
            Tap any number to drill into its components.
          </p>
        </div>
      )}

      {/* Fallback: plain inlineFormula when no computation registered. */}
      {stage >= 1 && (!formula || formula.tokens.length === 0) && concept?.inlineFormula && (
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <SectionLabel icon={<Calculator className="w-3 h-3" />} text="Formula" />
          <div className="mt-2 font-mono text-[13px] text-white/85 tabular-nums">
            {concept.inlineFormula}
          </div>
        </div>
      )}

      {/* ── Source accounts composition ──
       *  LEARN-FIX-1 (2026-06-08) — Replaces the flat list with a
       *  proportional bar view powered by the engine's real per-account
       *  amounts (from period.lineItems, joined via
       *  resolveSourceAccountsForConcept). Filters zero accounts,
       *  sorts largest first. Falls back to the backend-supplied
       *  formula.trace.accounts when present (concept can override),
       *  else to the static map (codes + labels only, amount = 0 —
       *  the empty-period state). */}
      {stage >= 1 && (() => {
        // Prefer the concept's own backend trace when it explicitly
        // shipped per-account amounts via formula.trace.accounts.
        const backendAccounts = formula?.trace?.accounts ?? [];
        let composition: ResolvedSourceAccount[];

        if (backendAccounts.length > 0) {
          // Adopt the backend list verbatim — concept knows what it
          // wants to expose. Wrap into ResolvedSourceAccount shape.
          composition = backendAccounts.map((a) => ({
            code: a.code,
            label: a.label,
            amount: a.amount,
            magnitude: Math.abs(a.amount),
            side: a.side,
          }));
        } else {
          // Join the static map with engine line-item amounts.
          composition = resolveSourceAccountsForConcept(
            entry.conceptKey,
            fullCtx.lineItems ?? [],
          );
        }

        if (composition.length === 0) {
          // No registered accounts AND no backend trace — fall through
          // to the static skeleton so the popover still surfaces codes
          // when the period is unhydrated.
          const fallback = staticSourceAccounts(entry.conceptKey);
          if (fallback.length === 0) return null;
          return (
            <div className="px-5 py-4 border-b border-white/[0.06]">
              <SectionLabel icon={<FileText className="w-3 h-3" />} text="Source in trial balance" />
              <p className="text-[11.5px] text-white/55 mt-2 mb-2">
                Source accounts will surface here once a period is loaded.
              </p>
              <div className="space-y-0.5">
                {fallback.map((acc) => (
                  <SourceAccountRow key={acc.code} account={acc} currency={currency} />
                ))}
              </div>
            </div>
          );
        }

        // LEARN-FIX-1 — DEV-mode sanity gate against silent regressions.
        assertConceptCompositionMatches(
          entry.conceptKey,
          entry.value,
          composition,
        );

        return (
          <>
            <div className="px-5 py-4 border-b border-white/[0.06]">
              <SectionLabel
                icon={<FileText className="w-3 h-3" />}
                text="Composition"
              />
              <div className="mt-3">
                <CompositionBreakdown
                  accounts={composition}
                  currency={currency}
                  locale={locale}
                />
              </div>
              <p className="text-[10.5px] text-white/45 mt-3 leading-snug">
                Sorted largest first. Accounts with no activity this period are hidden.
              </p>
            </div>
            {/* LEARN-FIX-1 follow-on — composition-anchored "What it means"
             *  insight line. The component itself decides whether to render
             *  (returns null if there's no template for the concept or the
             *  composition is too thin to interpret). */}
            <StaticInterpretation
              conceptKey={entry.conceptKey}
              accounts={composition}
              locale={locale}
            />
          </>
        );
      })()}

      {/* ── F5.0 Phase 6 — Source trace for non-trial-balance variants. ──
       *  Renders provider + dataset + as_of + confidence for public-market
       *  concepts (market cap, P/E, FCF yield, stock price, net debt, risk
       *  score). For calculated concepts, renders the derivedFrom prose. */}
      {stage >= 1 && sourceTrace && sourceTrace.sourceType !== "trial_balance_account" && (
        <SourceTraceBlock trace={sourceTrace} />
      )}

      {/* ── Benchmark micro-bar ───────────────────────────────────── */}
      {stage >= 2 && context.benchmark && (
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <SectionLabel
            icon={<Sparkles className="w-3 h-3" />}
            text="Where you sit"
          />
          <div className="mt-3">
            <BenchmarkBar
              value={entry.value}
              benchmark={context.benchmark}
              format={fmt}
              currency={currency}
            />
          </div>
        </div>
      )}

      {/* ── Narrative ─────────────────────────────────────────────── */}
      {stage >= 2 && narrative && (
        <div
          className={cn(
            "px-5 py-4",
            sentiment === "positive" && "bg-[hsl(173,57%,50%)]/[0.04]",
            sentiment === "negative" && "bg-[hsl(0,75%,60%)]/[0.04]",
            sentiment === "neutral" && "bg-white/[0.02]",
          )}
        >
          <div className="flex items-start gap-2.5">
            <Sparkles
              className={cn(
                "w-3.5 h-3.5 shrink-0 mt-0.5",
                sentiment === "positive" && "text-[hsl(173,57%,68%)]",
                sentiment === "negative" && "text-[hsl(0,75%,72%)]",
                sentiment === "neutral" && "text-white/55",
              )}
            />
            <p className="text-[13px] leading-relaxed text-white/85">
              {narrative}
            </p>
          </div>
        </div>
      )}

      {/* ── LEARN-FIX-1 follow-on (2026-06-13) ────────────────────────
       *  "See in <statement>" navigation CTA — when the concept has
       *  source accounts, give the user a one-tap path to the
       *  populated row(s) in the P&L or Balance Sheet table. Picks
       *  the destination by inspecting the first matching line item's
       *  `statement` field (PL vs BS); falls back to the dashboard
       *  Statements tab when ambiguous. Renders directly above the
       *  Ask CFO AI footer so both surface their actions in a
       *  predictable order: navigate first, then conversation. */}
      {stage >= 2 && concept && (
        <SeeInStatementAction
          conceptKey={entry.conceptKey}
          lineItems={lineItems}
          onLeave={onClose}
        />
      )}

      {/* ── Ask CFO AI footer — universal action ──────────────────── */}
      {stage >= 2 && concept && (
        <AskCfoAiAction
          conceptName={name}
          conceptKey={entry.conceptKey}
          value={entry.value}
          format={fmt}
          currency={currency}
          onLeave={onClose}
        />
      )}

      {/* Graceful fallback when concept not found in registry. */}
      {!concept && (
        <div className="px-5 py-4 text-[13px] text-white/55">
          Concept{" "}
          <code className="font-mono text-white/75">{entry.conceptKey}</code>{" "}
          is not registered. Tap{" "}
          <button
            onClick={onClose}
            className="underline underline-offset-2 hover:text-white/85"
          >
            Close
          </button>{" "}
          to dismiss.
        </div>
      )}
    </div>
  );
}

// ─── See in P&L / Balance Sheet action ──────────────────────────────
// LEARN-FIX-1 follow-on (2026-06-13). When the user has just opened a
// composition popover for a leaf concept (revenue, cash, total debt,
// etc.), give them a one-tap path to the populated row on the relevant
// statement table. Inspects the matched line items to decide PL vs BS;
// closes the popover stack on click; navigates with `?tab=…` so the
// FinancialStatements page deep-links the correct tab.

function SeeInStatementAction({
  conceptKey,
  lineItems,
  onLeave,
}: {
  conceptKey: string;
  lineItems: import("@/lib/activePeriod").PeriodLineItem[];
  onLeave: () => void;
}) {
  const { clear } = usePopoverStack();
  const navigate = useNavigate();

  // Resolve which statement this concept lives on by inspecting the
  // first matching line item. STATIC_SOURCE_ACCOUNTS holds the
  // canonical prefix list per concept — we don't import it directly
  // (keep the popover lean) and instead piggyback the resolver we
  // already use for composition.
  const accounts = resolveSourceAccountsForConcept(conceptKey, lineItems);
  if (accounts.length === 0) return null;

  // Find the first PL or BS line item whose code starts with any of
  // the concept's resolved prefixes. Heuristic: a P&L code is class
  // 6, 7, 8, 9; a BS code is class 1, 2, 3, 4, 5.
  let statement: "pl" | "bs" | null = null;
  for (const acc of accounts) {
    const head = acc.code.charAt(0);
    if (["6", "7", "8", "9"].includes(head)) {
      statement = "pl";
      break;
    }
    if (["1", "2", "3", "4", "5"].includes(head)) {
      statement = "bs";
      break;
    }
  }
  if (!statement) return null;

  const tab = statement === "pl" ? "p_and_l" : "balance_sheet";
  const label = statement === "pl" ? "P&L" : "Balance Sheet";
  const topCode = accounts[0]?.code;

  const handleClick = () => {
    clear();
    onLeave();
    // Deep-link to the right tab; downstream `?highlight=` picks up
    // the matching row when the highlight hook is wired (graceful no-op
    // when not).
    const url = topCode
      ? `/dashboard?tab=${tab}&highlight=${encodeURIComponent(topCode)}`
      : `/dashboard?tab=${tab}`;
    navigate(url);
  };

  return (
    <div className="px-5 py-3 border-b border-white/[0.06]">
      <button
        type="button"
        onClick={handleClick}
        data-testid={`see-in-${tab}`}
        className="
          w-full inline-flex items-center justify-center gap-1.5
          py-2.5 rounded-lg
          bg-white/[0.05] hover:bg-white/[0.10]
          text-[12.5px] font-medium text-white/85
          transition-colors
          min-h-[40px]
        "
      >
        See all accounts in {label}
        <ArrowRight className="w-3 h-3" />
      </button>
    </div>
  );
}

// ─── Ask CFO AI action ───────────────────────────────────────────────
// Pre-seeds the CFO chat with the concept context (name + current value
// + a starter question) and navigates the user there. Uses sessionStorage
// to hand the prompt over so the URL stays clean and the chat page reads
// it on mount.

function AskCfoAiAction({
  conceptName,
  conceptKey,
  value,
  format,
  currency,
  onLeave,
}: {
  conceptName: string;
  conceptKey: string;
  value: number;
  format: ValueFormat;
  currency: string;
  onLeave: () => void;
}) {
  const navigate = useNavigate();
  const { clear } = usePopoverStack();
  const handleClick = () => {
    const formatted = formatValue(value, format, { currency });
    const prompt =
      `Tell me more about ${conceptName} (${formatted}) for my company. ` +
      `What does this value mean in context, what's typical for my industry, ` +
      `and what would you watch or act on next?`;
    try {
      sessionStorage.setItem(
        "cfo-chat-preload",
        JSON.stringify({
          prompt,
          concept: { key: conceptKey, name: conceptName, value, format },
          ts: 0, // intentionally static; the consumer just needs the payload
        }),
      );
    } catch {
      /* sessionStorage can throw in private mode — silently ignore. */
    }
    clear();
    onLeave();
    navigate("/chat");
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid="learn-pop-ask-cfo"
      className="
        w-full flex items-center justify-between gap-3
        px-5 py-3.5
        bg-[hsl(173,57%,55%)]/[0.08] hover:bg-[hsl(173,57%,55%)]/[0.14]
        border-t border-white/[0.06]
        text-left
        transition-colors
        group
      "
    >
      <span className="inline-flex items-start gap-2.5">
        <MessageCircle className="w-3.5 h-3.5 mt-0.5 text-[hsl(173,57%,68%)] shrink-0" />
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium text-white/95 leading-tight">
            Ask CFO AI about this
          </span>
          <span className="block text-[10.5px] text-white/55 mt-0.5 leading-snug">
            Open the chat with this concept + your number preloaded
          </span>
        </span>
      </span>
      <ArrowRight className="w-3.5 h-3.5 text-white/45 group-hover:text-[hsl(173,57%,68%)] transition-colors shrink-0" />
    </button>
  );
}

// ─── Tiny shared sub-renderers ──────────────────────────────────────

/** F5.0 Phase 6 — Source-trace block for non-trial-balance variants.
 *  Renders provider + dataset + as-of + confidence + Demo badge for
 *  public-market concepts. The trial-balance variant has its own
 *  dedicated section (with per-account amounts) and is rendered
 *  separately above.
 */
function SourceTraceBlock({
  trace,
}: {
  trace: import("@/lib/learning/concepts/_schema").SourceTrace;
}) {
  // Resolve a (provider, dataset, asOf, confidence) tuple per variant.
  let provider = "";
  let dataset = "";
  let asOf: string | undefined;
  let confidence: number | undefined;
  let isDemo = false;
  let derivedFrom: string | undefined;

  switch (trace.sourceType) {
    case "nasdaq":
      provider = "BVB · issuer filings";
      dataset = trace.dataset;
      asOf = trace.asOf;
      confidence = trace.confidence;
      break;
    case "sec":
      provider = "SEC";
      dataset = trace.filing;
      asOf = trace.asOf;
      confidence = trace.confidence;
      break;
    case "bvb":
      provider = "Bursa de Valori București";
      dataset = trace.issuer;
      asOf = trace.asOf;
      confidence = trace.confidence;
      break;
    case "public_company_dataset":
      provider = trace.vendor.replace(/_/g, " ").toUpperCase();
      dataset = trace.dataset;
      asOf = trace.asOf;
      confidence = trace.confidence;
      break;
    case "public_summary":
      provider = trace.provider;
      asOf = trace.asOf;
      isDemo = /demo/i.test(trace.provider);
      break;
    case "calculated":
      provider = "Calculated";
      derivedFrom = trace.derivedFrom;
      confidence = trace.confidence;
      break;
    case "invoice":
    case "inventory":
    case "manual_input":
    case "financial_statement_line":
    case "trial_balance_account":
      // These variants either don't apply on the public-company surface
      // (invoice, inventory, manual_input) or are handled by the
      // dedicated trial-balance block above.
      return null;
  }

  return (
    <div className="px-5 py-4 border-b border-white/[0.06]">
      <SectionLabel icon={<FileText className="w-3 h-3" />} text="Data source" />
      <div className="mt-2 flex items-start gap-2 flex-wrap">
        <span className="text-[12.5px] text-white/85 font-medium">{provider}</span>
        {isDemo && (
          <span
            data-testid="learn-pop-demo-badge"
            className="
              inline-flex items-center px-1.5 py-0.5 rounded
              text-[10px] font-semibold uppercase tracking-[0.1em]
              bg-[#5CD3C5]/20 text-[#8FE3D9] border border-[#5CD3C5]/30
            "
          >
            Demo
          </span>
        )}
        {confidence !== undefined && !isDemo && (
          <span className="text-[10.5px] text-white/55 self-center">
            · confidence {(confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>
      {dataset && (
        <div className="mt-1 text-[11.5px] text-white/55 font-mono">
          {dataset}
        </div>
      )}
      {derivedFrom && (
        <p className="mt-1.5 text-[11.5px] text-white/65 leading-relaxed">
          {derivedFrom}
        </p>
      )}
      {asOf && (
        <p className="mt-1.5 text-[10.5px] text-white/45">
          as of {asOf}
        </p>
      )}
    </div>
  );
}

function SectionLabel({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] font-medium text-white/55">
      {icon}
      {text}
    </div>
  );
}

function SentimentBadge({
  sentiment,
}: {
  sentiment: "positive" | "negative" | "neutral";
}) {
  if (sentiment === "neutral") return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 mt-3",
        "text-[10.5px] uppercase tracking-[0.1em] font-semibold",
        "px-2 py-0.5 rounded-full",
        sentiment === "positive"
          ? "bg-[hsl(173,57%,55%)]/15 text-[hsl(173,57%,75%)]"
          : "bg-[hsl(0,75%,60%)]/15 text-[hsl(0,75%,78%)]",
      )}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          sentiment === "positive"
            ? "bg-[hsl(173,57%,60%)]"
            : "bg-[hsl(0,75%,65%)]",
        )}
      />
      {sentiment === "positive" ? "Strong" : "Watch"}
    </span>
  );
}

function BenchmarkBar({
  value,
  benchmark,
  format,
  currency,
}: {
  value: number;
  benchmark: { p25: number; median: number; p75: number; source?: string };
  format: ValueFormat;
  currency: string;
}) {
  // Map value into [0,1] across an extended range.
  const min = Math.min(benchmark.p25, value);
  const max = Math.max(benchmark.p75, value);
  const span = max - min;
  const safe = (n: number) => (span > 0 ? (n - min) / span : 0.5);
  const userPct = Math.max(0, Math.min(1, safe(value)));
  const p25Pct = safe(benchmark.p25);
  const medPct = safe(benchmark.median);
  const p75Pct = safe(benchmark.p75);
  return (
    <div className="relative">
      <div className="relative h-1.5 rounded-full bg-white/[0.08]">
        {/* P25–P75 band */}
        <div
          className="absolute top-0 h-full rounded-full bg-white/15"
          style={{ left: `${p25Pct * 100}%`, width: `${(p75Pct - p25Pct) * 100}%` }}
        />
        {/* Median tick */}
        <div
          className="absolute -top-0.5 h-2.5 w-px bg-white/55"
          style={{ left: `${medPct * 100}%` }}
        />
        {/* User marker */}
        <div
          className="absolute -top-1 h-3.5 w-1 rounded-full bg-[hsl(173,57%,60%)] shadow-[0_0_12px_hsl(173,57%,60%/0.6)]"
          style={{ left: `calc(${userPct * 100}% - 2px)` }}
        />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[10.5px] tabular-nums text-white/55">
        <span>P25 {formatValue(benchmark.p25, format, { currency, full: false })}</span>
        <span className="text-center">Median {formatValue(benchmark.median, format, { currency, full: false })}</span>
        <span className="text-right">P75 {formatValue(benchmark.p75, format, { currency, full: false })}</span>
      </div>
      {benchmark.source && (
        <div className="mt-1 text-[10px] text-white/35">{benchmark.source}</div>
      )}
    </div>
  );
}

function SourceAccountRow({
  account,
  currency,
}: {
  account: AccountTrace;
  currency: string;
}) {
  // LEARN-MOBILE F5 (2026-06-16) — 44px tap target + label-on-row-1,
  // amount-on-row-2 stacking on narrow viewports so long Romanian
  // labels like "Venituri din vânzarea produselor finite" don't fight
  // the amount column for horizontal space. The amount is right-
  // aligned via `ml-auto` so the visual hierarchy survives at any
  // viewport width. min-h ensures the row is reliably tappable.
  return (
    <a
      href={`/financials?account=${encodeURIComponent(account.code)}`}
      data-testid={`learn-pop-account-${account.code}`}
      className="
        flex items-center justify-between gap-3
        px-2.5 py-2.5 -mx-2.5 rounded-md
        min-h-[44px]
        text-[12.5px] text-white/85
        hover:bg-white/[0.06] active:bg-white/[0.08] hover:text-white
        transition-colors
      "
    >
      <span className="inline-flex items-baseline gap-2 min-w-0 flex-1">
        <code className="text-[11px] font-mono text-white/55 flex-shrink-0">
          {account.code}
        </code>
        <span className="truncate">{account.label}</span>
      </span>
      <span className="tabular-nums shrink-0 text-white/95 ml-auto">
        {formatValue(account.amount, "currency", { currency, full: false })}
      </span>
    </a>
  );
}

// ─── Format inference helper ────────────────────────────────────────
// When the caller didn't pass a formatOverride we sniff the concept
// key for a sensible default. Long-form: most ratio/percentage concepts
// are explicit in their format; raw amounts default to currency.
function inferFormatFromKey(key: string, category?: string): ValueFormat {
  if (
    key.endsWith("_margin") ||
    key.endsWith("_ratio") ||
    key === "equity_ratio" ||
    key === "debt_to_assets" ||
    key === "wacc" ||
    key === "cost_of_equity" ||
    key === "cost_of_debt" ||
    key === "risk_free_rate" ||
    key === "equity_risk_premium" ||
    key === "terminal_growth_rate" ||
    key === "ltv" ||
    key === "ebitda_margin" ||
    key === "ebit_margin" ||
    key === "net_margin" ||
    key === "gross_margin" ||
    key === "gross_margin_ratio" ||
    key === "roe" ||
    key === "roa" ||
    key === "roic"
  ) {
    return "percentage";
  }
  if (
    key.endsWith("_days") ||
    key === "dio" ||
    key === "dso" ||
    key === "dpo" ||
    key === "ccc"
  ) {
    return "days";
  }
  if (
    key === "altman_z" ||
    key === "altman_z_score" ||
    key === "piotroski_f_score" ||
    key === "composite_credit_score" ||
    key === "credit_grade"
  ) {
    return "score";
  }
  if (
    key === "current_ratio" ||
    key === "quick_ratio" ||
    key === "cash_ratio" ||
    key === "debt_to_equity" ||
    key === "lt_debt_to_equity" ||
    key === "net_debt_ebitda" ||
    key === "debt_to_ebitda" ||
    key === "interest_coverage" ||
    key === "ebitda_to_interest" ||
    key === "dscr" ||
    key === "asset_turnover" ||
    key === "inventory_turnover" ||
    key === "ev_ebitda_multiple" ||
    key === "beta"
  ) {
    return "ratio";
  }
  void category;
  return "currency";
}
