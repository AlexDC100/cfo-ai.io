// Raw SKU row as the upload mapper produces it and lib/api.ts / lib/runStore.ts
// consume it.
//
// This file used to carry a browser-side mirror of the classification engine
// (`aggregateRows` / `classify` / `autoMap` / `rowsFromSheet`). Nothing
// imported any of it — only this type — and the mirror floored
// anchorProfitShare and roicPct at 0 (with a [0, 1] clamp) where the served
// engine (src/engine/api/frontend.py) refuses them. Deleted 2026-09-19 so a
// dead floor cannot be revived by accident; the engine is the one authority.

export interface RawSkuRow {
  category: string;
  sku?: string;
  volumeT: number;        // tonnes
  revenue: number;        // RON (NIV)
  grossMarginPct: number; // % e.g. 12.4
  dioDays: number;        // days
  strategicFlag?: boolean;
}
