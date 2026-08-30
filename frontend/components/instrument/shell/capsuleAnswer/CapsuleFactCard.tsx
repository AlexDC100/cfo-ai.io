// THE CAPSULE — THE FACT CARD. The first thing an answer says.
//
// ── Why the number comes before the sentence ──────────────────────────
//
// The r0 loop caught the old order: prose first, figures in a small
// "FIGURES" list underneath. The reader asked "how did revenue change"
// and had to read two lines of hedged English before reaching the
// amount — while the amount was the answer and the English was the
// commentary. Worse, the prose is the part that arrives LAST (it is
// generated; the facts are already resolved), so the surface was
// withholding what it already knew in order to lead with what it did
// not.
//
// So: the number, large, first. The interpretation goes beneath it and
// can arrive whenever it arrives.
//
// ── What may appear here ──────────────────────────────────────────────
//
// AT MOST TWO headline facts. One is the common case; two is the
// comparison case (the same metric on two periods), where showing only
// the newer one would answer half the question. A third would be a
// table, and the figure list below already is one.
//
// Every value renders through `FigureValue` — which is `<Amount>` for a
// dimensionless fact and `NarrativeText` for money — so the headline and
// the prose below it resolve the SAME fact through the SAME renderer.
// There is no formatting path in this file. That is deliberate: the
// large number and the sentence's inline number must agree to the last
// separator, and the only way to guarantee that is for neither of them
// to be formatted here.
//
// The delta is the evidence's OWN delta fact, never a subtraction
// performed in this file. A client-side `b - a` would be a second
// opinion about the change, computed in display units, from values that
// may have been converted — which is the whole class of defect the
// native-unit rule exists to prevent.

import { useTranslation } from "react-i18next";

import type { TraceableSource } from "@/lib/traceableSource";

import "./capsuleAnswerI18n";
import { metricLabel } from "./capsuleAnswerI18n";
import type { CapsuleEvidence, CapsuleFactMeta } from "./capsuleAnswerTypes";
import { DeltaChip, FigureValue, ProvenanceDot } from "./CapsuleFigures";
import type { CapsuleVisual } from "./capsuleAnswerVisuals";

export interface CapsuleHeadline {
  /** The fact rendered large. */
  meta: CapsuleFactMeta;
  /** The evidence's own delta fact, when one exists for this metric. */
  delta: CapsuleFactMeta | null;
  direction: "up" | "down" | "flat";
}

/**
 * Which fact leads.
 *
 * Preference order, and each step is a refusal to guess:
 *   1. a COMPARISON visual — the engine's planner already decided which
 *      two facts answer this question and which way the change ran. The
 *      later period leads, with that visual's own delta fact beside it.
 *   2. a SPARKLINE's last point — same reasoning, one metric over time.
 *   3. the single money fact, when there is exactly one. A lone money
 *      fact IS the answer to a "how much" question.
 *   4. the single fact of any unit, on the same grounds.
 *   5. nothing. Two unrelated money facts have no headline between them
 *      — the figure list shows both, equally, which is honest. Picking
 *      one by magnitude would be inventing an emphasis the evidence
 *      does not carry.
 */
export function pickHeadline(
  evidence: CapsuleEvidence,
  visuals: readonly CapsuleVisual[],
): CapsuleHeadline | null {
  const comparison = visuals.find((v) => v.kind === "comparison");
  if (comparison && comparison.kind === "comparison") {
    const meta = evidence.factMeta[comparison.factB];
    if (meta) {
      return {
        meta,
        delta: comparison.factDelta ? evidence.factMeta[comparison.factDelta] ?? null : null,
        direction: comparison.direction,
      };
    }
  }

  const spark = visuals.find((v) => v.kind === "sparkline");
  if (spark && spark.kind === "sparkline") {
    const last = spark.points[spark.points.length - 1];
    const meta = last ? evidence.factMeta[last.fact] : undefined;
    if (meta) return { meta, delta: null, direction: "flat" };
  }

  const all = Object.values(evidence.factMeta);
  const money = all.filter((m) => m.unit === "money");
  if (money.length === 1) return { meta: money[0], delta: null, direction: "flat" };
  if (all.length === 1) return { meta: all[0], delta: null, direction: "flat" };
  return null;
}

export interface CapsuleFactCardProps {
  evidence: CapsuleEvidence;
  visuals: readonly CapsuleVisual[];
  onJump: (source: TraceableSource) => void;
}

/** Renders nothing when the evidence carries no single headline — the
 *  answer then leads with its prose and its figure list, which is the
 *  correct shape for a question that is not about one number. */
export function CapsuleFactCard({ evidence, visuals, onJump }: CapsuleFactCardProps) {
  const { t } = useTranslation();
  const headline = pickHeadline(evidence, visuals);
  if (!headline) return null;

  const { meta, delta, direction } = headline;
  const label = metricLabel(t, meta.metric, meta.scope || meta.fact);

  return (
    <div
      data-testid="capsule-fact-card"
      className="mt-2 border-b border-rule-soft pb-3"
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-ink-soft">
          {label}
        </span>
        {/* `ink-soft` at full strength, not `ink-soft/70`: at 70% this
            scope label measured 4.33:1 on the glass in Terminal, just
            under AA, and it carries the PERIOD the figure above belongs
            to — the one label on a fact card that must never be
            approximately readable. */}
        {meta.periodLabel && (
          <span className="shrink-0 truncate text-[10px] uppercase tracking-[0.14em] text-ink-soft">
            · {meta.periodLabel}
          </span>
        )}
      </div>
      {/* `data-fact` IS the grounding claim, and it is load-bearing.
          C3 walks the DOM and demands that every figure sit inside an
          element naming where it came from. A MONEY figure carries
          `data-narrative-money` from the renderer itself; a
          DIMENSIONLESS one (a ratio, a day count) renders as a bare
          `<Amount>` span and carries nothing — the gate's own documented
          gap. While every figure lived in the figure list that did not
          matter, because the LIST was whitelisted. The headline moved a
          figure out of that list, so the headline has to carry the
          attribute itself. Removing it would silently un-ground every
          ratio answer. */}
      <div
        data-fact={meta.fact}
        data-metric={meta.metric}
        className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1"
      >
        {/* leading-none, and the block below reserves its own height —
            the streamed prose arrives underneath and must not be able to
            reflow this line. */}
        {/* THE HOVER COLOUR IS PINNED, and this is not cosmetic.
            `TraceableNumber` — the app-wide inline "jump to the source
            row" affordance this figure is rendered through — carries
            `hover:text-accent`. At 12px inside a sentence that is a
            perfectly good affordance. At 26px, as the ANSWER, it repaints
            the single most important number on the surface in a pale
            tint that fails AA while the pointer rests on it.
            Caught in the r5 screenshots: the headline read as washed-out
            teal in every mobile capture, and only there, because that is
            where the driver's pointer happened to land. It was
            misdiagnosed twice — first as a compositor artifact, then as
            the panel's translucency — before the pixels were magnified
            and the dotted underline gave it away.
            `TraceableNumber` belongs to another lane, so the colour is
            pinned from here. `!` rather than plain utilities because
            Tailwind resolves competing `hover:` colours by STYLESHEET
            order, not by the order they appear in this attribute — an
            unmarked `hover:text-ink` would win or lose by accident.
            `brand-d` / `brand-l` keep the "this is clickable" signal and
            measure 7.2:1 and above. */}
        <FigureValue
          meta={meta}
          evidence={evidence}
          className="
            text-[26px] leading-none tracking-tight text-ink
            [&_button:hover]:!text-brand-d dark:[&_button:hover]:!text-brand-l
          "
        />
        {/* THE DOT SITS WITH THE NUMBER — but not touching it.
            r1 pinned it to the card's right edge, four hundred pixels
            from the figure it is the proof of, which is not a
            relationship the eye makes. r2 moved it adjacent, and at 5px
            immediately after "RON" it could be read as a full stop. The
            extra left margin is the whole fix: close enough to belong to
            the number, far enough not to punctuate it.
            It renders at all only when the metric maps to a statement
            row we can navigate to — a dot with nowhere to go is trust
            chrome with nothing behind it. */}
        <span className="ml-1 self-center">
          <ProvenanceDot meta={meta} onJump={onJump} />
        </span>
        {delta && (
          <DeltaChip meta={delta} evidence={evidence} direction={direction} />
        )}
      </div>
    </div>
  );
}
