// THE CANVAS — THE ARTIFACT SEAM.
//
// The canvas owns the CARD: its chrome, its title, its actions, whether
// it is pinned, how it breathes in the thread. It does not own the BODY.
// Chart rendering and the spec pipeline belong to another lane, and the
// two must be able to ship independently of each other.
//
// So this is a registry, not an import. A renderer lane calls
// `registerCanvasArtifactRenderer("chart", …)` at module load; the card
// asks `canvasArtifactRenderer(kind)` at render time and gets either a
// renderer or null.
//
// ══ WHAT HAPPENS ON NULL, AND WHY IT IS NOT A BLANK ════════════════════
//
// A kind with no renderer falls back to the FIGURES body — the same
// `CapsuleFactCard` / `CapsuleVisuals` / `FigureList` components the
// answer surface already uses, driven by the same evidence. The card
// says so in one line of reviewed copy rather than pretending the
// artifact rendered.
//
// That fallback is not a placeholder in the "coming soon" sense. It is
// the honest floor: the engine returned these facts, with provenance,
// and they are shown. What is missing is the SHAPE, not the substance —
// and showing the substance without the shape is strictly better than
// showing a spinner that never resolves, or an empty card that implies
// there was nothing to say.
//
// ══ THE RULE A RENDERER INHERITS ═══════════════════════════════════════
//
// Whatever fills this seam gets `CapsuleEvidence` and nothing else that
// carries a number. There is no `text` parameter, no `values` array of
// pre-formatted strings, no model output in the props. A renderer that
// wants to print a figure must go through the same `<Amount>` path
// everything else does, because that is the only figure-bearing thing it
// is handed.
//
// This module holds NO React. It is a map plus two functions, so it can
// be imported by a unit test without a DOM.

import type { ReactNode } from "react";

import type { CapsuleTurn } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerClient";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";
import type { CapsuleVisual } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerVisuals";
import type { CanvasArtifactKind } from "@/lib/canvasThread";
import type { TraceableSource } from "@/lib/traceableSource";
import type { ViewMode } from "@/lib/viewMode";

export interface CanvasArtifactRenderProps {
  kind: CanvasArtifactKind;
  /** The ONLY figure-bearing input. Typed values with provenance. */
  evidence: CapsuleEvidence;
  visuals: readonly CapsuleVisual[];
  /** The whole turn, for a renderer that needs the trace or the status.
   *  Its `blocks` are GUARDED prose — placeholders already bound. */
  turn: CapsuleTurn;
  /** A provenance dot leaving for the statement row it names. */
  onJump: (source: TraceableSource) => void;
  mode: ViewMode;
  /**
   * Pin state, passed THROUGH rather than re-derived.
   *
   * A renderer that brings its own card (the artifacts lane's
   * `<Artifact>` does) owns the action row, so the pin control lives
   * there — but the pin STORE is the canvas's. Handing the state down
   * keeps one source of truth for "is this pinned" instead of two
   * surfaces asking different questions of the same store.
   */
  pinned?: boolean;
  onPin?: () => void;
}

export type CanvasArtifactRenderer = (props: CanvasArtifactRenderProps) => ReactNode;

const registry = new Map<CanvasArtifactKind, CanvasArtifactRenderer>();

export function registerCanvasArtifactRenderer(
  kind: CanvasArtifactKind,
  renderer: CanvasArtifactRenderer,
): void {
  registry.set(kind, renderer);
}

export function canvasArtifactRenderer(
  kind: CanvasArtifactKind,
): CanvasArtifactRenderer | null {
  return registry.get(kind) ?? null;
}

/** Which kinds currently have a renderer. Read by the card only to
 *  decide whether to print the fallback note. */
export function registeredArtifactKinds(): CanvasArtifactKind[] {
  return [...registry.keys()];
}

export function __resetCanvasArtifactRegistryForTests(): void {
  registry.clear();
}
