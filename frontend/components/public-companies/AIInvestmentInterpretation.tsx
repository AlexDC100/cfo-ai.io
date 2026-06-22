// "AI Investment Interpretation" panel — placeholder for the LLM-backed
// peer interpretation that will land in NASDAQ-13 (CFO Chat extension).
// Visually tells the user what the AI will do once data is live, without
// fabricating any actual analysis.

import { Sparkles, Lock, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

interface Props {
  demoMode: boolean;
}

const ANGLES = [
  { title: "Margin structure",  body: "Why one company runs at 65% EBITDA while peers sit at 30% — pricing power, mix, or operating leverage?" },
  { title: "Leverage profile",  body: "Compare net-debt-to-EBITDA + interest coverage to flag covenant headroom and refinancing risk." },
  { title: "Valuation gap",     body: "EV/EBITDA and P/E vs the peer-group median, with a delta call-out and a likely-driver narrative." },
  { title: "Growth + cash generation", body: "Revenue growth × FCF yield quadrant — who's compounding cash, who's spending to grow." },
];

export function AIInvestmentInterpretation({ demoMode }: Props) {
  return (
    <section
      data-testid="public-companies-ai-panel"
      className="
        relative overflow-hidden
        rounded-3xl border border-rule
        bg-gradient-to-br from-surface via-surface to-bg-2/30
        p-5 sm:p-7
      "
    >
      {/* Atmospheric glow */}
      <div
        aria-hidden
        className="
          pointer-events-none absolute -top-20 -right-12 h-56 w-56 rounded-full
          bg-brand/6 blur-3xl
        "
      />

      <div className="relative">
        <div className="flex items-start gap-4 mb-5">
          <div className="
            flex h-11 w-11 shrink-0 items-center justify-center
            rounded-2xl bg-gradient-to-br from-brand/20 to-brand-d/25 text-brand-d
            ring-1 ring-brand/15
          ">
            <Sparkles size={18} strokeWidth={1.75} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-brand-d">
              Step 4 · AI Investment Interpretation
            </div>
            <h2 className="font-serif text-[22px] text-ink leading-tight tracking-[-0.005em] mt-1">
              How CFO AI will read the peer group
            </h2>
            <p className="text-[12.5px] text-ink-soft mt-1.5 max-w-[560px]">
              Once company data is fetched, the AI will compare margins, leverage,
              valuation, growth, and cash generation against the selected peer
              group. No invented numbers — every claim is anchored to a row above.
            </p>
          </div>
        </div>

        {/* Four angle previews */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {ANGLES.map((a) => (
            <div
              key={a.title}
              className="
                rounded-2xl border border-rule bg-surface/70
                backdrop-blur-sm
                p-4
              "
            >
              <div className="text-[12.5px] font-semibold text-ink">{a.title}</div>
              <p className="text-[12px] text-ink-soft mt-1.5 leading-relaxed">{a.body}</p>
            </div>
          ))}
        </div>

        {/* Footer — CTA */}
        <div className="mt-5 flex items-center justify-between gap-3 flex-wrap">
          {demoMode ? (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-mute">
              <Lock size={11} strokeWidth={1.75} />
              Live AI interpretation activates once the Sharadar key is configured + entitled
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-mute">
              <Sparkles size={11} strokeWidth={1.75} className="text-brand-d" />
              Powered by Opus 4.7
            </span>
          )}
          <Link
            to="/chat"
            className="
              inline-flex items-center gap-1.5
              h-9 px-3.5 rounded-lg
              border border-rule bg-surface
              text-[12.5px] text-ink font-medium
              hover:bg-bg-2/50 hover:border-brand/30
              transition-all
            "
          >
            Open CFO Chat
            <ArrowRight size={13} strokeWidth={2} />
          </Link>
        </div>
      </div>
    </section>
  );
}
