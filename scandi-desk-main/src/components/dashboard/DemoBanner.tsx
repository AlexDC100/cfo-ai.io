// F6.1 (2026-06-21) — Demo-data banner.
//
// A discreet strip shown when the dashboard is rendering the fictional
// Meridian demo company (the public/marketing surface default). It tells the
// visitor the numbers are sample data and invites them to upload their own —
// which replaces the demo (a real upload navigates to ?period=<uuid>, see
// useActivePeriodFallback). Renders nothing once the visitor has their own
// data loaded; the caller gates on the active period being the demo sample.

import { Sparkles, ArrowRight } from "lucide-react";

interface Props {
  /** Invoked when the visitor clicks "upload yours" — wired to the page's
   *  file picker so the CTA does the obvious thing. */
  onUpload?: () => void;
}

export function DemoBanner({ onUpload }: Props) {
  return (
    <div
      data-testid="demo-banner"
      className="
        mb-3 flex flex-wrap items-center gap-x-2 gap-y-1
        rounded-lg border border-[hsl(165,60%,55%)]/30
        bg-[hsl(165,75%,55%)]/[0.07]
        px-3 py-2 text-[12px]
      "
    >
      <Sparkles className="w-3.5 h-3.5 text-[hsl(165,80%,34%)] shrink-0" />
      <span className="text-ink-soft">
        <span className="font-semibold text-ink">Demo data</span>
        {" "}— a fictional five-year manufacturer, so every surface has
        something to show.
      </span>
      {onUpload && (
        <button
          type="button"
          onClick={onUpload}
          data-testid="demo-banner-upload"
          className="
            inline-flex items-center gap-1 ml-auto
            font-semibold text-[hsl(165,80%,34%)]
            hover:underline whitespace-nowrap
          "
        >
          Upload yours
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
