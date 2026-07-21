// AIMarketReadPanel — per-ticker "what could change the numbers" narrative.
//
// Calls /api/public/intelligence/companies/{ticker}/ai-market-read. At
// Phase A the endpoint returns a deterministic template (model_id =
// "deterministic_v1"). Phase B+ swaps in Claude Opus while keeping the
// same response shape.
//
// Used by the StockDetailDrawer's AI Read tab. The deterministic template
// uses the risk + opportunity scores + sector profile to produce a
// what-to-watch list — see ai_market_read endpoint in routes.py.

import { useQuery } from "@tanstack/react-query";
import { Eye, Loader2, AlertTriangle, TrendingUp, Sparkles } from "lucide-react";
import {
  fetchAIMarketRead,
  severityToBgClass,
  severityToTextClass,
} from "@/lib/publicCompanyIntelligence";

interface Props {
  ticker: string;
}

export function AIMarketReadPanel({ ticker }: Props) {
  const q = useQuery({
    queryKey: ["intelligence", "ai-market-read", ticker.toUpperCase()],
    queryFn: () => fetchAIMarketRead(ticker),
    staleTime: 3 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    enabled: Boolean(ticker),
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-ink-soft">
        <Loader2 size={16} className="animate-spin mr-2" />
        <span className="text-[13px]">Generating market read…</span>
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <div className="rounded-xl border border-alert/30 bg-alert/5 p-4 text-[13px] text-alert">
        Couldn't load AI Market Read.{" "}
        <button onClick={() => q.refetch()} className="underline">
          Retry
        </button>
      </div>
    );
  }

  const r = q.data;
  const feedLabel =
    r.feed_status === "live_feed_active"     ? "Live signal feed active"
    : r.feed_status === "sector_model_only"  ? "Sector model only — no live news feed"
    :                                          "Feed not connected";
  const feedTone =
    r.feed_status === "live_feed_active"
      ? "bg-[#5CD3C5]/10 text-[#5CD3C5] border-[#5CD3C5]/30"
      : "bg-[#5CD3C5]/10 text-[#5CD3C5] border-[#5CD3C5]/30";

  // Detect deterministic placeholder vs real Claude. Today the BE returns
  // model_id="deterministic_v1"; Phase B swaps in "claude-opus-4-7" etc.
  const isDeterministic = r.model_id === "deterministic_v1";

  return (
    <div className="space-y-4" data-testid="ai-market-read-panel">
      {/* Header — model + feed status */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex items-center gap-2 text-[11px] text-ink-mute">
          <Sparkles size={12} strokeWidth={1.75} />
          <span className="font-mono">{r.model_id}</span>
        </div>
        <span
          className={`
            inline-flex items-center gap-1.5
            h-6 px-2 rounded-full border
            text-[10.5px] font-medium
            ${feedTone}
          `}
        >
          <span className="inline-block w-1 h-1 rounded-full bg-current" />
          {feedLabel}
        </span>
      </div>

      {/* Headline */}
      <div className="rounded-2xl border border-brand/25 bg-brand/[0.04] p-4">
        <div className="text-[10.5px] uppercase tracking-[0.1em] text-brand font-medium mb-1.5">
          Headline
        </div>
        <h3 className="text-[16px] font-medium text-ink leading-tight">
          {r.headline}
        </h3>
        <p className="text-[13px] text-ink-soft mt-2 leading-relaxed">
          {r.summary}
        </p>
      </div>

      {/* Top risks (compact) */}
      {r.top_risks.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-2">
            Watch — top risks
          </div>
          <ul className="space-y-1.5">
            {r.top_risks.map((risk) => {
              const sevText = severityToTextClass(risk.severity);
              const sevBg = severityToBgClass(risk.severity);
              return (
                <li
                  key={risk.key}
                  className="flex items-start gap-2 px-3 py-2 rounded-lg border border-rule/60 bg-bg-2/30"
                >
                  <span
                    className={`mt-0.5 inline-flex items-center justify-center h-5 w-5 rounded ${sevBg} ${sevText} shrink-0`}
                  >
                    <AlertTriangle size={10} strokeWidth={2} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] text-ink leading-snug">{risk.label}</div>
                    {risk.channels.length > 0 && (
                      <div className="text-[10.5px] text-ink-mute mt-0.5">
                        Impacts: {risk.channels.slice(0, 3).map(c => c.replace(/_/g, " ")).join(", ")}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Top opportunities (compact) */}
      {r.top_opportunities.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-2">
            Watch — top opportunities
          </div>
          <ul className="space-y-1.5">
            {r.top_opportunities.map((opp) => (
              <li
                key={opp.key}
                className="flex items-start gap-2 px-3 py-2 rounded-lg border border-rule/60 bg-bg-2/30"
              >
                <span className="mt-0.5 inline-flex items-center justify-center h-5 w-5 rounded bg-[#5CD3C5]/15 border border-[#5CD3C5]/30 text-[#5CD3C5] shrink-0">
                  <TrendingUp size={10} strokeWidth={2} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-ink leading-snug">{opp.label}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* What to watch — next-quarter watchlist */}
      {r.what_to_watch.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-2 flex items-center gap-1.5">
            <Eye size={11} strokeWidth={2} />
            What to watch
          </div>
          <ul className="space-y-1.5">
            {r.what_to_watch.map((item, i) => (
              <li
                key={i}
                className="text-[12.5px] text-ink-soft leading-relaxed flex items-start gap-2"
              >
                <span className="text-brand mt-0.5">·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Disclosure */}
      <div className="text-[11px] text-ink-mute leading-relaxed border-t border-rule/40 pt-3">
        {isDeterministic ? (
          <>
            Deterministic narrative — derived from the risk/opportunity scores
            and the sector library. Claude Opus interpretation lands once the
            LLM orchestrator is wired (no functional gap; scores are already
            deterministic).
          </>
        ) : (
          <>
            AI-generated interpretation. Score numbers are deterministic; the
            narrative is the LLM's reading. Confidence: {Math.round(r.confidence * 100)}%.
          </>
        )}
      </div>
    </div>
  );
}
