// THE DIAL — Simple-mode statement label wrapper (Prompt 12, Part C §2).
//
// Wraps a statement row label in <Term> (dotted underline + plain-language
// tooltip) when BOTH hold: the view mode is Simple AND the row maps onto a
// glossary id (termForRow). Everywhere else — Pro mode, or no dictionary
// match — the children render verbatim with no affordance, so Pro's tables
// are untouched and no label ever carries a dead underline.
//
// NEVER wrap an interactive label (LearnableRowLabel is a <button>) — the
// caller passes termId only on plain-text label branches; nesting Term's
// focusable span inside a button is the nested-interactive axe violation.

import type { ReactNode } from "react";

import { Term } from "@/components/instrument/Term";
import { useIsSimple } from "@/lib/viewMode";

export function SimpleTermLabel({
  termId,
  children,
}: {
  /** Glossary id from termForRow(...) — null renders children verbatim. */
  termId: string | null;
  children: ReactNode;
}) {
  const isSimple = useIsSimple();
  if (!isSimple || !termId) return <>{children}</>;
  return <Term id={termId}>{children}</Term>;
}
