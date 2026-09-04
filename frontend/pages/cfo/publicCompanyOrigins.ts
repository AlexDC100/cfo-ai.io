// WHERE A PUBLIC-COMPANY FIGURE COMES FROM — the origin helpers the
// PublicCompanyDashboard hands to the provenance affordance.
//
// A `PublicCompanyPeriod` names its own origin: `source` is the vendor
// dataset it was normalised from ("nasdaq_sharadar_sf1"),
// `normalizer_version` the mapping that filed it, `fiscal_period_end`
// the period. A figure read off the period names the field it was read
// from; a ratio `computeRatios` derived on the client says so in its
// method and names the feed its inputs came from.
//
// THE MARKET BLOCK IS NOT A PERIOD. It carries its own `as_of` — the day
// the price was observed — which is not the fiscal period and is not
// filed as one: a market tile carries the observation day as computedAt
// and NO Period row. Until 2026-09-04 one helper set `period:
// fiscal_period_end` on every figure and spread the market block's
// extras AFTER it, so Market Cap, EV and P/E each opened a card filing a
// price day under a fiscal year-end (critic finding #6, ea6df1f).
//
// Own module, not exports off the page: `react-refresh/only-export-
// components` warns on a page that exports helpers, and the unit test
// wants them without mounting a route.

import { provenanceOf, type AmountProvenance } from "@/components/instrument/Provenance";
import type { PublicCompanyPeriod } from "@/lib/publicCompanyApi";

/** A figure READ off the period's own fields — headline revenue, a
 *  balance-sheet total. Names the served field, the pack that filed it,
 *  and the fiscal period the figure belongs to. */
export function periodFieldOrigin(p: PublicCompanyPeriod, field: string): AmountProvenance | null {
  return provenanceOf({
    source: `${p.source} · ${field}`,
    pack: p.normalizer_version,
    period: p.fiscal_period_end,
  });
}

/** A MARKET figure — market cap, EV, a multiple over the observed price.
 *  Names the served field, the pack that filed it and the day it was
 *  observed. No period: a price is as of a day, not a fiscal year. */
export function marketFieldOrigin(
  p: PublicCompanyPeriod,
  field: string,
  asOf: string,
): AmountProvenance | null {
  return provenanceOf({
    source: `${p.source} · market_metrics.${field}`,
    pack: p.normalizer_version,
    computedAt: asOf,
  });
}

/** A ratio this client derived from the period's fields. Names the feed
 *  its inputs came from and the derivation; keeps the fiscal period,
 *  because a ratio over a fiscal period belongs to one. */
export function derivedRatioOrigin(p: PublicCompanyPeriod, key: string): AmountProvenance | null {
  return provenanceOf({
    source: p.source,
    method: `derived · computeRatios · ${key}`,
    pack: p.normalizer_version,
    period: p.fiscal_period_end,
  });
}
