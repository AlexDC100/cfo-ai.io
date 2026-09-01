// THE CANVAS — MULTI-STEP PLANS.
//
// "build me a board pack for December" is not one question. It is three
// or four pieces of work with an order, and the reader should be able to
// WATCH it happen and INSPECT each piece — not stare at a spinner and
// then receive a monolith.
//
// So a plan is data:
//
//     question  →  CanvasPlan { steps: [ {labelKey, artifact}, … ] }
//
// and the surface renders the steps as a checklist that fills in. Each
// step produces its own artifact card, so "assembling deck" is a thing
// you can open, not a status message.
//
// ══ DETERMINISTIC, AND THAT IS THE POINT ═══════════════════════════════
//
// The plan is chosen by a keyword table, not by a model. Three reasons,
// in descending order of how much they matter:
//
//   1. THE LAW. The model composes and explains; the engine computes. A
//      plan decides WHICH ENGINE READS HAPPEN. That is computation, and
//      it does not go to a model.
//   2. A model-chosen plan is not reproducible. The same request would
//      produce four steps today and three tomorrow, and the reader would
//      have no way to tell whether the business changed or the planner
//      did.
//   3. It costs nothing and it is instant. A plan that has to be
//      generated puts a paid round-trip in front of the first pixel.
//
// ══ WHAT A PLAN MAY NOT DO ═════════════════════════════════════════════
//
// P1  NO STEP INVENTS A NUMBER. A step names an artifact KIND and a
//     reviewed-copy label. Every figure inside the artifact arrives the
//     way every other figure on this surface arrives — from the facts
//     gateway, through <Amount>.
// P2  NO STEP IS GENERATIVE UNLESS IT SAYS SO. `generative` is read by
//     the caller to decide whether a paid seam is reached at all. Both
//     plans shipped here are entirely free: they are engine reads
//     arranged, which is what a board pack actually is.
// P3  A PLAN IS CLAIMED OR IT IS NOT. `planFor` returns null for
//     anything that is one question, and the caller then runs the
//     ordinary single-turn path. There is no "plan of one step" — that
//     would put a checklist above every answer.
//
// Pure: no React, no i18n, no fetch, no clock.

import type { CanvasArtifactKind } from "@/lib/canvasThread";

export interface CanvasPlanStep {
  id: string;
  labelKey: string;
  artifact: CanvasArtifactKind;
  /** True when this step needs the model to compose prose. */
  generative: boolean;
  /**
   * The question this step asks OF THE ENGINE, verbatim, so
   * `planRetrieval` can turn it into read-only tool calls.
   *
   * It is a fixed string rather than something derived from the reader's
   * phrasing, because that is what makes a plan reproducible: the same
   * plan always performs the same engine reads. Null when the step
   * assembles what earlier steps produced and needs no read of its own.
   */
  probe: string | null;
}

export interface CanvasPlan {
  id: string;
  labelKey: string;
  steps: readonly CanvasPlanStep[];
}

/** Fold to the router's comparison form: lowercase, no diacritics. */
export function foldPlanQuery(q: string): string {
  return (q ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[Șș]/g, "s")
    .replace(/[Țț]/g, "t")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * THE PLANS. Two, because two are the shapes people actually ask for at
 * a CFO surface, and a table of eight speculative ones would be a
 * catalogue nobody triggers.
 */
export const CANVAS_PLANS: readonly {
  plan: CanvasPlan;
  /** Folded phrases that claim this plan. All EN + RO. */
  triggers: readonly string[];
}[] = Object.freeze([
  {
    plan: {
      id: "board_pack",
      labelKey: "canvas.plan.boardPack.label",
      steps: [
        {
          id: "statements",
          labelKey: "canvas.plan.step.statements",
          artifact: "figures",
          generative: false,
          // Grounds itself in HEALTH_METRICS — revenue, net result,
          // equity, total assets — which is what a pack opens with.
          probe: "how are we doing",
        },
        {
          id: "charts",
          labelKey: "canvas.plan.step.charts",
          artifact: "chart",
          generative: false,
          // A TREND phrase, so `planRetrieval` reads several periods and
          // the evidence carries a series rather than a point.
          probe: "revenue trend",
        },
        {
          id: "assemble",
          labelKey: "canvas.plan.step.assemble",
          artifact: "export",
          generative: false,
          // Assembles the steps above. No read of its own — an export
          // that re-queried would be a different pack from the one the
          // reader just watched being built.
          probe: null,
        },
      ],
    },
    triggers: [
      "board pack",
      "board deck",
      "board report",
      "monthly pack",
      "reporting pack",
      "pachet de consiliu",
      "pachet consiliu",
      "raport de consiliu",
      "prezentare pentru consiliu",
    ],
  },
  {
    plan: {
      id: "period_review",
      labelKey: "canvas.plan.periodReview.label",
      steps: [
        {
          id: "statements",
          labelKey: "canvas.plan.step.statements",
          artifact: "figures",
          generative: false,
          probe: "how are we doing",
        },
        {
          id: "ratios",
          labelKey: "canvas.plan.step.ratios",
          artifact: "table",
          generative: false,
          probe: "current ratio",
        },
        {
          id: "compare",
          labelKey: "canvas.plan.step.compare",
          artifact: "comparison",
          generative: false,
          probe: "revenue vs last period",
        },
      ],
    },
    triggers: [
      "full review",
      "month end review",
      "month-end review",
      "close review",
      "review the month",
      "analiza lunii",
      "analiza de inchidere",
      "revizuire lunara",
    ],
  },
]);

/**
 * The plan this question asks for, or null when it is a single question.
 *
 * Longest trigger wins, so "board pack" does not lose to a shorter
 * phrase that happens to also match. Ties break on plan id, so the
 * result is a pure function of the input in every case.
 */
export function planFor(question: string): CanvasPlan | null {
  const folded = foldPlanQuery(question);
  if (!folded) return null;
  let best: { plan: CanvasPlan; len: number } | null = null;
  for (const entry of CANVAS_PLANS) {
    for (const trig of entry.triggers) {
      if (!folded.includes(trig)) continue;
      if (
        !best ||
        trig.length > best.len ||
        (trig.length === best.len && entry.plan.id < best.plan.id)
      ) {
        best = { plan: entry.plan, len: trig.length };
      }
    }
  }
  return best ? best.plan : null;
}

/** True when running this plan reaches a paid seam at all. Read by the
 *  caller before it takes a reservation. */
export function planIsGenerative(plan: CanvasPlan): boolean {
  return plan.steps.some((s) => s.generative);
}
