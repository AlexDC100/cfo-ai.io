// THE ARTIFACTS — 4/8 SLIDE. Board-ready blocks.
//
// Four block types and no more: a headline, a KPI strip, bullets, a
// table. That is the whole vocabulary, and keeping it that small is the
// design decision rather than a limitation — a slide builder with
// twenty block types becomes a layout tool, and a layout tool is where
// figures start being typed by hand into a text box.
//
// Every figure in a `metrics` block is a fact reference resolved through
// `<Amount>`, so a KPI on a board slide carries the same provenance
// affordance as the same figure on the balance sheet. The .pptx built
// from this puts the citation on the cover slide: a deck that leaves the
// product without naming its period and its snapshot is the board pack
// nobody downstream can check.

import { useTranslation } from "react-i18next";

import "./artifactI18n";
import { ArtifactFigure } from "./ArtifactFigure";
import { artifactLabel } from "./artifactI18n";
import type { SlideSpec, TableRowSpec } from "./artifactSpec";
import {
  citationFrom,
  figuresOf,
  makeResolver,
  resolveTable,
  type ResolvedArtifact,
  type ResolvedFigure,
  type ResolvedTable,
} from "./artifactResolve";
import { TableArtifact } from "./TableArtifact";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

export type ResolvedSlideBlock =
  | { block: "headline"; lines: string[] }
  | { block: "bullets"; lines: string[] }
  | { block: "metrics"; metrics: Array<{ label: string; figure: ResolvedFigure }> }
  | { block: "table"; table: ResolvedTable };

export interface ResolvedSlideDeck {
  kind: "slide";
  slides: Array<{ heading: string; blocks: ResolvedSlideBlock[] }>;
}

function MetricTile({ label, figure }: { label: string; figure: ResolvedFigure }) {
  const { t } = useTranslation();
  return (
    <div data-testid="artifact-slide-metric" className="min-w-0">
      <div className="truncate font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
        {artifactLabel(t, label)}
      </div>
      <div className="text-[18px] leading-tight">
        <ArtifactFigure figure={figure} className="text-ink" />
      </div>
    </div>
  );
}

export function SlideArtifact({ deck }: { deck: ResolvedSlideDeck }) {
  const { t } = useTranslation();
  return (
    <div data-testid="artifact-slides" className="space-y-3">
      {deck.slides.map((slide, i) => (
        <article
          key={i}
          data-testid="artifact-slide"
          className="rounded-sm border border-rule bg-bg-2 px-3 py-2.5"
        >
          <h4 className="mb-2 text-[13px] font-semibold text-ink">
            {artifactLabel(t, slide.heading)}
          </h4>
          <div className="space-y-2">
            {slide.blocks.map((block, bi) => {
              if (block.block === "headline") {
                return (
                  <p key={bi} className="text-[14px] leading-snug text-ink">
                    {block.lines.map((l) => artifactLabel(t, l)).join(" ")}
                  </p>
                );
              }
              if (block.block === "bullets") {
                return (
                  <ul key={bi} className="list-disc space-y-0.5 pl-4 text-[12.5px] text-ink-soft">
                    {block.lines.map((l, li) => (
                      <li key={li}>{artifactLabel(t, l)}</li>
                    ))}
                  </ul>
                );
              }
              if (block.block === "metrics") {
                return (
                  <div key={bi} className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                    {block.metrics.map((m, mi) => (
                      <MetricTile key={mi} label={m.label} figure={m.figure} />
                    ))}
                  </div>
                );
              }
              return <TableArtifact key={bi} table={block.table} />;
            })}
          </div>
        </article>
      ))}
    </div>
  );
}

export function slideDeckFrom(
  spec: SlideSpec,
  evidence: CapsuleEvidence,
  trust: string | null = null,
): { artifact: ResolvedArtifact; deck: ResolvedSlideDeck; figures: ResolvedFigure[] } {
  const resolver = makeResolver(evidence);
  const slides = spec.slides.map((slide) => ({
    heading: slide.heading,
    blocks: slide.blocks
      .map((block): ResolvedSlideBlock | null => {
        if (block.block === "headline" || block.block === "bullets") {
          return { block: block.block, lines: (block.lines ?? []).slice() };
        }
        if (block.block === "metrics") {
          const facts = block.facts ?? [];
          return {
            block: "metrics",
            metrics: facts.map((fact, i) => ({
              label: block.factLabels?.[i] ?? fact,
              figure: resolver.figure(fact, block.factLabels?.[i]),
            })),
          };
        }
        const columns = block.columns ?? [];
        const rows = (block.rows ?? []) as TableRowSpec[];
        if (columns.length === 0) return null;
        const { table } = resolveTable(
          { version: spec.version, kind: "table", title: slide.heading, columns, rows },
          evidence,
          trust,
        );
        return { block: "table", table };
      })
      .filter((b): b is ResolvedSlideBlock => b !== null),
  }));
  const deck: ResolvedSlideDeck = { kind: "slide", slides };
  return {
    artifact: { spec, citation: citationFrom(evidence, trust), unresolved: resolver.unresolved },
    deck,
    figures: figuresOf(deck),
  };
}
