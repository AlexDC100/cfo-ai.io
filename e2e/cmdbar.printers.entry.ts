/// <reference path="../frontend/vite-env.d.ts" />
// ↑ The printers are app code and read `import.meta.env` (the app's own
//   declaration, as tsconfig.app.json sees it); without it the e2e project
//   — which type-checks this file (scripts/check_tsc.mjs) — reports every
//   `import.meta.env` the printers pull in as a new TS2339.
/**
 * The app's OWN served-figure printers, for the command bar's live
 * served-equality gate (e2e/design/cmdbar.spec.ts, G6).
 *
 * The spec bundles THIS file with esbuild (the same source the production
 * bundle compiles, not a copy) and loads it into a blank page of the SAME
 * browser that runs the bar, so the expected string is produced by the same
 * code on the same Intl/ICU as the painted one. The gate then holds the bar
 * to: the served value (read from the body the double served) printed by
 * the shared printer. A bar that reads another field — metrics[] for a
 * ratio, a bucket for a leaf, the reconstruction for the net result — paints
 * a different string and reds; a printer defect common to both sides is the
 * printer's own gate's to find (ratioTableByteMatch, money tests).
 *
 * Not part of the product bundle: nothing under frontend/ imports it.
 */
import { formatAmountFrom, formatMoneyFrom } from "@/lib/money";
import { formatRatioSide } from "@/lib/ratioTable";

(globalThis as unknown as Record<string, unknown>).__cmdbarPrinters = { formatAmountFrom, formatMoneyFrom, formatRatioSide };
