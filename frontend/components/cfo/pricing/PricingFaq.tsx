// PricingFaq.tsx — accordion FAQ rendered at the bottom of the /pricing
// page.
//
// Native <details>/<summary> is used over a custom accordion so:
//   · keyboard navigation works out of the box (Space/Enter toggle)
//   · screen readers announce open/closed state without extra ARIA
//   · no animation-library dependency for what is, fundamentally,
//     a disclosure widget
//
// THE COPY IS IN THE DICTIONARIES (`pricingFaq.*`, both languages), and it
// is a harvested surface of the gate `public-claims`. Until 2026-10-02 the
// answers were typed here, in English only — so the Romanian pricing page
// showed an English FAQ — and three of them were false on a public page:
//
//   · "A document is … a trial balance, a balance sheet, a P&L, or an
//     annual report": the engine reads Romanian trial balances; the other
//     three need the AI reader, whose availability is a row of
//     frontend/data/coverage.json. The answer now says that and prints that
//     row's status ({{aiStatus}}) rather than a typed word.
//   · "Ask CFO AI is available after launch": the feature registry has had
//     `chat_page` active for weeks and the landing sells it as a module.
//   · "What happens if billing is not wired yet? In development, billing
//     actions use mock billing…": developer copy. Removed.

import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { proofTokens } from "@/lib/engineProof";
import { PLAN_PRICES_EUR, formatPrice } from "@/lib/price";

/** The questions, in order. `key` is the dictionary entry under
 *  `pricingFaq`; `testId` is stable for the copy gates. */
const FAQ: Array<{ key: string; testId: string }> = [
  { key: "whatCounts", testId: "faq-what-counts" },
  { key: "quotaHit", testId: "faq-quota-hit" },
  { key: "introSubscription", testId: "faq-intro-subscription" },
  { key: "rollover", testId: "faq-rollover" },
  { key: "movePlans", testId: "faq-move-plans" },
  { key: "chatCap", testId: "faq-chat-cap" },
];

export function PricingFaq() {
  const { t, i18n } = useTranslation();
  // The AI reader's status and the chat's are coverage.json's, through the
  // same tokens the landing copy uses — never a word typed here.
  const tokens = proofTokens(i18n.language);
  const values = {
    aiStatus: tokens["coverage.ai_read.availability_lc"] ?? t("pricingFaq.aiReaderAvailable"),
    chatStatus: tokens["coverage.chat.status"] ?? "",
    // The intro price through the one price printer — the question used to
    // carry a typed "€0.99" / "0,99 €".
    introPrice: formatPrice(PLAN_PRICES_EUR.intro, i18n.language),
  };
  return (
    <section
      data-testid="pricing-faq"
      aria-label={t("pricingFaq.aria")}
      className="max-w-[760px] mx-auto px-5 sm:px-8 py-12"
    >
      <header className="text-center mb-8">
        <div className="text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-medium">
          {t("pricingFaq.eyebrow")}
        </div>
        <h2 className="mt-2 font-serif text-[28px] sm:text-[34px] leading-[1.1] text-ink">
          {t("pricingFaq.title")}
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
                <span className="flex-1">{t(`pricingFaq.${item.key}.q`, values)}</span>
                <ChevronDown
                  size={14}
                  strokeWidth={2}
                  className="text-ink-mute transition-transform group-open:rotate-180 shrink-0"
                />
              </summary>
              <p className="mt-2 text-[12.5px] text-ink-soft leading-relaxed">
                {t(`pricingFaq.${item.key}.a`, values)}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
