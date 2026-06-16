// F5.0 Phase 1 — Layer 2 Quick Explain Popover content.
//
// Renders inside Radix Popover's PopoverContent. Composition pattern:
//   <Popover open={...} onOpenChange={...}>
//     <PopoverTrigger asChild>{trigger button}</PopoverTrigger>
//     <QuickExplainPopoverContent conceptKey={...} value={...} />
//   </Popover>
//
// LearnableNumber.tsx owns the Popover wrapper + trigger; this file just
// renders the content card so the popover surface can be styled
// independently of the trigger's visual treatment.
//
// Phase 1 surfaces: name, category badge, shortDefinition (English),
// optional inlineFormula, optional benchmark micro-bar, optional
// sentiment-tinted narrative. The "See full breakdown" CTA is hidden
// until Phase 2 wires DeepDivePanel.

import { PopoverContent } from "@/components/ui/popover";
import { useConcept } from "@/hooks/useConcept";
import { BenchmarkMicroBar } from "./BenchmarkMicroBar";
import { cn } from "@/lib/utils";

interface QuickExplainPopoverContentProps {
  conceptKey: string;
  value: number;
  /** When provided, "See full breakdown" CTA fires this. Phase 1 leaves
   *  this optional — no DeepDivePanel ships until Phase 2. */
  onDeepDive?: () => void;
}

export function QuickExplainPopoverContent({
  conceptKey,
  value,
  onDeepDive,
}: QuickExplainPopoverContentProps) {
  const { concept, context } = useConcept(conceptKey);

  if (!concept) {
    // Graceful fallback. Reaching this path means a developer wrapped a
    // value with conceptKey="something" that isn't in the seed/library
    // yet. Surface the gap quietly to the user but loud enough for the
    // developer to notice during browser-verify.
    return (
      <PopoverContent
        side="top"
        sideOffset={8}
        className="w-80 p-4 rounded-2xl border border-rule bg-surface shadow-2 text-ink"
      >
        <p className="text-[12px] text-ink-mute italic leading-snug">
          Concept{" "}
          <code className="font-mono text-[11px] bg-bg-2 rounded px-1.5 py-0.5">
            {conceptKey}
          </code>{" "}
          isn't registered in the learning library yet.
        </p>
      </PopoverContent>
    );
  }

  // Phase 1: always English. Phase 4 will fold in i18n via useTranslation()
  // to read concept.name.ro / shortDefinition.ro when the locale is RO.
  const name = concept.name.en;
  const definition = concept.shortDefinition.en;

  const sentiment = concept.interpretation?.getSentiment(value, context);
  const narrative = concept.interpretation?.getNarrative(value, context);

  const sentimentDot =
    sentiment === "positive"
      ? "bg-emerald-500"
      : sentiment === "negative"
        ? "bg-alert"
        : sentiment === "neutral"
          ? "bg-caution"
          : null;

  return (
    <PopoverContent
      side="top"
      sideOffset={8}
      className="w-80 p-0 rounded-2xl border border-rule bg-surface shadow-2 text-ink overflow-hidden"
      data-testid={`quick-explain-${conceptKey}`}
    >
      <div className="p-4 space-y-3">
        {/* Header: concept name + category badge */}
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[14px] font-medium leading-tight text-ink">
            {name}
          </h4>
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-bg-2 text-ink-mute font-medium whitespace-nowrap">
            {concept.category}
          </span>
        </div>

        {/* Definition */}
        <p className="text-[12.5px] text-ink-soft leading-relaxed">
          {definition}
        </p>

        {/* Optional inline formula */}
        {concept.inlineFormula && (
          <div className="text-[11.5px] font-mono bg-bg-2 rounded-lg p-2.5 text-ink leading-tight">
            {concept.inlineFormula}
          </div>
        )}

        {/* Optional benchmark micro-bar */}
        {concept.benchmark && (
          <BenchmarkMicroBar value={value} benchmark={concept.benchmark} />
        )}

        {/* Optional sentiment-tinted narrative */}
        {sentimentDot && narrative && (
          <div className="flex items-start gap-2 pt-1">
            <span
              className={cn(
                "inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1",
                sentimentDot,
              )}
              aria-hidden
            />
            <p className="text-[12px] text-ink-soft leading-snug flex-1 min-w-0">
              {narrative}
            </p>
          </div>
        )}

        {/* Deep-dive CTA — hidden until Phase 2 wires DeepDivePanel */}
        {onDeepDive && (
          <button
            type="button"
            onClick={onDeepDive}
            className="
              w-full mt-1 py-2 rounded-full
              bg-brand/10 text-brand text-[12px] font-medium
              hover:bg-brand/15 transition-colors
              inline-flex items-center justify-center gap-1.5
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30
            "
          >
            See full breakdown →
          </button>
        )}
      </div>
    </PopoverContent>
  );
}
