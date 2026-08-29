// <Term> — the plain-language affordance (Prompt 12, Part B).
//
// Wraps a financial term wherever the UI renders one: dotted underline,
// tap/hover -> the 1–2 sentence plain explanation from the reviewed
// dictionary (frontend/lib/glossary.ts). Deterministic — no model call,
// ever; the dictionary ships with the bundle in both languages.
//
// Dual labeling by mode: Simple leads with the plain name, Pro leads
// with the term. Both come from the same dictionary entry so gate M2
// can assert completeness in one place.
//
// Distinct from the <Amount> provenance underline on purpose: Term
// underlines are ink-toned (a reading aid), Amount's are accent-toned
// (a trust surface). The two must never look interchangeable.

import { ReactNode } from "react";

import { GLOSSARY, labelFor, plainFor } from "@/lib/glossary";
import { useActiveLocale } from "@/lib/locale";
import { useViewMode } from "@/lib/viewMode";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface TermProps {
  /** Dictionary id ("ebitda", "net_debt", ...). Unknown ids render the
   *  children verbatim with NO affordance — never a dead underline. */
  id: string;
  /** Override the rendered label (else the dictionary's mode label). */
  children?: ReactNode;
  className?: string;
}

export function Term({ id, children, className }: TermProps) {
  const locale = useActiveLocale();
  const mode = useViewMode();
  const entry = GLOSSARY[id];

  if (!entry) {
    return <span className={className}>{children ?? id}</span>;
  }

  const label = children ?? labelFor(id, mode, locale);
  const plain = plainFor(id, locale);

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-term={id}
          className={`cursor-help underline decoration-ink-mute/50 decoration-dotted decoration-1 underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${className ?? ""}`.trim()}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px] border-rule bg-popover text-popover-foreground shadow-3">
        <p className="text-[12px] leading-relaxed text-ink-2">{plain}</p>
      </TooltipContent>
    </Tooltip>
  );
}
