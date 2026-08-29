// CompanyLogo — 32px (default) rounded-square brand mark.
//
// BVB tickers render bundled high-resolution logos (self-hosted under
// /logos/bvb/, see BVB_LOCAL_LOGOS in tickerLogos.ts); US tickers still
// use Google's favicon service (Clearbit's free logo API, used until
// 2026-07-24, was permanently shut down 2025-12-08). Unknown tickers
// fall back to a deterministic ticker-text avatar with a hash-derived
// background colour so each ticker has a stable visual identity even
// without a logo. The avatar renders until the real image confirms it
// loaded (onLoad), then unmounts — no flash of broken placeholder while
// in flight, no avatar bleeding through transparent logo regions after.

import { useState } from "react";
import { tickerLogoNeedsDarkBg, tickerLogoUrl } from "@/lib/tickerLogos";

interface Props {
  ticker: string;
  /** Size in pixels. Default 32. When `fill` is true this only sizes the
   *  letter-avatar font (the element itself fills its parent). */
  size?: number;
  /** When true, the logo fills 100% of its parent (object-cover) instead
   *  of being a fixed-size square icon — used for "logo as card
   *  background" tiles. Parent must be `position: relative` and sized
   *  (e.g. `aspect-square`); this component adds no size of its own. */
  fill?: boolean;
  /** PCI redesign (2026-08-04): "monogram" NEVER fetches an image — it
   *  renders the deterministic ticker monogram on a curated 8-tone
   *  palette (hash → tone), uniform radius. The public-companies page
   *  uses this everywhere for a uniform look (image favicons were a mix
   *  of real marks, generic globes and blanks); "image" keeps the old
   *  bundled-logo/favicon behavior for surfaces that still want it
   *  (landing PrivateBusinessDemo). */
  variant?: "image" | "monogram";
  /** Optional className appended (e.g. for margins). */
  className?: string;
}

// THE INSTRUMENT (2026-08-29): both avatar palettes collapsed onto the
// token sheet. Identity comes from the mono TICKER TEXT, not from a
// per-ticker rainbow — semantic tints (amber/red) are reserved for
// reconciliation states and the one accent stays interactive-only, so
// every letter avatar rests on the quiet neutral surface. Behavior
// (hash → tone plumbing, image fallback, fonts) is unchanged; the tone
// tables just resolve to one entry each now.
const AVATAR_BG_TONES = ["bg-bg-2 text-ink-2"];

function tickerToneIndex(ticker: string): number {
  let sum = 0;
  for (let i = 0; i < ticker.length; i += 1) {
    sum = (sum + ticker.charCodeAt(i)) % 1000;
  }
  return sum % AVATAR_BG_TONES.length;
}

const MONOGRAM_TONES = ["bg-bg-2 text-ink-2"] as const;

function monogramTone(ticker: string): string {
  let sum = 0;
  for (let i = 0; i < ticker.length; i += 1) {
    sum = (sum + ticker.charCodeAt(i)) % 1000;
  }
  return MONOGRAM_TONES[sum % MONOGRAM_TONES.length];
}

// Full ticker (not just its first letter) is the fallback label — BVB
// tickers are already short brand abbreviations (TLV, CFH, H2O), so the
// whole thing reads as the company's mark. Longer ones (INFINITY, TRANSI)
// need a smaller font to fit an icon-sized box, hence the length-keyed
// scale below rather than one fixed size for every ticker.
const ICON_FONT_SCALE_BY_LENGTH: Record<number, number> = {
  1: 0.5,
  2: 0.42,
  3: 0.34,
  4: 0.28,
  5: 0.24,
  6: 0.2,
};
const ICON_FONT_SCALE_FALLBACK = 0.17; // 7+ chars

function iconFontSize(size: number, labelLength: number): number {
  const scale = ICON_FONT_SCALE_BY_LENGTH[labelLength] ?? ICON_FONT_SCALE_FALLBACK;
  return Math.max(7, Math.floor(size * scale));
}

const FILL_FONT_CLASS_BY_LENGTH: Record<number, string> = {
  1: "text-4xl",
  2: "text-4xl",
  3: "text-3xl",
  4: "text-xl",
  5: "text-base",
  6: "text-sm",
};
const FILL_FONT_CLASS_FALLBACK = "text-xs"; // 7+ chars

export function CompanyLogo({
  ticker,
  size = 32,
  fill = false,
  variant = "image",
  className,
}: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const monogram = variant === "monogram";
  const url = monogram ? null : tickerLogoUrl(ticker);
  const tone = monogram
    ? monogramTone(ticker.toUpperCase())
    : AVATAR_BG_TONES[tickerToneIndex(ticker)];
  const showImg = url && !imgFailed;
  const label = ticker.toUpperCase();
  // Backdrop behind the logo image. Most brand marks are designed for a
  // light surface, so white is the default; the few white-on-transparent
  // marks (tickerLogoNeedsDarkBg) get a dark slate instead — on white
  // they'd be invisible.
  const imgBg = tickerLogoNeedsDarkBg(ticker)
    ? "bg-slate-800"
    : "bg-white dark:bg-white";

  return (
    <div
      className={`
        relative shrink-0 overflow-hidden
        ${fill ? "w-full h-full" : "rounded-md"}
        ${className ?? ""}
      `}
      style={fill ? undefined : { width: size, height: size }}
      aria-label={`${ticker} logo`}
    >
      {/* Letter avatar renders until the real image confirms it loaded,
          so there's never a flash-of-broken-image while it's in flight —
          but once a logo is confirmed showing, this unmounts entirely
          rather than staying layered behind it. */}
      {!(showImg && imgLoaded) && (
        <div
          className={`
            absolute inset-0 flex items-center justify-center gap-0
            font-mono font-semibold tracking-tight whitespace-nowrap leading-none
            px-[8%] ${tone}
            ${fill ? FILL_FONT_CLASS_BY_LENGTH[label.length] ?? FILL_FONT_CLASS_FALLBACK : ""}
          `}
          style={{ fontSize: fill ? undefined : iconFontSize(size, label.length) }}
        >
          {label}
        </div>
      )}
      {/* object-contain in BOTH modes (2026-07-24): the bundled BVB
          logos are mostly wide wordmarks — object-cover would crop them
          into an illegible zoomed slice. Padding via p-[10%] keeps the
          mark off the tile edges; the backdrop (white, or dark slate
          for white-on-transparent marks) comes from imgBg above.
          In fill mode the image zooms slightly while an ancestor
          `.group` (the grid tile) is hovered — the tile itself stays
          put; only its background grows. */}
      {/* `logo-loaded` marks a CONFIRMED real thumbnail — ancestors use
          it (via Tailwind's has-[.logo-loaded] variant) to enable hover
          treatments that only make sense on a real brand image, never
          on the letter-avatar fallback. */}
      {showImg && (
        <img
          src={url!}
          alt=""
          loading="lazy"
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgFailed(true)}
          className={`
            absolute inset-0 w-full h-full object-contain ${imgBg}
            ${imgLoaded ? "logo-loaded" : ""}
            ${fill
              ? "p-[10%] transition-transform duration-300 group-hover:scale-[1.07]"
              : "p-[6%]"}
          `}
        />
      )}
    </div>
  );
}
