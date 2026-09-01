// THE ARTIFACTS — the lane's public surface.
//
// A host imports from here and nothing else. The pure modules
// (`artifactSpec`, `artifactResolve`, `artifactGeometry`,
// `artifactScenario`, `artifactRefine`) are re-exported alongside the
// components because they are the CONTRACT: another lane building a
// planner or a thread needs the spec types and the guard without
// pulling React in.

export { Artifact, ArtifactRefused, figureCensus } from "./Artifact";
export { ArtifactCard, ArtifactCitationFooter } from "./ArtifactCard";
export type { ArtifactActions, ArtifactCardProps } from "./ArtifactCard";
export { ArtifactReveal, useSettled, ARTIFACT_STAGGER_MS } from "./ArtifactReveal";

export { ChartArtifact, chartFrom } from "./ChartArtifact";
export { TableArtifact, tableFrom } from "./TableArtifact";
export { SpreadsheetArtifact, spreadsheetFrom } from "./SpreadsheetArtifact";
export type { ResolvedSpreadsheet } from "./SpreadsheetArtifact";
export { SlideArtifact, slideDeckFrom } from "./SlideArtifact";
export type { ResolvedSlideDeck, ResolvedSlideBlock } from "./SlideArtifact";
export { DocumentArtifact, documentExportSections, documentFrom } from "./DocumentArtifact";
export { ScenarioArtifact, scenarioFrom } from "./ScenarioArtifact";
export { ComparisonArtifact, comparisonFrom } from "./ComparisonArtifact";
export { FindingArtifact, findingFrom } from "./FindingArtifact";

export {
  ARTIFACT_SPEC_VERSION,
  ARTIFACT_KINDS,
  CHART_FORMS,
  COLUMN_ROLES,
  COMPARISON_BASES,
  DRIVER_SPANS,
  EMPHASES,
  PRECISIONS,
  guardArtifactSpec,
  parseArtifactSpec,
  specViolationBrief,
} from "./artifactSpec";
export type {
  ArtifactKind,
  ArtifactSpec,
  ChartForm,
  ChartSpec,
  ComparisonSpec,
  DocumentSpec,
  FindingSpec,
  ScenarioSpec,
  SlideSpec,
  SpecGuardResult,
  SpecViolation,
  SpreadsheetSpec,
  TableSpec,
} from "./artifactSpec";

export {
  ABSENT,
  citationFrom,
  figuresOf,
  makeResolver,
  precisionDigits,
  presentValues,
  resolveChart,
  resolveComparison,
  resolveTable,
} from "./artifactResolve";
export type {
  ArtifactCitation,
  ResolvedArtifact,
  ResolvedChart,
  ResolvedComparison,
  ResolvedFigure,
  ResolvedRow,
  ResolvedTable,
} from "./artifactResolve";

export {
  DEFAULT_BOX,
  barLayout,
  donutLayout,
  lineLayout,
  scaleOf,
  stackLayout,
  waterfallLayout,
} from "./artifactGeometry";

export {
  AT_REST,
  DRIVERS,
  OUTPUTS,
  PARITY_EPSILON,
  SCENARIO_REGISTRY,
  evaluateExclusion,
  evaluateScenario,
  restPositions,
  spanFor,
} from "./artifactScenario";
export type { OutputReading, ScenarioReading } from "./artifactScenario";

export {
  REFINE_VOCABULARY,
  applyRefine,
  canRedo,
  canUndo,
  currentVersion,
  newHistory,
  parseRefineDirective,
  planRefine,
  pushVersion,
  redo,
  undo,
} from "./artifactRefine";
export type { ArtifactHistory, RefineDirective, RefinePlan, RefineState } from "./artifactRefine";
