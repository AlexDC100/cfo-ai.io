// THE CANVAS — public surface.
//
// The AppShell mounts `CanvasPanel` and nothing else. Everything below
// it is internal to this directory, with two deliberate exceptions:
//
//   · `canvasArtifactRegistry` — the seam a renderer lane fills.
//   · `canvasPin` — the dashboard reads pinned cards from here.
//
// `lib/canvasThread` is the persisted store and lives in `lib/` because
// it is pure data with no React beyond one subscription hook.

export { CanvasPanel, CANVAS_MIN_WIDTH, CANVAS_WIDTH_KEY } from "./CanvasPanel";
export {
  registerCanvasArtifactRenderer,
  canvasArtifactRenderer,
  registeredArtifactKinds,
  type CanvasArtifactRenderer,
  type CanvasArtifactRenderProps,
} from "./canvasArtifactRegistry";
export { useCanvasPins, getCanvasPins, type CanvasPin } from "./canvasPin";
export { takeCanvasAttachment, peekCanvasAttachment } from "./canvasAttach";
export { CANVAS_SLASH_COMMANDS, parseCanvasSlash, canvasSlashMenu } from "./canvasSlash";
export { planFor, CANVAS_PLANS, type CanvasPlan } from "./canvasPlan";
