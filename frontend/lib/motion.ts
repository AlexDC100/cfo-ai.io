// Motion primitives for the Cleo-inspired design refresh.
//
// All micro-interactions and reveals across the app should pull from this
// module so we keep timing/curves consistent. The springs and ease curves
// here are the same ones used by Cleo's autopilot flow (snappy enter,
// soft settle, slow scroll reveals).
//
// Usage:
//   import { motion } from "framer-motion";
//   import { enterFromBelow, springSnappy } from "@/lib/motion";
//
//   <motion.div {...enterFromBelow}>…</motion.div>
//   <motion.button whileHover={{ scale: 1.02 }} transition={springSnappy}>

import { useEffect, useState } from "react";
import type { Transition, Variants } from "framer-motion";

// — Springs ——————————————————————————————————————————————————————

/** Snappy spring — buttons, toggles, sidebar items. Settles in ~150ms. */
export const springSnappy: Transition = {
  type: "spring",
  stiffness: 400,
  damping: 30,
  mass: 0.8,
};

/** Soft spring — card reveals, drawers, panels. Settles in ~400ms. */
export const springSoft: Transition = {
  type: "spring",
  stiffness: 200,
  damping: 25,
  mass: 1,
};

/** Ease-out quint — the Cleo signature easing. Use for opacity/translate. */
export const ease: Transition = {
  duration: 0.4,
  ease: [0.16, 1, 0.3, 1],
};

/** Slow ease — for scroll-triggered storytelling reveals. */
export const easeSlow: Transition = {
  duration: 0.7,
  ease: [0.16, 1, 0.3, 1],
};

// — Reveal variants ——————————————————————————————————————————————

export const enterFromBelow: Variants = {
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
};

export const enterFromBelowSoft: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
};

export const enterFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
};

export const enterScale: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
};

// Staggered list — apply to a parent, use enterFromBelowSoft on children.
export const staggerChildren: Variants = {
  initial: {},
  animate: {
    transition: { staggerChildren: 0.06, delayChildren: 0.04 },
  },
};

// — Hover interactions ————————————————————————————————————————————

/** Subtle tilt on hover — for KPI cards, plan cards, etc. */
export const tiltOnHover = {
  whileHover: { rotateX: 2, rotateY: -2, scale: 1.01 },
  transition: springSnappy,
};

/** Lift on hover — buttons, CTAs. */
export const liftOnHover = {
  whileHover: { y: -2, scale: 1.02 },
  whileTap: { scale: 0.98 },
  transition: springSnappy,
};

// — Hooks —————————————————————————————————————————————————————————

/**
 * Animates a number from 0 → `end` over `durationMs`. Returns the current
 * displayed value. Use for KPI count-up reveals.
 *
 * Uses easeOutQuint so the number lands smoothly (no linear ticking).
 * Resets when `end` changes so navigating between docs re-animates.
 */
export function useCountUp(end: number, durationMs = 800): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!Number.isFinite(end)) {
      setValue(end);
      return;
    }
    let rafId = 0;
    const startTime = performance.now();
    const startValue = 0;
    const delta = end - startValue;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / durationMs, 1);
      // easeOutQuint
      const eased = 1 - Math.pow(1 - t, 5);
      setValue(startValue + delta * eased);
      if (t < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [end, durationMs]);

  return value;
}

/**
 * Respects prefers-reduced-motion — returns true when the user has
 * requested reduced motion in their OS settings. Wrap heavy animations.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
