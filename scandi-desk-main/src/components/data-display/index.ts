// Barrel for mobile-consolidation primitives. Import from this file rather
// than from individual modules so call sites stay short and the API surface
// is visible in one place.
//
//   import { DataCard, PeriodComparisonCard, ResponsiveTable } from
//     "@/components/data-display";
//
// See each module's docstring for usage details + when-to-use guidance.

export { DataCard } from "./DataCard";
export type { DataCardProps } from "./DataCard";

export { PeriodComparisonCard } from "./PeriodComparisonCard";
export type { PeriodComparisonCardProps } from "./PeriodComparisonCard";

export { ResponsiveTable } from "./ResponsiveTable";
export type { ColumnDef, ResponsiveTableProps } from "./ResponsiveTable";
