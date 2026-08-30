// The findings surface — public entry points.
//
// Everything below renders the seven-element contract from
// `src/engine/api/_finding.py`. Nothing here computes a figure, decides
// materiality, ranks, or promotes a demoted row; see `@/lib/findings`
// for the one rule this layer applies and why it only moves downward.

export { FindingsPanel, type FindingsPanelProps } from "./FindingsPanel";
export { FindingCard, type FindingCardProps } from "./FindingCard";
export { AllChecksList } from "./AllChecksList";
export { SilenceCard } from "./SilenceCard";
export { EvidenceLine, ProvenanceDots } from "./EvidenceLine";
export { ThresholdMeter, comparatorWord, meterGeometry } from "./ThresholdMeter";
export { ImpactRow } from "./ImpactRow";
export { ActionChecklist } from "./ActionChecklist";
export { FindingActions } from "./FindingActions";
export { FigureValue, FigureCell, Chip, ElementLabel, asCurrency, toneFor } from "./parts";
