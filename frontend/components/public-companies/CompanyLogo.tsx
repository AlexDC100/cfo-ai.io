// CompanyLogo — 32px (default) rounded-square brand mark.
//
// Tries Clearbit's free logo API for known tickers, falls back to a
// deterministic letter avatar with a hash-derived background colour
// so each ticker has a stable visual identity even without a logo.
// The img onError handler hides the broken image and reveals the
// letter avatar layered behind it — no flash of broken placeholder.

import { useState } from "react";
import { tickerLogoUrl } from "@/lib/tickerLogos";

interface Props {
  ticker: string;
  /** Size in pixels. Default 32. */
  size?: number;
  /** Optional className appended (e.g. for margins). */
  className?: string;
}

// Eight tones picked so adjacent rows don't visually collide. Derived
// from the ticker's char codes so ABCD always gets the same colour.
const AVATAR_BG_TONES = [
  "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200",
  "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/20 dark:text-cyan-200",
  "bg-stone-200 text-stone-800 dark:bg-stone-500/20 dark:text-stone-200",
  "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-200",
];

function tickerToneIndex(ticker: string): number {
  let sum = 0;
  for (let i = 0; i < ticker.length; i += 1) {
    sum = (sum + ticker.charCodeAt(i)) % 1000;
  }
  return sum % AVATAR_BG_TONES.length;
}

export function CompanyLogo({ ticker, size = 32, className }: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const url = tickerLogoUrl(ticker);
  const tone = AVATAR_BG_TONES[tickerToneIndex(ticker)];
  const showImg = url && !imgFailed;
  const initial = ticker.charAt(0).toUpperCase();

  return (
    <div
      className={`relative shrink-0 rounded-md overflow-hidden ${className ?? ""}`}
      style={{ width: size, height: size }}
      aria-label={`${ticker} logo`}
    >
      {/* Letter avatar always renders behind so there's never a
          flash-of-broken-image while Clearbit loads. The <img> covers
          it once it succeeds. */}
      <div
        className={`absolute inset-0 flex items-center justify-center font-mono font-semibold ${tone}`}
        style={{ fontSize: Math.floor(size * 0.45) }}
      >
        {initial}
      </div>
      {showImg && (
        <img
          src={url!}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setImgFailed(true)}
          // Bias slightly toward keeping the brand's transparent
          // background so dark/light themes both look correct.
          className="absolute inset-0 w-full h-full object-contain bg-white/40 dark:bg-white/80"
        />
      )}
    </div>
  );
}
