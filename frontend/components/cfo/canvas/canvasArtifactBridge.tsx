// THE CANVAS — THE BRIDGE TO THE RENDERERS.
//
// The registry (`canvasArtifactRegistry`) is the seam; this is the one
// file that fills it. Until it existed, `registeredArtifactKinds()`
// returned an empty list and every artifact fell back to the figure
// list — while eleven finished renderers sat under `canvas/artifacts/`
// unreachable from the running app. The static gate's L8 named exactly
// that: *"a gate pointed at a latent anchor is a false green with extra
// steps."*
//
// ══ WHERE THE SPEC COMES FROM, AND WHY IT IS NOT THE MODEL ═════════════
//
// The renderer lane's components take a RESOLVED ARTIFACT — a spec plus
// a citation — and the spec normally arrives from the spec pipeline: the
// model composes it, the guard validates it. That pipeline belongs to
// that lane and is not touched here.
//
// What this file does instead is narrower and, for these three kinds,
// sufficient: it DERIVES the spec from the evidence, deterministically,
// with no model involved. A table of the facts the engine returned is
// not a composition — it is an arrangement, and arranging is computing.
// The same evidence always produces the same spec, which is the property
// a model-authored spec cannot offer.
//
// So the division holds exactly where the law puts it:
//
//   the ENGINE returned these facts        → evidence
//   arranging them into rows and series    → here, deterministic
//   saying what they MEAN                  → the model, guarded, and it
//                                            arrives as `turn.blocks`
//
// ══ WHAT IS DELIBERATELY NOT BRIDGED ═══════════════════════════════════
//
// `scenario`, `export`, `explain` and `figures` keep the canvas's own
// body. A scenario needs DRIVER IDS from the scenario registry and an
// output list — choices, not arrangements, and inventing them here would
// be this file quietly becoming a planner. When the spec pipeline lands,
// it registers those kinds and overwrites these entries; `registerCanvas
// ArtifactRenderer` is last-write-wins for that reason.
//
// ══ NO FIGURE IS FORMATTED HERE ════════════════════════════════════════
//
// Every `cells` entry and every `points` entry is a FACT NAME. The
// renderer resolves it through `makeResolver` → `<Amount>`. There is no
// code path in this file that turns a number into a string.

import type { ReactNode } from "react";

import { metricLabel } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerI18n";
import type {
  CapsuleEvidence,
  CapsuleFactMeta,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";
import i18n from "@/i18n";

import { Artifact } from "./artifacts/Artifact";
import type { ChartSpec, TableSpec } from "./artifacts/artifactSpec";
import { ARTIFACT_SPEC_VERSION } from "./artifacts/artifactSpec";
// ONE LINE, and that is load-bearing. `check_canvas.mjs`'s L8 excludes a
// file whose source contains a line matching `^\s*registerCanvasArtifact
// Renderer,\s*$` — written to skip `index.ts`'s re-export list. A
// multi-line named import puts the symbol on its own line and trips the
// same regex, which silently excluded THIS file (the only real
// registration in the repo) and left L8 reporting an empty registry.
// Flagged to the gate's lane as an over-broad exclusion; single-lining
// the import is the change that does not touch someone else's gate.
import { registerCanvasArtifactRenderer } from "./canvasArtifactRegistry";
import type { CanvasArtifactRenderProps } from "./canvasArtifactRegistry";

/** Translate through the app's singleton rather than a hook — these are
 *  spec builders, not components, and they run before render. */
const tr = (key: string, params?: Record<string, unknown>) =>
  i18n.t(key, params) as string;

function label(meta: CapsuleFactMeta): string {
  return metricLabel(tr, meta.metric, meta.scope || meta.fact);
}

/** Facts in the order the planner asked for them, ties broken by name so
 *  the same evidence always yields the same rows. */
function orderedFacts(evidence: CapsuleEvidence): CapsuleFactMeta[] {
  return Object.values(evidence.factMeta).sort((a, b) => {
    if (a.step !== b.step) return a.step - b.step;
    return a.fact < b.fact ? -1 : a.fact > b.fact ? 1 : 0;
  });
}

// ══════════════════════════════════════════════════════════════════════
// TABLE — one row per fact
// ══════════════════════════════════════════════════════════════════════

export function tableSpecFrom(evidence: CapsuleEvidence, title: string): TableSpec | null {
  const facts = orderedFacts(evidence);
  if (facts.length === 0) return null;
  return {
    version: ARTIFACT_SPEC_VERSION,
    kind: "table",
    title,
    columns: [
      { label: tr("canvas.bridge.metric"), role: "label" },
      { label: tr("canvas.bridge.value"), role: "value" },
    ],
    rows: facts.map((m) => ({
      label: m.periodLabel ? `${label(m)} · ${m.periodLabel}` : label(m),
      // A FACT NAME, not a value. The renderer resolves it.
      cells: [m.fact],
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════
// COMPARISON — one row per metric, one column per period
// ══════════════════════════════════════════════════════════════════════
//
// Rendered as a TABLE, not through `ComparisonArtifact`. That component
// wants an accounting STANDARD declared per column (`benchmarkGroups`'
// vocabulary) so its grouping law can police the axis — and this file
// does not know the standard. Declaring one it cannot verify would be
// fabricated provenance in a field that exists precisely to prevent
// that. A period-over-period table says exactly as much as the evidence
// supports and no more.

export function comparisonSpecFrom(
  evidence: CapsuleEvidence,
  title: string,
): TableSpec | null {
  const facts = orderedFacts(evidence);
  if (facts.length === 0) return null;

  const periods: string[] = [];
  for (const m of facts) {
    const key = m.periodLabel ?? "";
    if (key && !periods.includes(key)) periods.push(key);
  }
  // Fewer than two periods is not a comparison; the plain table is the
  // honest shape.
  if (periods.length < 2) return tableSpecFrom(evidence, title);

  const metrics: string[] = [];
  for (const m of facts) if (!metrics.includes(m.metric)) metrics.push(m.metric);

  return {
    version: ARTIFACT_SPEC_VERSION,
    kind: "table",
    title,
    columns: [
      { label: tr("canvas.bridge.metric"), role: "label" as const },
      ...periods.map((p) => ({ label: p, role: "value" as const })),
    ],
    rows: metrics.map((metric) => {
      const first = facts.find((m) => m.metric === metric)!;
      return {
        label: label(first),
        // `null` where a metric has no fact for that period — a TYPED
        // ABSENCE, which the renderer paints as the missing-data glyph.
        // Never a zero, and never a carried-forward neighbour.
        cells: periods.map(
          (p) => facts.find((m) => m.metric === metric && m.periodLabel === p)?.fact ?? null,
        ),
      };
    }),
  };
}

// ══════════════════════════════════════════════════════════════════════
// CHART — one series per metric, points in planner order
// ══════════════════════════════════════════════════════════════════════

export function chartSpecFrom(evidence: CapsuleEvidence, title: string): ChartSpec | null {
  const facts = orderedFacts(evidence);
  if (facts.length === 0) return null;

  const byMetric = new Map<string, CapsuleFactMeta[]>();
  for (const m of facts) {
    if (m.unit !== "money") continue; // a chart of mixed units is a lie
    const list = byMetric.get(m.metric) ?? [];
    list.push(m);
    byMetric.set(m.metric, list);
  }

  const series = [...byMetric.entries()]
    .filter(([, points]) => points.length >= 2)
    .map(([metric, points]) => ({
      label: metricLabel(tr, metric, metric),
      points: points.map((m) => m.fact),
      // Length MUST match `points` or the renderer refuses the series —
      // a chart whose ticks and bars are off by one is worse than no
      // chart. A point with no period label falls back to its own name
      // rather than shortening the array.
      pointLabels: points.map((m) => m.periodLabel ?? label(m)),
    }));

  // One point is not a line. Refusing here means the card falls back to
  // the figure list, which is the honest floor.
  if (series.length === 0) return null;

  return {
    version: ARTIFACT_SPEC_VERSION,
    kind: "chart",
    title,
    form: "line",
    series,
  };
}

// ══════════════════════════════════════════════════════════════════════
// REGISTRATION
// ══════════════════════════════════════════════════════════════════════

/**
 * `<Artifact>` — the artifacts lane's OWN entry point, not one of its
 * leaf bodies.
 *
 * The first version of this bridge rendered `<TableArtifact>` and
 * `<ChartArtifact>` directly. That mounted the drawing and nothing else:
 * no citation footer, no action row, and therefore no
 * `data-testid="artifact-export"` — which the law gate A6 correctly read
 * as "the export path cannot be exercised". The card, the citation and
 * the actions are that lane's work too, and skipping them re-implemented
 * a worse version of all three.
 *
 * `<Artifact>` also PARSES and GUARDS the spec (`spec: unknown` is
 * deliberate on its side). A spec this file derives is subject to the
 * same guard as one a model composed — which is the right way round: the
 * guard should not have to trust its caller.
 */
function renderSpec(spec: TableSpec | ChartSpec | null, props: CanvasArtifactRenderProps): ReactNode {
  // NULL, not an empty card. A renderer that renders nothing would be
  // worse than not registering: the card would paint an empty box where
  // the figure list belongs. `CanvasArtifactCard` treats a null body as
  // "no renderer" and falls back.
  if (!spec) return null;
  return (
    <Artifact
      spec={spec}
      evidence={props.evidence}
      pinned={props.pinned}
      onPin={props.onPin ? () => props.onPin?.() : undefined}
    />
  );
}

function renderTable(props: CanvasArtifactRenderProps): ReactNode {
  return renderSpec(tableSpecFrom(props.evidence, tr("canvas.artifact.table")), props);
}

function renderComparison(props: CanvasArtifactRenderProps): ReactNode {
  return renderSpec(comparisonSpecFrom(props.evidence, tr("canvas.artifact.compare")), props);
}

function renderChart(props: CanvasArtifactRenderProps): ReactNode {
  return renderSpec(chartSpecFrom(props.evidence, tr("canvas.artifact.chart")), props);
}

registerCanvasArtifactRenderer("table", renderTable);
registerCanvasArtifactRenderer("comparison", renderComparison);
registerCanvasArtifactRenderer("chart", renderChart);

/** Imported for side effect by `CanvasPanel`. Exported so the import is
 *  not mistaken for dead weight and removed by a tidy-up. */
export const CANVAS_BRIDGE_KINDS = ["table", "comparison", "chart"] as const;
