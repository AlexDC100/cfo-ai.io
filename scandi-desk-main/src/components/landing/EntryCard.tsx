// EntryCard — the twin entry-point tile used on the landing-page hero.
//
// Two of these stand side-by-side (Upload-your-data vs Public-Companies)
// and have to read as co-equal CTAs — same size, same density, only the
// accent colour differentiates them. Both are clickable buttons (not
// links wrapping a card) because the entire surface is the hit target
// and Framer Motion's spring-on-hover needs a single owning element.
//
// Visual rules (intentionally fixed across both variants):
//   · 7px rounded inner corners (rounded-2xl in Tailwind tokens)
//   · 11×11 icon well with accent-tinted bg
//   · 10px eyebrow eyebrow → 18px title → 14px description → 14px CTA row
//   · Hover: y:-3 lift + accent border deepens + arrow translates 2px
//   · Tap: scale:0.99 — Apple-style snap, not bouncy
//
// Accessibility: rendered as <button>, so Enter / Space activate; keyboard
// focus inherits the brand focus ring. aria-label optional — the visible
// title text + CTA are sufficient context for screen readers.

import { motion } from "framer-motion";
import { ArrowRight, type LucideIcon } from "lucide-react";

interface EntryCardProps {
  /** Lucide icon component. Rendered inside the 44×44 accent well. */
  icon: LucideIcon;
  /** Tiny uppercase tag (e.g. "Your data" / "Public companies"). */
  eyebrow: string;
  /** Card headline — 1–2 short lines. */
  title: string;
  /** 2-line supporting prose. */
  description: string;
  /** Primary CTA label + the chevron next to it. */
  cta: string;
  /** Small hint after the bullet (e.g. "No card · 90s"). */
  ctaHint: string;
  /** Click handler — typically navigate(...) to upload or markets. */
  onClick: () => void;
  /** Brand accent: green = your-data brand, blue = info/markets. */
  accent: "green" | "blue";
  /** Test hook for the e2e + screenshot-grid harness. */
  testid?: string;
}

export function EntryCard({
  icon: Icon,
  eyebrow,
  title,
  description,
  cta,
  ctaHint,
  onClick,
  accent,
  testid,
}: EntryCardProps) {
  // The accent classes are pinned per variant. We use Tailwind opacity
  // syntax (e.g. `bg-brand/10`) so the same tile renders correctly in
  // dark + light themes — the underlying HSL tokens already swap.
  const accentClasses =
    accent === "green"
      ? {
          border: "border-brand/20 hover:border-brand/45",
          iconWell: "bg-brand/12 text-brand",
          ctaText: "text-brand",
          glow: "from-brand/8",
        }
      : {
          border: "border-info/25 hover:border-info/50",
          iconWell: "bg-info/12 text-info",
          ctaText: "text-info",
          glow: "from-info/8",
        };

  return (
    <motion.button
      type="button"
      onClick={onClick}
      data-testid={testid}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.99 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      className={`
        group relative flex flex-col text-left
        rounded-2xl border bg-surface/70 backdrop-blur-sm
        p-6 sm:p-7
        min-h-[260px] sm:min-h-[280px]
        transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
        ${accentClasses.border}
      `}
    >
      {/* Subtle radial glow on hover — sits behind the content so it
       *  never affects layout, and animates only via opacity to avoid
       *  forcing a repaint of the surrounding hero. */}
      <div
        aria-hidden
        className={`
          pointer-events-none absolute inset-0 rounded-2xl opacity-0
          group-hover:opacity-100 transition-opacity duration-300
          bg-gradient-to-br ${accentClasses.glow} to-transparent
        `}
      />

      <div className="relative flex flex-col flex-1">
        <div
          className={`
            inline-flex h-11 w-11 items-center justify-center
            rounded-xl mb-5 transition-colors
            ${accentClasses.iconWell}
          `}
        >
          <Icon size={20} strokeWidth={1.75} />
        </div>

        <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute font-semibold mb-2">
          {eyebrow}
        </div>

        <h3 className="font-serif text-[20px] sm:text-[22px] text-ink leading-snug tracking-[-0.005em] mb-2">
          {title}
        </h3>

        <p className="text-[13.5px] text-ink-soft leading-relaxed flex-1">
          {description}
        </p>

        <div className="flex items-center gap-2.5 mt-5 text-[13.5px]">
          <span className={`inline-flex items-center gap-1.5 font-medium ${accentClasses.ctaText}`}>
            {cta}
            <ArrowRight
              size={14}
              strokeWidth={2.25}
              className="transition-transform group-hover:translate-x-0.5"
            />
          </span>
          <span className="text-ink-mute">· {ctaHint}</span>
        </div>
      </div>
    </motion.button>
  );
}
