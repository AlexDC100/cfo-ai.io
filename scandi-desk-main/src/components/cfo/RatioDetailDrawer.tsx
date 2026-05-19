// RatioDetailDrawer — premium 8-section explainer surface.
//
// Opens when the user clicks a ratio tile on the Dashboard Ratios tab.
// Reads from:
//   · the live `Ratio` object (label, value, unit, verdict, benchmark,
//     commentary) — these are the company's CURRENT figures
//   · the static `ratioKnowledge.ts` map — formula / definition /
//     why-it-matters / good-range / common-drivers / related ratios
//
// The 8 sections mirror the spec's exact list:
//   1. What the ratio is
//   2. Formula / how it's computed
//   3. Why it matters
//   4. What a good range generally looks like
//   5. What this company's value means
//   6. What may be driving it
//   7. What management should pay attention to (derived from verdict)
//   8. Related ratios / related sections
//
// Clicking a related-ratio chip rewires the drawer to that ratio without
// closing — the explorer flow the spec calls for.

import { useCallback, useMemo } from "react";
import { ExternalLink, Calculator, Info, Target, TrendingUp, GaugeCircle, Lightbulb, Layers, ArrowRight } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  formatRatio,
  verdictColor,
  verdictLabel,
  type Ratio,
  type RatioBundle,
  type RatioVerdict,
} from "@/lib/financialReport";
import { getRatioKnowledge, type RatioKnowledge } from "@/lib/ratioKnowledge";

interface Props {
  /** The ratio to explain. `null` closes the drawer. */
  ratio: Ratio | null;
  /** Live ratios bundle — used to resolve related-ratio links so the
   *  user can pivot inside the drawer without a round-trip. */
  bundle: RatioBundle | null;
  /** Called when the drawer closes (overlay click / Escape / X). */
  onClose: () => void;
  /** Called when the user clicks a related-ratio chip — parent swaps
   *  the active ratio so the drawer re-renders for the new one. */
  onPickRelated: (next: Ratio) => void;
}

export function RatioDetailDrawer({ ratio, bundle, onClose, onPickRelated }: Props) {
  const open = ratio !== null;
  const knowledge = useMemo(() => (ratio ? getRatioKnowledge(ratio) : null), [ratio]);

  // Build a quick lookup of every Ratio in the bundle by key so the
  // related-chip click can pivot without the parent rebuilding any map.
  const ratioByKey = useMemo(() => {
    const m = new Map<string, Ratio>();
    if (!bundle) return m;
    for (const arr of [
      bundle.liquidity, bundle.profitability, bundle.leverage,
      bundle.coverage, bundle.efficiency, bundle.bankruptcy,
    ]) {
      for (const r of arr) m.set(r.key, r);
    }
    return m;
  }, [bundle]);

  const pickRelated = useCallback((key: string) => {
    const r = ratioByKey.get(key);
    if (r) onPickRelated(r);
  }, [ratioByKey, onPickRelated]);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="right"
        className="
          w-full sm:max-w-[520px] p-0
          bg-bg border-l border-rule
          flex flex-col
        "
        data-testid="ratio-detail-drawer"
      >
        {/* Radix requires a SheetTitle for a11y. Visually-hidden because
         *  we render our own designed header below. */}
        <SheetTitle className="sr-only">
          {ratio ? `${ratio.label} — detailed explanation` : "Ratio detail"}
        </SheetTitle>
        <SheetDescription className="sr-only">
          {ratio ? knowledge?.definition ?? "" : ""}
        </SheetDescription>

        {ratio && knowledge && (
          <DrawerBody
            ratio={ratio}
            knowledge={knowledge}
            ratioByKey={ratioByKey}
            onPickRelated={pickRelated}
          />
        )}

        {ratio && !knowledge && <FallbackBody ratio={ratio} />}
      </SheetContent>
    </Sheet>
  );
}

// ─── Drawer body ─────────────────────────────────────────────────
function DrawerBody({
  ratio, knowledge, ratioByKey, onPickRelated,
}: {
  ratio: Ratio;
  knowledge: RatioKnowledge;
  ratioByKey: Map<string, Ratio>;
  onPickRelated: (key: string) => void;
}) {
  const c = verdictColor(ratio.verdict);
  const focusLine = focusForVerdict(ratio.verdict, ratio.label);

  return (
    <div className="flex flex-col h-full">
      {/* ── Header / hero ─────────────────────────────────────────── */}
      <header className="relative overflow-hidden px-6 sm:px-7 pt-7 pb-5 border-b border-rule bg-gradient-to-br from-bg-2/30 via-surface to-surface">
        <div aria-hidden className="pointer-events-none absolute -top-12 -right-10 h-44 w-44 rounded-full bg-brand/10 blur-3xl" />

        <div className="relative">
          <div className="flex items-center gap-2 mb-2.5">
            <CategoryChip category={knowledge.category} />
          </div>
          <h2 className="text-[22px] sm:text-[24px] leading-tight font-semibold tracking-[-0.01em] text-ink">
            {ratio.label}
          </h2>
          <p className="mt-1.5 text-[13px] text-ink-soft leading-relaxed">
            {knowledge.definition}
          </p>

          {/* Current value + verdict pill */}
          <div className="mt-4 flex items-end justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
                This company
              </div>
              <div className="mt-0.5 text-[34px] sm:text-[38px] leading-none font-semibold tabular-nums text-ink">
                {formatRatio(ratio)}
              </div>
            </div>
            <span
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[10.5px] font-semibold uppercase tracking-[0.08em]"
              style={{ backgroundColor: c.bg, color: c.text }}
            >
              {verdictLabel(ratio.verdict)}
            </span>
          </div>
        </div>
      </header>

      {/* ── Scrollable body — 8 explainer sections ───────────────── */}
      <div className="flex-1 overflow-y-auto px-6 sm:px-7 py-6 space-y-6">

        {/* 2. Formula */}
        <Section icon={Calculator} title="Formula">
          <code className="block rounded-lg bg-bg-2/60 border border-rule px-3.5 py-2.5 text-[13px] font-mono text-ink tracking-[0.005em]">
            {knowledge.formula}
          </code>
        </Section>

        {/* 3. Why it matters */}
        <Section icon={Info} title="Why it matters">
          <p className="text-[13.5px] text-ink-soft leading-relaxed">
            {knowledge.whyItMatters}
          </p>
        </Section>

        {/* 4. What good looks like */}
        <Section icon={Target} title="What good looks like">
          <p className="text-[13.5px] text-ink-soft leading-relaxed">
            {knowledge.goodRange}
          </p>
          <div className="mt-2 text-[11.5px] text-ink-mute">
            Indicative range — varies by industry, capital structure, and stage.
          </div>
        </Section>

        {/* 5. What this company's value means */}
        <Section icon={GaugeCircle} title="What this value means">
          <div className="rounded-xl border border-rule bg-surface p-4">
            <div className="text-[12px] text-ink-mute mb-1.5">
              {ratio.benchmark}
            </div>
            <p className="text-[13.5px] text-ink leading-relaxed">
              {ratio.commentary}
            </p>
          </div>
        </Section>

        {/* 6. What may be driving it */}
        <Section icon={TrendingUp} title="What may be driving it">
          <ul className="space-y-1.5">
            {knowledge.drivers.map((d) => (
              <li key={d} className="flex items-start gap-2 text-[13px] text-ink-soft leading-snug">
                <span aria-hidden className="mt-1.5 h-1 w-1 rounded-full bg-brand-d shrink-0" />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </Section>

        {/* 7. What management should focus on */}
        <Section icon={Lightbulb} title="What to focus on">
          <p className="text-[13.5px] text-ink-soft leading-relaxed">
            {focusLine}
          </p>
        </Section>

        {/* 8. Related ratios / sections */}
        <Section icon={Layers} title="Related metrics">
          <div className="flex flex-wrap gap-1.5">
            {knowledge.related.map((k) => {
              const r = ratioByKey.get(k);
              if (!r) return null;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => onPickRelated(k)}
                  className="
                    group inline-flex items-center gap-1.5
                    h-8 px-3 rounded-full
                    border border-rule bg-surface
                    text-[12px] text-ink-soft hover:text-ink
                    hover:border-brand/30 hover:bg-brand/[0.04]
                    transition-colors
                  "
                  data-testid="ratio-related-chip"
                >
                  <span>{r.label}</span>
                  <span className="text-ink-mute group-hover:text-brand-d tabular-nums">
                    {formatRatio(r)}
                  </span>
                  <ArrowRight size={11} strokeWidth={1.75} className="text-ink-mute group-hover:text-brand-d transition-colors" />
                </button>
              );
            })}
          </div>
        </Section>

        {/* Cross-link to the export report (institutional memo) for the
         *  reader who wants the full context, not just one ratio. */}
        <a
          href="/report"
          className="
            mt-2 inline-flex items-center gap-1.5
            text-[12.5px] text-ink-soft hover:text-ink underline-offset-2 hover:underline
          "
        >
          See this ratio inside the full report
          <ExternalLink size={11} strokeWidth={1.75} />
        </a>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────
function Section({
  icon: Icon, title, children,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center justify-center h-5 w-5 rounded-md bg-bg-2/60 text-ink-mute">
          <Icon size={11} strokeWidth={1.75} />
        </span>
        <h3 className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
          {title}
        </h3>
      </div>
      <div>{children}</div>
    </section>
  );
}

function CategoryChip({ category }: { category: RatioKnowledge["category"] }) {
  // Restrained category palette — soft tints, not loud fills.
  const palette: Record<RatioKnowledge["category"], { bg: string; text: string; label: string }> = {
    liquidity:     { bg: "bg-[#EDF1F6] dark:bg-[hsl(210,40%,18%)]", text: "text-[#1E3A5F] dark:text-[hsl(210,40%,80%)]", label: "Liquidity" },
    profitability: { bg: "bg-[#EEF4F0] dark:bg-[hsl(141,30%,14%)]", text: "text-[#1E5C3F] dark:text-[hsl(141,40%,72%)]", label: "Profitability" },
    leverage:      { bg: "bg-[#F1EDF6] dark:bg-[hsl(265,30%,18%)]", text: "text-[#4A2E6A] dark:text-[hsl(265,40%,80%)]", label: "Leverage" },
    coverage:      { bg: "bg-[#F6EFE2] dark:bg-[hsl(37,40%,18%)]",  text: "text-[#6F5400] dark:text-[hsl(37,55%,75%)]",  label: "Coverage" },
    efficiency:    { bg: "bg-[#E8F1F4] dark:bg-[hsl(195,30%,16%)]", text: "text-[#1A4A57] dark:text-[hsl(195,40%,76%)]", label: "Efficiency" },
    distress:      { bg: "bg-[#F4E8E8] dark:bg-[hsl(0,30%,18%)]",   text: "text-[#7A1F1F] dark:text-[hsl(0,40%,80%)]",   label: "Distress" },
  };
  const c = palette[category];
  return (
    <span className={`inline-flex items-center h-5 px-2 rounded-md text-[10px] uppercase tracking-[0.1em] font-semibold ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  );
}

// "What to focus on" copy — derived from the verdict so the same ratio
// reads differently depending on the company's actual standing. The
// guidance lines are intentionally calm and observation-shaped, not
// imperative — recommendations are the engine's job; this is just
// orientation.
function focusForVerdict(verdict: RatioVerdict, label: string): string {
  switch (verdict) {
    case "strong":
      return `${label} is in a strong position. Keep monitoring trend lines; a single strong reading can mask a deteriorating trajectory if not re-checked next period.`;
    case "healthy":
      return `${label} reads as healthy. The watch-out is direction — a healthy current value can drift to "watch" inside one quarter if the underlying driver moves.`;
    case "watch":
      return `${label} is in the watch zone. This is the right point to dig into the drivers above before the metric moves into critical territory.`;
    case "critical":
      return `${label} reads as critical. This is the metric to bring to the next board / management meeting alongside a clear plan touching the drivers above.`;
  }
}

// Fallback for ratios that don't yet have a knowledge entry. Keeps the
// drawer from being awkward if a future ratio key ships without docs.
function FallbackBody({ ratio }: { ratio: Ratio }) {
  return (
    <div className="px-6 py-8">
      <h2 className="text-[22px] font-semibold text-ink leading-tight">{ratio.label}</h2>
      <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed">{ratio.commentary}</p>
      <div className="mt-4 text-[12px] text-ink-mute">{ratio.benchmark}</div>
    </div>
  );
}
