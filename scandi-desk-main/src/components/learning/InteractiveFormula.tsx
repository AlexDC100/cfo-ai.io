// F5.0 Phase 1.5 — Structured formula renderer.
//
// THIS is the centerpiece of the recursion. Every "value" token in the
// FormulaSpec renders as a button that, on click, pushes a new entry
// onto the popover stack — opening the popover for THAT concept on top
// of the current one. The user can drill 4-5 levels deep into the
// derivation chain without leaving the popover surface.
//
// Three layout modes:
//   · inline    — A ÷ B × 100 — fits on one line
//   · fraction  — proper numerator-over-denominator with horizontal rule
//   · stacked   — multi-line addition column (A + B + C = result)
//
// The renderer respects the popover stack — clicking any value pushes
// onto it; the formula re-renders only when its concept's computation
// returns different tokens (it doesn't on its own — the stack adds a
// new entry above).

import { usePopoverStack } from "./PopoverStackProvider";
import { useReportingMetrics } from "./ReportingContextProvider";
import { formatValue } from "./valueFormat";
import { useIsMobile } from "@/hooks/use-mobile";
import type {
  FormulaSpec,
  FormulaToken,
  ValueFormat,
} from "@/lib/learning/concepts/_schema";

interface Props {
  spec: FormulaSpec;
}

export function InteractiveFormula({ spec }: Props) {
  // LEARN-MOBILE F4 (2026-06-16) — Auto-stack on mobile.
  //
  // A 3-operand formula like "Revenue − COGS − OpEx" laid out inline
  // overflows the 375-px iPhone-SE sheet padding once each token shows
  // its uppercase label + currency-formatted value (e.g. "REVENUE
  // 4,91M RON"). It wraps mid-expression and the equals/operator
  // alignment breaks. Stacked layout already exists for explicit
  // `spec.layout === "stacked"` concepts — just trigger it on mobile
  // any time the formula has > 2 value tokens (the "EBIT + D&A"
  // 2-token case still fits inline at 375px).
  const isMobile = useIsMobile();
  const valueTokenCount = spec.tokens.filter((t) => t.type === "value").length;
  const shouldAutoStack = isMobile && valueTokenCount > 2 && spec.layout !== "fraction";

  if (spec.layout === "fraction") return <FractionLayout spec={spec} />;
  if (spec.layout === "stacked" || shouldAutoStack)
    return <StackedLayout spec={spec} />;
  return <InlineLayout spec={spec} />;
}

// ─── Inline ─────────────────────────────────────────────────────────

function InlineLayout({ spec }: Props) {
  return (
    <div className="flex items-baseline flex-wrap gap-x-2 gap-y-2 text-[15px]">
      {spec.tokens.map((tok, i) => (
        <TokenRender key={i} token={tok} />
      ))}
    </div>
  );
}

// ─── Fraction ───────────────────────────────────────────────────────
// Splits tokens by the first "÷" operator into numerator and denominator.

function FractionLayout({ spec }: Props) {
  const divIdx = spec.tokens.findIndex(
    (t) => t.type === "operator" && t.op === "÷",
  );
  if (divIdx < 0) return <InlineLayout spec={spec} />;
  const numerator = spec.tokens.slice(0, divIdx);
  const denominator = spec.tokens.slice(divIdx + 1);

  return (
    <div className="inline-flex flex-col items-stretch text-[15px] min-w-0">
      <div className="flex items-baseline gap-x-2 justify-center pb-2 flex-wrap">
        {numerator.map((tok, i) => (
          <TokenRender key={i} token={tok} />
        ))}
      </div>
      <div className="h-px bg-white/30 dark:bg-white/30" />
      <div className="flex items-baseline gap-x-2 justify-center pt-2 flex-wrap">
        {denominator.map((tok, i) => (
          <TokenRender key={i} token={tok} />
        ))}
      </div>
    </div>
  );
}

// ─── Stacked ────────────────────────────────────────────────────────
// Each value token on its own line with the operator prefixed.

function StackedLayout({ spec }: Props) {
  // Walk through tokens; emit one row per value, with the preceding
  // operator (if any) as the prefix.
  const rows: Array<{ op?: string; token: FormulaToken }> = [];
  let pendingOp: string | undefined;
  for (const tok of spec.tokens) {
    if (tok.type === "operator") {
      pendingOp = tok.op;
    } else if (tok.type === "value" || tok.type === "literal") {
      rows.push({ op: pendingOp, token: tok });
      pendingOp = undefined;
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-[20px_1fr] items-baseline gap-x-2">
          <span className="text-[15px] text-text-faint dark:text-white/40 font-thin text-right">
            {row.op ?? ""}
          </span>
          <div>
            <TokenRender token={row.token} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Token renderer ─────────────────────────────────────────────────

function TokenRender({ token }: { token: FormulaToken }) {
  const { push } = usePopoverStack();
  const { metrics, currency } = useReportingMetrics();

  if (token.type === "operator") {
    return (
      <span className="text-white/40 dark:text-white/40 font-thin">
        {token.op}
      </span>
    );
  }
  if (token.type === "literal") {
    return (
      <span className="text-white/55 dark:text-white/55 tabular-nums">
        {token.text}
      </span>
    );
  }
  if (token.type === "group_open") {
    return <span className="text-white/40 dark:text-white/40">(</span>;
  }
  if (token.type === "group_close") {
    return <span className="text-white/40 dark:text-white/40">)</span>;
  }

  // Value token — tappable, pushes onto stack.
  const fmt: ValueFormat = token.format ?? "currency";
  const formatted = formatValue(token.value, fmt, { currency });

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    push({
      conceptKey: token.conceptKey,
      value: token.value,
      triggerRect: rect,
      formatOverride: fmt,
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="
        learnable-formula-value
        inline-flex items-baseline gap-1
        tabular-nums
        text-white/95 dark:text-white/95
        hover:text-[hsl(165,75%,60%)] focus-visible:text-[hsl(165,75%,60%)]
        transition-colors
        relative
        cursor-pointer
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(165,75%,55%)]/40 focus-visible:rounded-sm
      "
      data-testid={`formula-value-${token.conceptKey}`}
      aria-label={`${token.label ?? token.conceptKey} — drill in`}
    >
      {token.label && (
        <span className="text-[10.5px] uppercase tracking-[0.1em] text-white/45 dark:text-white/45 mr-1">
          {token.label}
        </span>
      )}
      <span>{formatted}</span>
    </button>
  );
  // Sub-note (unused metric reference suppresses linter):
  void metrics;
}
