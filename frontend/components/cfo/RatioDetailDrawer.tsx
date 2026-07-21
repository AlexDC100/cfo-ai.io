// RatioDetailDrawer — Apple-style explainer card (Phase B redesign).
//
// Layout philosophy: one headline number per surface, an inline formula
// where every constituent is a clickable TraceableNumber that links to
// its source row on the BS / PL, a short two-line read, then the
// detailed 6-section explainer hidden behind an "Explain in detail"
// disclosure so it never dominates the card.
//
// What changed from the pre-Phase-B layout:
//   · The 8 dense sections collapsed: 5 (Why / What good looks like /
//     What may be driving it / What to focus on / Related metrics) sit
//     inside a single collapsible "Explain in detail" disclosure that
//     starts closed. The formula and "What this value means" remain
//     visible because they're the load-bearing pieces of the card.
//   · The formula section now renders `knowledge.formulaParts` as an
//     inline expression when present, with each constituent value
//     wrapped in `<TraceableNumber>` so clicking sends the user to
//     the source BS / PL row (scrolls + pulses for ~1500ms via
//     useHighlightFromUrl on the target page). Ratios without
//     formulaParts fall back to the plain `formula` string — zero
//     regression on the visual until they get migrated.
//   · "Open in full report" is now functional. Clicking closes the
//     drawer and navigates the parent route to the Balance Sheet tab
//     with the ratio's primary denominator highlighted — so the user
//     lands directly at the underlying number's source row.

import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { ExternalLink, Calculator, Info, Target, TrendingUp, GaugeCircle, Lightbulb, Layers, ArrowRight, ChevronDown } from "lucide-react";
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
  type Statements,
} from "@/lib/financialReport";
import { getRatioKnowledge, type RatioKnowledge, type FormulaPart } from "@/lib/ratioKnowledge";
import { resolveFormulaInput } from "@/lib/resolveFormulaInput";
import { TraceableNumber } from "./TraceableNumber";
import { STATEMENT_TAB, HIGHLIGHT_PARAM, TAB_PARAM } from "@/lib/traceableSource";
import { LearnableNumber } from "@/components/learning/LearnableNumber";

interface Props {
  /** The ratio to explain. `null` closes the drawer. */
  ratio: Ratio | null;
  /** Live ratios bundle — used to resolve related-ratio links so the
   *  user can pivot inside the drawer without a round-trip. */
  bundle: RatioBundle | null;
  /** Live company Statements — needed for the inline formula to pull
   *  actual source numbers (cash, AR, totalCurrentLiabilities, etc.)
   *  rather than printing the formula as inert text. */
  statements: Statements | null;
  /** Called when the drawer closes (overlay click / Escape / X). */
  onClose: () => void;
  /** Called when the user clicks a related-ratio chip — parent swaps
   *  the active ratio so the drawer re-renders for the new one. */
  onPickRelated: (next: Ratio) => void;
}

export function RatioDetailDrawer({ ratio, bundle, statements, onClose, onPickRelated }: Props) {
  const open = ratio !== null;
  const knowledge = useMemo(() => (ratio ? getRatioKnowledge(ratio) : null), [ratio]);

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
            statements={statements}
            ratioByKey={ratioByKey}
            onPickRelated={pickRelated}
            onClose={onClose}
          />
        )}

        {ratio && !knowledge && <FallbackBody ratio={ratio} />}
      </SheetContent>
    </Sheet>
  );
}

// ─── Drawer body ─────────────────────────────────────────────────
function DrawerBody({
  ratio, knowledge, statements, ratioByKey, onPickRelated, onClose,
}: {
  ratio: Ratio;
  knowledge: RatioKnowledge;
  statements: Statements | null;
  ratioByKey: Map<string, Ratio>;
  onPickRelated: (key: string) => void;
  onClose: () => void;
}) {
  const c = verdictColor(ratio.verdict);
  const focusLine = focusForVerdict(ratio.verdict, ratio.label);
  const [explainOpen, setExplainOpen] = useState(false);

  // Determine the primary denominator / source bucket for "Open in
  // full report" deep-linking. Picks the LAST `value` part in the
  // formula (typically the denominator) so the user lands on the
  // most context-rich row — Current liabilities for liquidity ratios,
  // Total equity for leverage ratios, etc. Falls back to nothing for
  // ratios without formulaParts; the button then closes without nav.
  const primarySource = (() => {
    if (!knowledge.formulaParts) return null;
    for (let i = knowledge.formulaParts.length - 1; i >= 0; i--) {
      const p = knowledge.formulaParts[i];
      if (p.kind === "value") return p.source;
    }
    return null;
  })();

  return (
    <div className="flex flex-col h-full">
      {/* ── Header / hero (compact, single number focus) ──────────── */}
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

          <div className="mt-4 flex items-end justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
                This company
              </div>
              <div className="mt-0.5 text-[34px] sm:text-[38px] leading-none font-semibold tabular-nums text-ink">
                <LearnableNumber conceptKey={ratio.key} value={ratio.value}>
                  {formatRatio(ratio)}
                </LearnableNumber>
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

      {/* ── Scrollable body — restructured layout ────────────────── */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-6 sm:px-7 py-6 space-y-5">

        {/* Inline formula — primary surface */}
        <Section icon={Calculator} title="Formula · live numbers">
          <FormulaDisplay ratio={ratio} knowledge={knowledge} statements={statements} />
          {knowledge.formulaParts && statements && (
            <p className="mt-2 text-[11px] text-ink-mute leading-relaxed">
              Tap any number to jump to its source row on the Balance Sheet.
            </p>
          )}
        </Section>

        {/* "What this value means" — the load-bearing line for the
         *  reader who's only going to scan one thing */}
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

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <ReportButton
            onClose={onClose}
            primarySource={primarySource}
          />
          <ExplainToggleButton
            open={explainOpen}
            onToggle={() => setExplainOpen((s) => !s)}
          />
        </div>

        {/* Collapsible deep-dive — Why / Good range / Drivers / Focus /
            Related metrics. Hidden by default; preserves all the
            engine-emitted content for the user who wants it. */}
        {explainOpen && (
          <div className="pt-1 space-y-5 border-t border-rule">
            <Section icon={Info} title="Why it matters">
              <p className="text-[13.5px] text-ink-soft leading-relaxed">
                {knowledge.whyItMatters}
              </p>
            </Section>

            <Section icon={Target} title="What good looks like">
              <p className="text-[13.5px] text-ink-soft leading-relaxed">
                {knowledge.goodRange}
              </p>
              <div className="mt-2 text-[11.5px] text-ink-mute">
                Indicative range — varies by industry, capital structure, and stage.
              </div>
            </Section>

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

            <Section icon={Lightbulb} title="What to focus on">
              <p className="text-[13.5px] text-ink-soft leading-relaxed">
                {focusLine}
              </p>
            </Section>

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
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inline formula display ──────────────────────────────────────
function FormulaDisplay({
  ratio, knowledge, statements,
}: {
  ratio: Ratio;
  knowledge: RatioKnowledge;
  statements: Statements | null;
}) {
  // Fallback: ratio doesn't yet have formulaParts, or we don't have
  // statements (e.g. during a tab switch while data reloads). Show
  // the static text formula — zero regression from pre-Phase-B.
  if (!knowledge.formulaParts || !statements) {
    return (
      <code className="block rounded-lg bg-bg-2/60 border border-rule px-3.5 py-2.5 text-[13px] font-mono text-ink tracking-[0.005em] overflow-x-auto whitespace-pre">
        {knowledge.formula}
      </code>
    );
  }

  return (
    <div className="rounded-lg bg-bg-2/60 border border-rule px-3.5 py-3 text-[13.5px] text-ink leading-relaxed">
      <div className="flex flex-wrap items-baseline gap-x-1 gap-y-1">
        {knowledge.formulaParts.map((part, i) => (
          <FormulaPartView key={i} part={part} statements={statements} />
        ))}
        <span className="text-ink-mute mx-1">=</span>
        <span className="font-semibold tabular-nums text-ink">
          {formatRatio(ratio)}
        </span>
      </div>
    </div>
  );
}

function FormulaPartView({ part, statements }: { part: FormulaPart; statements: Statements }) {
  if (part.kind === "text") {
    return <span className="text-ink-mute">{part.value}</span>;
  }
  const value = resolveFormulaInput(part.valueKey, statements);
  return (
    <span className="whitespace-nowrap">
      <span className="text-ink-soft text-[12px] mr-0.5">{part.label}</span>{" "}
      <TraceableNumber
        value={value}
        format="currency"
        source={part.source}
        className="text-ink font-medium"
      />
    </span>
  );
}

// ─── Buttons ─────────────────────────────────────────────────────
function ReportButton({
  onClose, primarySource,
}: {
  onClose: () => void;
  primarySource: ReturnType<typeof Object> | null;
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();

  // When the ratio has a known primary source, "Open in full report"
  // closes this drawer and navigates the dashboard to that source's
  // statement tab with the source bucket highlighted. The target
  // page's useHighlightFromUrl() hook (Phase A foundation) handles
  // the scroll + pulse so the user lands on the underlying number
  // in context.
  const handleClick = useCallback(() => {
    if (primarySource) {
      const next = new URLSearchParams(searchParams);
      const ps = primarySource as { statement: keyof typeof STATEMENT_TAB; bucket: string };
      next.set(TAB_PARAM, STATEMENT_TAB[ps.statement]);
      next.set(HIGHLIGHT_PARAM, ps.bucket);
      onClose();
      navigate({ pathname: location.pathname, search: `?${next.toString()}` });
    } else {
      // No primary source mapped for this ratio yet — fall back to
      // just closing the drawer so the user can navigate themselves.
      // Better than a dead button or a generic /report link to
      // nowhere.
      onClose();
    }
  }, [navigate, searchParams, location.pathname, primarySource, onClose]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="
        inline-flex items-center gap-1.5
        h-8 px-3.5 rounded-full
        border border-rule bg-surface
        text-[12.5px] font-medium text-ink hover:text-ink
        hover:border-brand/30 hover:bg-brand/[0.04]
        transition-colors
      "
      data-testid="ratio-open-in-full-report"
    >
      Open in full report
      <ExternalLink size={11} strokeWidth={1.75} />
    </button>
  );
}

function ExplainToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="
        inline-flex items-center gap-1.5
        h-8 px-3.5 rounded-full
        text-[12.5px] font-medium text-ink-soft hover:text-ink
        hover:bg-bg-2/60
        transition-colors
      "
      data-testid="ratio-explain-toggle"
    >
      {open ? "Hide detail" : "Explain in detail"}
      <ChevronDown
        size={12}
        strokeWidth={1.75}
        className={`transition-transform ${open ? "rotate-180" : "rotate-0"}`}
      />
    </button>
  );
}

// ─── Sub-components (unchanged from pre-Phase-B except Section reused) ─
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
  const palette: Record<RatioKnowledge["category"], { bg: string; text: string; label: string }> = {
    liquidity:     { bg: "bg-[#EDF1F6] dark:bg-[hsl(173,57%,18%)]", text: "text-[#1B7268] dark:text-[hsl(173,57%,80%)]", label: "Liquidity" },
    profitability: { bg: "bg-[#EEF4F0] dark:bg-[hsl(173,57%,14%)]", text: "text-[#2AA89B] dark:text-[hsl(173,57%,72%)]", label: "Profitability" },
    leverage:      { bg: "bg-[#F1EDF6] dark:bg-[hsl(173,57%,18%)]", text: "text-[#1B7268] dark:text-[hsl(173,57%,80%)]", label: "Leverage" },
    coverage:      { bg: "bg-[#E6F7F4] dark:bg-[hsl(173,57%,18%)]",  text: "text-[#2AA89B] dark:text-[hsl(173,57%,75%)]",  label: "Coverage" },
    efficiency:    { bg: "bg-[#E6F7F4] dark:bg-[hsl(173,57%,16%)]", text: "text-[#1B7268] dark:text-[hsl(173,57%,76%)]", label: "Efficiency" },
    distress:      { bg: "bg-[#F4E8E8] dark:bg-[hsl(0,30%,18%)]",   text: "text-[#7A1F1F] dark:text-[hsl(0,40%,80%)]",   label: "Distress" },
  };
  const c = palette[category];
  return (
    <span className={`inline-flex items-center h-5 px-2 rounded-md text-[10px] uppercase tracking-[0.1em] font-semibold ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  );
}

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

function FallbackBody({ ratio }: { ratio: Ratio }) {
  return (
    <div className="px-6 py-8">
      <h2 className="text-[22px] font-semibold text-ink leading-tight">{ratio.label}</h2>
      <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed">{ratio.commentary}</p>
      <div className="mt-4 text-[12px] text-ink-mute">{ratio.benchmark}</div>
    </div>
  );
}
