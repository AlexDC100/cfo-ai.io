// PricingFaq.tsx — accordion FAQ rendered at the bottom of the /pricing
// page. The 7 questions + answers are taken verbatim from the redesign
// spec §9; copy is the contract.
//
// Native <details>/<summary> is used over a custom accordion so:
//   · keyboard navigation works out of the box (Space/Enter toggle)
//   · screen readers announce open/closed state without extra ARIA
//   · no animation-library dependency for what is, fundamentally,
//     a disclosure widget
//
// The DOM exposes data-testid for each item so a future copy-hygiene
// grep can find this surface directly (e.g. asserting "What counts as a
// document" exists, asserting the intro-not-subscription answer exists).

import { ChevronDown } from "lucide-react";

interface FaqItem {
  q: string;
  a: string;
  testId: string;
}

const FAQ: FaqItem[] = [
  {
    testId: "faq-what-counts",
    q: "What counts as a document?",
    // 2026-09-06 — the earlier answer listed "public filing, invoice
    // export, or inventory report" as things a document can be. In the
    // registry `public_records` is hidden and `upload_invoice` /
    // `upload_inventory` are coming_soon, so three of the five examples
    // named ingest this release does not run. The list now names only
    // what the pipeline accepts today, and says where the rest sits.
    a:
      "A document is one uploaded file that CFO AI analyzes — a trial " +
      "balance, a balance sheet, a P&L, or an annual report. Invoice and " +
      "inventory ingest are on the roadmap and are not part of this release.",
  },
  {
    testId: "faq-quota-hit",
    q: "What happens when I hit my included document quota?",
    a:
      "You will see the extra-document price before processing. " +
      "CFO AI never charges silently.",
  },
  {
    testId: "faq-intro-subscription",
    q: "Is the €0.99 Intro Unlock a subscription?",
    a: "No. It is a one-time 7-day unlock for one extra document.",
  },
  {
    testId: "faq-rollover",
    q: "Do unused documents roll over?",
    a: "No. Included documents reset each billing period.",
  },
  {
    testId: "faq-move-plans",
    q: "Can I move between plans?",
    a: "Yes. You can upgrade or downgrade from Billing.",
  },
  {
    testId: "faq-chat-cap",
    q: "Are Ask CFO AI messages capped?",
    // 2026-09-06 — the previous answer ("The app shows your daily and
    // monthly usage") described a surface this release does not serve:
    // the registry has `chat_page` hidden, so /chat renders "Not in this
    // release". The answer now states the position instead of implying
    // chat is live.
    a:
      "Ask CFO AI is available after launch. When it opens, each plan " +
      "carries a daily and a monthly message cap, shown in the app. Chat " +
      "is capped rather than metered — it is never billed per message.",
  },
  {
    testId: "faq-billing-not-wired",
    q: "What happens if billing is not wired yet?",
    a:
      "In development, billing actions use mock billing only if enabled. " +
      "In production, paid extra documents require the payment provider " +
      "to be connected.",
  },
];

export function PricingFaq() {
  return (
    <section
      data-testid="pricing-faq"
      aria-label="Frequently asked questions"
      className="max-w-[760px] mx-auto px-5 sm:px-8 py-12"
    >
      <header className="text-center mb-8">
        <div className="text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-medium">
          FAQ
        </div>
        <h2 className="mt-2 font-serif text-[28px] sm:text-[34px] leading-[1.1] text-ink">
          Questions, answered.
        </h2>
      </header>
      <ul className="space-y-2">
        {FAQ.map((item) => (
          <li key={item.testId}>
            <details
              data-testid={item.testId}
              className="
                group rounded-xl border border-rule bg-surface/60 backdrop-blur-sm
                px-4 sm:px-5 py-3
                open:bg-surface/80 transition-colors
              "
            >
              <summary
                className="
                  flex items-center justify-between gap-3 cursor-pointer
                  text-[13.5px] font-medium text-ink
                  list-none [&::-webkit-details-marker]:hidden
                  outline-none focus-visible:ring-2 focus-visible:ring-brand/40 rounded-md
                "
              >
                <span className="flex-1">{item.q}</span>
                <ChevronDown
                  size={14}
                  strokeWidth={2}
                  className="text-ink-mute transition-transform group-open:rotate-180 shrink-0"
                />
              </summary>
              <p className="mt-2 text-[12.5px] text-ink-soft leading-relaxed">
                {item.a}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
