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

export const SAMPLE_DATASETS: SampleEntry[] = SAMPLES_ENABLED ? SYNTHETIC_SAMPLES : [];
