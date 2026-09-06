// MonthlyBillEstimator.tsx — interactive sliders + live Starter/Pro
// total. Spec §8: two sliders (documents/month, chat messages/month)
// drive an informational bill estimate. Seats slider is omitted —
// seats are not implemented in the backend (per spec §8: "do not show
// it" if not implemented).
//
// What it computes per plan:
//   base                = plan.price_eur
//   included            = plan.included_docs
//   extras              = max(0, docs - included)
//   extras_charge       = extras × plan.extra_doc_eur
//   estimated_total     = base + extras_charge
//
// 2026-09-06 — THE CHAT DIMENSION IS GONE. The card used to carry a
// second slider ("Ask CFO AI messages per month", 0–500) and a per-plan
// "Fits cap / Over cap" verdict. It never affected the estimated bill —
// chat is capped, not metered in EUR — so it sized an allowance rather
// than a price. The registry has `chat_page` = hidden for this release
// (every ask affordance routes to /chat, which renders PendingState), so
// the slider invited a visitor to dimension their plan on a surface the
// product does not serve. Dropping the dimension is the smaller, honest
// change: no caveat to read, nothing to mis-size. The chat ALLOWANCE
// itself still appears on the plan cards, explicitly marked as available
// after launch (see lib/planFeatures.ts).
//
// Spec §8: "Do not charge inside estimator. It is informational only."
// → No CTA on this card. Users go up to the plan cards to actually pick.

import { useMemo, useState } from "react";
import { UploadCloud } from "lucide-react";

import {
  type PlanConfig,
  type PricingPublicConfig,
  formatEur,
  purchasablePaidPlans,
} from "@/lib/pricingConfig";

interface Props {
  config: PricingPublicConfig;
}

export function MonthlyBillEstimator({ config }: Props) {
  const [docs, setDocs] = useState(7);

  // Purchasable recurring plans only — trial/intro never appear (they're
  // acquisition-only, no "estimated monthly bill" concept), and retired
  // tiers (starter) must not be estimated for a plan nobody can buy.
  const recurring = useMemo(
    () => purchasablePaidPlans(config),
    [config],
  );

  return (
    <section
      data-testid="monthly-bill-estimator"
      className="max-w-[1080px] mx-auto px-5 sm:px-8 py-10"
    >
      <header className="text-center max-w-[640px] mx-auto mb-8">
        <div className="text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-medium">
          Estimate your monthly bill
        </div>
        <h2 className="mt-2 font-serif text-[26px] sm:text-[32px] leading-[1.1] text-ink">
          Match how your team actually works.
        </h2>
        <p className="mt-3 text-[13px] text-ink-soft">
          Slide to your real numbers — we'll show what each plan costs.
          Estimates only; you only get charged for extras you confirm.
        </p>
      </header>

      <div className="grid lg:grid-cols-[1fr_1.2fr] gap-6 items-start">
        {/* ── Sliders ─────────────────────────────────────────────── */}
        <div
          data-testid="estimator-sliders"
          className="rounded-2xl border border-rule bg-surface/60 backdrop-blur-sm p-5 space-y-5"
        >
          <Slider
            icon={UploadCloud}
            testId="estimator-docs-slider"
            label="Financial documents per month"
            value={docs}
            min={1}
            max={100}
            onChange={setDocs}
            valueLabel={`${docs} ${docs === 1 ? "document" : "documents"}`}
          />
        </div>

        {/* ── Plan estimates ──────────────────────────────────────── */}
        <div data-testid="estimator-results" className="space-y-3">
          {recurring.map((plan) => (
            <PlanEstimate key={plan.key} plan={plan} docs={docs} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Slider — labeled range input with value chip
// ─────────────────────────────────────────────────────────────────────

function Slider({
  icon: Icon,
  testId,
  label,
  value,
  min,
  max,
  onChange,
  valueLabel,
}: {
  icon: typeof UploadCloud;
  testId: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  valueLabel: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="inline-flex items-center gap-2 text-[12.5px] text-ink-soft">
          <Icon size={13} strokeWidth={1.75} />
          {label}
        </div>
        <div className="text-[12px] font-medium text-ink tabular-nums">
          {valueLabel}
        </div>
      </div>
      <input
        type="range"
        data-testid={testId}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="
          w-full h-1.5 rounded-full bg-rule appearance-none cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
          [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-brand
          [&::-webkit-slider-thumb]:shadow-[0_2px_6px_-2px_rgba(42,168,155,0.6)]
          [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4
          [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:bg-brand [&::-moz-range-thumb]:border-0
        "
      />
      <div className="mt-1 flex justify-between text-[10.5px] text-ink-mute tabular-nums">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// PlanEstimate — one plan's bill breakdown given the slider values
// ─────────────────────────────────────────────────────────────────────

function PlanEstimate({
  plan,
  docs,
}: {
  plan: PlanConfig;
  docs: number;
}) {
  const extras = Math.max(0, docs - plan.included_docs);
  const extraEur = plan.extra_doc_eur ?? 0;
  const extrasCharge = extras * extraEur;
  const total = plan.price_eur + extrasCharge;

  return (
    <article
      data-testid={`estimator-plan-${plan.key}`}
      className="rounded-2xl border border-rule bg-surface/70 backdrop-blur-sm px-5 py-4"
    >
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="font-serif text-[18px] text-ink leading-tight">
          {plan.display_name}
        </h3>
        <div
          data-testid={`estimator-${plan.key}-total`}
          className="text-[20px] font-semibold text-ink tabular-nums"
        >
          {formatEur(total)}
          <span className="ml-1 text-[11px] font-normal text-ink-soft">/ mo</span>
        </div>
      </header>
      <ul className="text-[12.5px] text-ink-soft space-y-1">
        <li className="flex justify-between">
          <span>Base ({plan.included_docs} included)</span>
          <span className="tabular-nums">{formatEur(plan.price_eur)}</span>
        </li>
        <li className="flex justify-between">
          <span>
            {extras > 0
              ? `${extras} extra ${extras === 1 ? "document" : "documents"} × ${formatEur(extraEur)}`
              : "0 extra documents"}
          </span>
          <span className="tabular-nums">{formatEur(extrasCharge)}</span>
        </li>
      </ul>
    </article>
  );
}
