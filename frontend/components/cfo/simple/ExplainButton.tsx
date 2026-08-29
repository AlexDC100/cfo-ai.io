// EXPLAIN ANYTHING — the consumer-side affordance (Prompt 12, Part D).
//
// Panel.tsx is owned by another lane, so the Explain affordance mounts
// from the consumer side: a page drops <ExplainButton> next to a panel
// title, passing the figures that panel ALREADY renders. The button owns
// the drawer state, so a wire-in is one element, no plumbing.
//
// SIMPLE MODE ONLY by design: Pro is the Instrument, untouched — this
// button renders null in Pro so the professional surface stays exactly
// what it is today. Modes never change a value; this is arrangement and
// disclosure only.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";

import "@/components/cfo/simple/explainI18n";
import { ExplainDrawer } from "@/components/instrument/ExplainDrawer";
import type { ExplainInput } from "@/lib/explain";
import { useIsSimple } from "@/lib/viewMode";

import type { ReactNode } from "react";

export interface ExplainButtonProps {
  /** What to explain — figures MUST come from what the panel renders. */
  request: ExplainInput;
  /** The panel's own <Amount>-rendered figures, shown in the drawer. */
  figureDisplay?: ReactNode;
  className?: string;
}

export function ExplainButton({ request, figureDisplay, className }: ExplainButtonProps) {
  const { t } = useTranslation();
  const simple = useIsSimple();
  const [open, setOpen] = useState(false);

  if (!simple) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        data-testid={`explain-button-${request.panelId}`}
        className={`inline-flex h-7 items-center gap-1.5 rounded-full border border-rule bg-surface px-2.5 text-[11.5px] font-medium text-ink-soft transition-colors hover:border-rule-strong hover:text-ink ${className ?? ""}`.trim()}
      >
        <Sparkles size={12} strokeWidth={2} aria-hidden className="text-brand-d dark:text-brand-l" />
        {t("explain.button")}
      </button>
      <ExplainDrawer
        open={open}
        onOpenChange={setOpen}
        request={request}
        figureDisplay={figureDisplay}
      />
    </>
  );
}
