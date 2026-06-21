// Sample financial-statement datasets.
//
// Production-default: NO samples. The MVP is upload-first; users see the
// "Upload your trial balance" surface, not a sample picker. The previous
// fixtures (based on real customer data) were deleted in Step 1 of the
// REAL-AUTH prompt. This file remains so internal teams can reintroduce
// dev-only fictional samples behind the VITE_ENABLE_SAMPLES env flag.
//
// To enable samples for development:
//   echo "VITE_ENABLE_SAMPLES=true" >> .env.local
// then add fictional entries to the SAMPLES array below. Every number must
// be invented; every entity name must be fictional. Do NOT seed real
// company data, customer names, banks, addresses, or registration numbers.

import type { Statements } from "@/lib/financialReport";
import type { DocumentType } from "@/lib/financialStatementTabs";
import type { Invoice } from "@/lib/invoiceAnalytics";
import { isPublicTestMode } from "@/lib/testMode";
import { DEMO_COMPANY, DEMO_SAMPLE_ID } from "@/lib/demo/demoCompany";
import { buildDemoStatements } from "@/lib/demo/demoFinancials";

export interface SampleEntry {
  id: string;
  label: string;
  description: string;
  /** What document types this sample represents — drives tab visibility on the
   *  Dashboard. A sample with `["bilant","pl"]` unlocks the Statements / Ratios
   *  / Valuation / Risks tabs but not Customers/Payments. */
  availableTypes: DocumentType[];
  /** Statements payload — present when the sample includes BS / P&L data. */
  statements?: Statements;
  /** Invoice register — produced lazily to keep the bundle small. */
  invoicesGetter?: () => Invoice[];
}

/** Toggled via VITE_ENABLE_SAMPLES at build time. Production builds leave
 *  this unset → samples never render, sample picker UI never mounts. */
export const SAMPLES_ENABLED: boolean =
  import.meta.env.VITE_ENABLE_SAMPLES === "true";

/** When SAMPLES_ENABLED is false (the production default), this is always [].
 *  When the flag is set, internal teams can populate this with fictional
 *  samples for development. Keep the array empty in committed source. */
const SYNTHETIC_SAMPLES: SampleEntry[] = [];

/** F6.1 (2026-06-21) — The Meridian demo company. A fully FICTIONAL
 *  five-year mid-market food manufacturer (every number invented; verified
 *  by the discretion test in demo/__tests__/f61.test.ts). Surfaced ONLY on
 *  the public/marketing surface (`isPublicTestMode`) or when the dev samples
 *  flag is set — never in a real signed-in production build. It carries
 *  `historicalPeriods` so the Trend view, variance and scenarios all have
 *  multi-year history to run on through the same pipeline as a real upload.
 *  Lazily built once at module load (pure, no IO). */
const DEMO_SAMPLE: SampleEntry = {
  id: DEMO_SAMPLE_ID,
  label: DEMO_COMPANY.name,
  description: DEMO_COMPANY.description,
  // Unlocks Statements / Ratios / Valuation / Risks — the dashboard surfaces
  // the demo is meant to showcase. No invoice register (Customers/Payments
  // tabs stay locked, which is honest — the demo has no AR ledger).
  availableTypes: ["bilant", "pl"],
  statements: buildDemoStatements(),
};

/** The demo is shown on the public/marketing surface and in dev-samples
 *  builds; a real signed-in production build (neither flag set) sees []. */
const SHOW_DEMO = isPublicTestMode || SAMPLES_ENABLED;

export const SAMPLE_DATASETS: SampleEntry[] = SHOW_DEMO
  ? [DEMO_SAMPLE, ...SYNTHETIC_SAMPLES]
  : [];
