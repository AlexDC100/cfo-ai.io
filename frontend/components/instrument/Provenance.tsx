// THE AFFORDANCE — one component, every figure that HAS provenance.
//
// The chain is already proven end to end: `scripts/capsule_demo_partial.py`
// walks a served fact -> balance-sheet row -> account codes -> the actual
// cells (I15+I16+I17 = 66,280,871.31, difference 0 cents) on a REAL trial
// balance. What was missing was never the data. It was this.
//
// ── WHY THIS FILE EXISTS SEPARATELY FROM <Amount> ─────────────────────
//
// The affordance used to live inside `Amount.tsx`, which meant only a
// figure rendered BY `<Amount>` could carry it. Two of the four named
// surfaces do not render that way and cannot cheaply be made to:
//
//   · every MONEY figure in the Capsule and in Findings goes through
//     `NarrativeText` (lib/narrativeMoney), because that is the only
//     path that owns the display-currency decision. Routing money to
//     `<Amount>` instead would give one number two spellings on one
//     screen — the defect that path exists to prevent.
//   · statement rows (BS / P&L / Cash Flow) format through the currency
//     store's `useAmountFormatter`, inside a CSS grid whose columns are
//     load-bearing.
//
// So the affordance is a WRAPPER, not a renderer. It never touches the
// number; it decorates whatever painted it. `<Amount>` uses it, and so
// does anything else with a payload to stand behind.
//
// ── THE RULE THAT OUTRANKS COVERAGE ───────────────────────────────────
//
// WHERE PROVENANCE IS NOT IN THE PAYLOAD, RENDER WITHOUT THE AFFORDANCE.
// A figure that offers a provenance jump and lands nowhere is worse than
// one that offers nothing: it teaches the reader the affordance is
// decorative, and then the ones that DO land stop being believed.
//
// `hasProvenance` is the gate, and it is deliberately a substance check
// rather than a presence check — an empty object is a payload that says
// nothing, so it renders plain. `frontend/components/instrument/__tests__`
// plants a fake and expects refusal.
//
// Fields render ONLY when present. There is no "—" for an absent field
// and no "unknown": a card that lists Pack with a dash has invented a
// fact about the pack.
//
// ── CONTRAST, MEASURED ────────────────────────────────────────────────
//
// The card's secondary text was `text-ink-mute`, which measures 3.53:1
// against `--popover` in the LIGHT theme — an AA failure on every label
// in the card ("Source", "Method", "Pack", the snapshot line). It reads
// fine, which is exactly why it survived; nobody measures what looks
// right. Everything here is `text-ink-soft` (5.86:1 light, 7.61:1 dark)
// or `text-ink` (19.05:1 / 15.64:1). `scripts/check_provenance_contrast.mjs`
// re-measures from the token sheet on every run, so a token edit that
// pushes a node under AA fails a gate instead of shipping.

import { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ── the payload ────────────────────────────────────────────────────────

export interface AmountProvenance {
  /** Where the figure was READ from — "sheet Balanta · row 214 · col G",
   *  "Anon_2bb7638cfd", "10-K". Never a period label: a period is not a
   *  source, and putting one here was a live defect (see the census). */
  source?: string;
  /** Account codes behind the figure, verbatim from the served row —
   *  "2131, 2132, 2133". This is the half a reader can actually check
   *  against their own trial balance. */
  accounts?: string;
  /** Which period the figure belongs to — "FY 2025". Its own field
   *  precisely so it can never be mistaken for a source. */
  period?: string;
  /** mechanical | deterministic | mechanical_mapped | llm | a derivation
   *  ("ratio of equity / total_assets"). */
  method?: string;
  /** Verification score when the method carries one (0..1). */
  confidence?: number;
  /** Country/mapping pack — "ro_omfp1802_v2", "tb_parser_v5". */
  pack?: string;
  /** ISO timestamp of the computation. */
  computedAt?: string;
  /** Short content hash / snapshot id of the served envelope. */
  snapshot?: string;
}

/** True when the payload actually carries something worth an affordance.
 *  An empty object must NOT produce one — that is trust chrome with
 *  nothing behind it. A `period` alone does NOT qualify: every fact in
 *  the index carries one, so admitting it would put the affordance on
 *  every figure in the product and say nothing on any of them. */
export function hasProvenance(
  p: AmountProvenance | null | undefined,
): p is AmountProvenance {
  if (!p) return false;
  return Boolean(p.source || p.accounts || p.method || p.pack || p.snapshot);
}

/** Drop empty strings / non-finite numbers so a caller can map a payload
 *  field-by-field without hand-writing `|| undefined` at each one. Returns
 *  null when nothing survives, which is the signal to render plain. */
export function provenanceOf(
  p: Partial<AmountProvenance> | null | undefined,
): AmountProvenance | null {
  if (!p) return null;
  const out: AmountProvenance = {};
  const str = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    return s.length > 0 ? s : undefined;
  };
  const source = str(p.source);
  const accounts = str(p.accounts);
  const period = str(p.period);
  const method = str(p.method);
  const pack = str(p.pack);
  const computedAt = str(p.computedAt);
  const snapshot = str(p.snapshot);
  if (source) out.source = source;
  if (accounts) out.accounts = accounts;
  if (period) out.period = period;
  if (method) out.method = method;
  if (typeof p.confidence === "number" && Number.isFinite(p.confidence)) {
    out.confidence = p.confidence;
  }
  if (pack) out.pack = pack;
  if (computedAt) out.computedAt = computedAt;
  if (snapshot) out.snapshot = snapshot;
  return hasProvenance(out) ? out : null;
}

// ── the card ───────────────────────────────────────────────────────────

/** One row of the card. Rendered only when its value is present — the
 *  caller never passes a placeholder, so an absent field is absent. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="inline text-ink-soft">{label}&nbsp;</dt>
      <dd className="inline">{children}</dd>
    </div>
  );
}

export function ProvenanceCard({
  p,
  exact,
  conversionNote,
}: {
  p: AmountProvenance;
  /** Full-precision spelling of the figure the affordance decorates.
   *  Optional: a statement row already shows full precision, and
   *  repeating it would make the card restate what is on screen. */
  exact?: string;
  /** "1 EUR = 5,2489 RON · display only". */
  conversionNote?: string;
}) {
  return (
    <div className="max-w-[300px] space-y-1.5 text-left">
      {exact && (
        <div className="font-mono text-[13px] tabular-nums text-ink">{exact}</div>
      )}
      <dl className="space-y-0.5 text-[11px] leading-snug text-ink-soft">
        {p.source && (
          <Row label="Source">
            <span className="font-mono">{p.source}</span>
          </Row>
        )}
        {p.accounts && (
          <Row label="Accounts">
            <span className="font-mono">{p.accounts}</span>
          </Row>
        )}
        {p.period && <Row label="Period">{p.period}</Row>}
        {p.method && (
          <Row label="Method">
            {p.method}
            {typeof p.confidence === "number" && (
              <span className="font-mono tabular-nums">
                {" "}
                · {Math.round(p.confidence * 100)}%
              </span>
            )}
          </Row>
        )}
        {p.pack && (
          <Row label="Pack">
            <span className="font-mono">{p.pack}</span>
          </Row>
        )}
        {(p.computedAt || p.snapshot) && (
          <div className="font-mono text-[10.5px] text-ink-soft">
            {p.computedAt ? `computed ${p.computedAt}` : null}
            {p.computedAt && p.snapshot ? " · " : null}
            {p.snapshot ? `snapshot ${p.snapshot}` : null}
          </div>
        )}
        {conversionNote && (
          <div className="pt-0.5 text-[10.5px] italic text-ink-soft">
            {conversionNote}
          </div>
        )}
      </dl>
    </div>
  );
}

// ── the affordance ─────────────────────────────────────────────────────

export interface ProvenanceAffordanceProps {
  provenance: AmountProvenance | null | undefined;
  children: ReactNode;
  /** Full-precision figure for the card's first line. */
  exact?: string;
  conversionNote?: string;
  /** Extra classes on the trigger span. */
  className?: string;
  /** `inline` (default) sits in prose and inside a table cell without
   *  changing the line box. `block` fills its grid cell — statement rows
   *  need this or the right-aligned column loses its alignment. */
  display?: "inline" | "block";
  /** Which side the card opens on. Statement columns hug the right edge,
   *  so they pass "left". */
  side?: "top" | "right" | "bottom" | "left";
  /** Underline the decorated text. Off for a figure that already carries
   *  its own decoration (a `TraceableNumber` inside prose draws one on
   *  hover, and two dotted rules on one number reads as a defect). */
  underline?: boolean;
}

/**
 * Wrap a figure that HAS provenance. Renders `children` untouched when it
 * does not — the caller does not branch.
 *
 * HOVER and FOCUS both open it, and Escape dismisses it. That is not
 * three features: a hover-only disclosure is a disclosure a keyboard user
 * cannot reach, so the affordance would be decorative for them, which is
 * the exact failure this whole lane is about. Radix's Tooltip gives all
 * three (`onFocus` opens unless a pointer is down; `DismissableLayer`
 * closes on Escape) — `__tests__/provenance.test.tsx` drives each one
 * rather than trusting the library's README.
 */
export function ProvenanceAffordance({
  provenance,
  children,
  exact,
  conversionNote,
  className,
  display = "inline",
  side = "top",
  underline = true,
}: ProvenanceAffordanceProps) {
  if (!hasProvenance(provenance)) return <>{children}</>;

  // brand at 80%, NOT 40%.
  //
  // The dotted rule is the ONLY thing that tells a reader a figure has
  // provenance before they hover it, which makes it a non-text UI
  // indicator under WCAG 1.4.11 and puts it at a 3:1 floor. The
  // inherited 40% composites to 1.78:1 in light and 2.27:1 in dark —
  // both fail, and both look perfectly reasonable, which is why it
  // survived. 80% measures 3.50:1 and 5.48:1. 70% was tried first and
  // reaches only 2.93:1 in light: still a fail, and the kind that a
  // "close enough" would have shipped.
  // Re-measured on every run by scripts/check_provenance_contrast.mjs.
  const decoration = underline
    ? "underline decoration-brand/80 decoration-dotted decoration-1 underline-offset-4"
    : "";
  const box = display === "block" ? "block w-full" : "";

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-provenance="true"
          className={`cursor-help outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${box} ${decoration} ${className ?? ""}`
            .replace(/\s+/g, " ")
            .trim()}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className="border-rule bg-popover text-popover-foreground shadow-3"
      >
        <ProvenanceCard p={provenance} exact={exact} conversionNote={conversionNote} />
      </TooltipContent>
    </Tooltip>
  );
}
