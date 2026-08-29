// UpcomingInvoicePreview.tsx — WS2 live counter for Settings → Billing.
//
// Reads /api/billing/upcoming-invoice every 60s. Shows base + accumulated
// metered overages + total, with the next invoice date. Renders nothing
// when the user has no active subscription (trial / pre-checkout) so
// BillingSection's layout stays clean for those users.
//
// COPY (intentionally terse — this lives below "Current plan" and
// above "Manage subscription", so users scan it):
//
//   Next invoice · 25 Jun 2026
//   €14.99  base
//   +€9.00  3 extra documents
//   ─────
//   €23.99  estimated total
//
// When extras_count is 0, the "+€0.00" line is hidden to avoid noise.

import { formatEur } from "@/lib/pricingConfig";
import { useUpcomingInvoice } from "@/lib/stripeBilling";
import { formatDateOnly } from "@/lib/locale";

export function UpcomingInvoicePreview() {
  const { data } = useUpcomingInvoice();

  // Nothing to show → render nothing. That covers both "still loading" and
  // "no active subscription".
  //
  // The loading state used to be a bordered "Loading upcoming invoice…"
  // spinner card. It was there to stop the page jumping on refetch, but in
  // practice it did the opposite: users without a Stripe subscription —
  // the majority — saw a box appear and then disappear on every mount,
  // announcing an invoice they were never going to get.
  if (!data) return null;

  const { base_amount, extras_count, extras_amount, total_estimated, next_invoice_date } = data;
  const nextDateLabel = next_invoice_date
    ? formatDateOnly(next_invoice_date)
    : "—";

  return (
    <section
      data-testid="upcoming-invoice"
      className="rounded-xl border border-rule/60 bg-bg-2/40 px-4 py-3.5"
    >
      <header className="flex items-baseline justify-between mb-2.5">
        <span className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
          Next invoice
        </span>
        <span
          data-testid="upcoming-invoice-date"
          className="text-[12px] text-ink-soft tabular-nums"
        >
          {nextDateLabel}
        </span>
      </header>

      <dl className="space-y-1.5 text-[13px]">
        <div className="flex items-baseline justify-between">
          <dt className="text-ink-soft">Base plan</dt>
          <dd
            data-testid="upcoming-invoice-base"
            className="font-medium text-ink tabular-nums"
          >
            {formatEur(base_amount)}
          </dd>
        </div>

        {extras_count > 0 && (
          <div className="flex items-baseline justify-between">
            <dt className="text-ink-soft">
              {extras_count} extra document{extras_count > 1 ? "s" : ""}
            </dt>
            <dd
              data-testid="upcoming-invoice-extras"
              className="font-medium text-brand tabular-nums"
            >
              +{formatEur(extras_amount)}
            </dd>
          </div>
        )}

        <div className="flex items-baseline justify-between border-t border-rule/60 pt-1.5 mt-1.5">
          <dt className="text-[12.5px] font-medium text-ink">Estimated total</dt>
          <dd
            data-testid="upcoming-invoice-total"
            className="text-[14px] font-semibold text-ink tabular-nums"
          >
            {formatEur(total_estimated)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
