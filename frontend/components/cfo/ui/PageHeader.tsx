// PageHeader — unified header used across pre-upload / post-upload
// surfaces (Dashboard, Benchmark, Products, Settings, Ask CFO AI).
//
// One layout vocabulary for every page-level intro:
//   · brand-tinted eyebrow (Sparkles + UPPERCASE label)
//   · large modern sans headline (font-semibold, negative tracking)
//   · supporting paragraph
//   · optional right-side actions slot
//   · optional atmospheric glow behind the headline (toggle via `atmosphere`)
//
// Designed to be DROPPED IN — every consumer passes title + subtitle
// and gets a header that matches the rest of the product.

import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";

interface Props {
  /** Small uppercase eyebrow above the title — drives the brand-tinted Sparkles mark. */
  eyebrow?: string;
  /** Page title — rendered as h1, modern sans, font-semibold. */
  title: ReactNode;
  /** One-paragraph supporting copy, ink-soft. */
  subtitle?: ReactNode;
  /** Right-side actions (buttons, dropdowns) — render aligned right of the title block on lg+. */
  actions?: ReactNode;
  /** Soft brand-tinted blur glow behind the title. Default false; turn
   *  on for hero-style pages (Dashboard pre-upload, Benchmark pre-upload). */
  atmosphere?: boolean;
  /** Match the Dashboard pre-upload hero's larger type scale (title
   *  40/48px, subtitle 15.5px) instead of the default page-header scale
   *  (title 32/40px, subtitle 14.5/15px). Opt-in so only the surfaces
   *  that want the big hero (Benchmark pre-upload) grow — every other
   *  PageHeader consumer keeps the standard scale. */
  hero?: boolean;
  /** data-testid passthrough for e2e. */
  testid?: string;
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  atmosphere = false,
  hero = false,
  testid,
}: Props) {
  return (
    <section
      data-testid={testid ?? "page-header"}
      className="relative mb-8 sm:mb-10"
    >
      {atmosphere && (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-12 -left-12 h-72 w-72 rounded-full bg-brand/10 blur-3xl"
        />
      )}
      <div className="relative flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
              <Sparkles size={10} strokeWidth={2.25} className="text-brand-d" />
              {eyebrow}
            </div>
          )}
          <h1
            className={`mt-3 ${
              hero ? "text-[44px] sm:text-[56px]" : "text-[36px] sm:text-[44px]"
            } leading-[1.04] tracking-[-0.02em] text-ink max-w-[820px] font-serif`}
          >
            {title}
          </h1>
          {subtitle && (
            <p
              className={`mt-4 ${
                hero ? "text-[15.5px]" : "text-[14.5px] sm:text-[15px]"
              } text-ink-soft max-w-[640px] leading-relaxed`}
            >
              {subtitle}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">
            {actions}
          </div>
        )}
      </div>
    </section>
  );
}
