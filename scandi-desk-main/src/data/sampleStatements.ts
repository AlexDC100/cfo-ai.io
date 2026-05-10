// Sample financial-statement datasets.
//
// REAL-AUTH Step 1: previously-shipped fixtures based on real customer data
// (a private real-estate operator and a private FMCG distributor) have been
// deleted from this file. Step 2 of the same prompt replaces them with
// synthetic fictional samples gated behind VITE_ENABLE_SAMPLES, OR removes
// the sample picker entirely from production builds. Until that lands, the
// SAMPLE_DATASETS array is empty — the Dashboard's empty state shows the
// upload-first surface (Step 4).
//
// Do NOT add new sample entries to this file without ensuring every number
// is invented and every entity name is fictional.

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

/** Empty by default. Step 2 of the REAL-AUTH prompt populates this with
 *  synthetic fictional samples (Option B) or leaves it empty under a dev
 *  env flag (Option A). */
export const SAMPLE_DATASETS: SampleEntry[] = [];
