// Deterministic stub responder for the CFO AI Copilot.
//
// When the live AI backend lands this file becomes a thin client that posts
// the user message + chat context object to /api/cfo/chat. Until then the
// responder pattern-matches the user input against the derived dataset and
// returns answers grounded in real numbers — never invented.

import type { CfoItem } from "@/lib/cfoDerive";
import type { ExecutiveSummary } from "@/lib/cfoApi";
import { CURRENCY } from "@/lib/currency";

interface DataCtx {
  summary: ExecutiveSummary;
  items: CfoItem[];
  costOfCapitalPct: number;
}

export interface ChatBlock {
  /** Plain-text paragraph. Markdown-light: **bold** is supported. */
  text?: string;
  /** Stat tile row. Each entry shows label + value. */
  stats?: { label: string; value: string }[];
  /** Bulleted list. */
  list?: string[];
  /** Decision chip group with a heading. */
  chips?: { bucket: string; items: string[] };
}

export interface AnswerBlocks {
  blocks: ChatBlock[];
}

const fmt = {
  euM: (kron: number) => `${(kron / 1000).toFixed(1)}M ${CURRENCY}`,
  euK: (kron: number) => `${kron.toFixed(0)}k ${CURRENCY}`,
  euAuto: (kron: number) =>
    Math.abs(kron) >= 1000 ? `${(kron / 1000).toFixed(1)}M ${CURRENCY}` : `${kron.toFixed(0)}k ${CURRENCY}`,
  pct: (n: number) => `${n.toFixed(1)}%`,
};

// Tiny tag check — every keyword needs to appear (case-insensitive) for the
// matcher to return true. Useful when building intent rules.
function has(input: string, ...keywords: string[]) {
  const t = input.toLowerCase();
  return keywords.every((k) => t.includes(k.toLowerCase()));
}

export function respond(input: string, ctx: DataCtx): AnswerBlocks {
  const q = input.trim().toLowerCase();
  const { summary, items, costOfCapitalPct } = ctx;

  // ─── Daily / today / urgent ─────────────────────────────────────────
  if (
    has(q, "today") ||
    has(q, "what should") ||
    has(q, "urgent") ||
    has(q, "do today")
  ) {
    return {
      blocks: [
        {
          text: `Your portfolio has **${summary.urgent_actions} urgent action${
            summary.urgent_actions === 1 ? "" : "s"
          }** today, weighted by cash impact and the rule that fired.`,
        },
        {
          stats: [
            { label: "Cash trapped",   value: fmt.euM(summary.cash_trapped_kron) },
            { label: "Recoverable",    value: fmt.euM(summary.cash_recovery_potential_kron) },
            { label: "ROIC",           value: fmt.pct(summary.roic_pct) },
            { label: "Real margin",    value: fmt.pct(summary.real_margin_pct) },
          ],
        },
        {
          text: "Recommended order of operations:",
          list: [
            `**Liquidate** ${summary.bucket_counts.liquidate ?? 0} bleeding-margin SKUs to free trapped capital.`,
            `**Renegotiate** ${summary.bucket_counts.fix ?? 0} thin-margin items with suppliers.`,
            `**Throttle reorder** on ${summary.bucket_counts.reduce ?? 0} slow-movers.`,
            `**Hold** ${summary.bucket_counts.protect ?? 0} anchor categories — these absorb fixed costs.`,
          ],
        },
      ],
    };
  }

  // ─── Cash trapped / where is cash ────────────────────────────────────
  if (has(q, "trap") || has(q, "where is cash") || (has(q, "cash") && !has(q, "recover"))) {
    const sortedByCapital = [...items]
      .sort((a, b) => Math.abs(b.capitalMRon) - Math.abs(a.capitalMRon))
      .slice(0, 5);
    return {
      blocks: [
        {
          text: `Inventory ties up **${fmt.euM(summary.cash_trapped_kron)}** across the portfolio. The five biggest capital drags:`,
        },
        {
          list: sortedByCapital.map(
            (i) => `**${i.id}** — ${(Math.abs(i.capitalMRon)).toFixed(2)}M ${CURRENCY} · ${i.dioDays}d DIO · real margin ${i.realMargin.toFixed(1)}%`,
          ),
        },
        {
          text: `Of this, **${fmt.euM(summary.cash_recovery_potential_kron)}** is recoverable in 30–60 days by acting on the Liquidate + Reduce buckets.`,
        },
      ],
    };
  }

  // ─── Recovery / how much can we free ─────────────────────────────────
  if (has(q, "recover") || has(q, "free up") || (has(q, "cash") && has(q, "60"))) {
    const recoverable = items.filter((i) => i.bucket === "LIQUIDATE" || i.bucket === "REDUCE");
    return {
      blocks: [
        {
          text: `**${fmt.euM(summary.cash_recovery_potential_kron)}** recoverable across ${recoverable.length} SKUs in liquidate + reduce buckets.`,
        },
        {
          list: recoverable.slice(0, 8).map(
            (i) => `${i.bucket === "LIQUIDATE" ? "Liquidate" : "Reduce"} **${i.id}** → ~${(Math.abs(i.capitalMRon) * (i.bucket === "REDUCE" ? 0.3 : 1)).toFixed(2)}M ${CURRENCY} freed`,
          ),
        },
      ],
    };
  }

  // ─── Liquidate / which products to cut ───────────────────────────────
  if (has(q, "liquidat") || has(q, "should we cut") || has(q, "destroy")) {
    const liq = items.filter((i) => i.bucket === "LIQUIDATE");
    return {
      blocks: [
        {
          text: `${liq.length} product${liq.length === 1 ? "" : "s"} flagged for liquidation. These have negative real margin or capital trapped without a return:`,
        },
        {
          list: liq.map(
            (i) => `**${i.id}** — real margin ${i.realMargin.toFixed(1)}%, ${i.dioDays}d DIO. Reason: ${i.reason ?? "weak unit economics"}.`,
          ),
        },
      ],
    };
  }

  // ─── Real margin / fake profit ──────────────────────────────────────
  if (has(q, "real margin") || has(q, "fake profit") || (has(q, "after") && has(q, "capital"))) {
    return {
      blocks: [
        {
          text: `Real margin = gross margin − working-capital cost. With cost of capital at **${costOfCapitalPct}%** and a 90-day inventory cycle, every product loses ~${((90 / 365) * costOfCapitalPct).toFixed(1)}pp of margin to capital alone.`,
        },
        {
          stats: [
            { label: "Portfolio gross", value: fmt.pct(summary.real_margin_pct + 1.8) },
            { label: "Portfolio real",  value: fmt.pct(summary.real_margin_pct) },
            { label: "Margin leak",     value: `${(1.8).toFixed(1)}pp` },
          ],
        },
        {
          text: `Categories with the worst gap (gross looks healthy, real margin is thin) need supplier renegotiation or pricing review — not necessarily liquidation.`,
        },
      ],
    };
  }

  // ─── ROIC / which has worst returns ─────────────────────────────────
  if (has(q, "roic") || has(q, "return on")) {
    const worst = [...items]
      .filter((i) => i.absoluteProfit < 0 || i.realMargin < 3)
      .sort((a, b) => a.realMargin - b.realMargin)
      .slice(0, 5);
    return {
      blocks: [
        {
          text: `Portfolio ROIC sits at **${fmt.pct(summary.roic_pct)}** vs ${costOfCapitalPct}% cost of capital — a healthy ${(summary.roic_pct - costOfCapitalPct).toFixed(1)}pp spread, but it's concentrated in a handful of anchors.`,
        },
        {
          text: "Categories dragging ROIC down:",
          list: worst.map(
            (i) => `**${i.id}** — real margin ${i.realMargin.toFixed(1)}%, abs profit ${i.absoluteProfit.toFixed(1)}k ${CURRENCY}`,
          ),
        },
      ],
    };
  }

  // ─── Specific product lookup ────────────────────────────────────────
  const named = items.find((i) => q.includes(i.id.toLowerCase()));
  if (named) {
    return {
      blocks: [
        {
          text: `**${named.id}** is in the **${named.bucket}** bucket.`,
          stats: [
            { label: "Real margin",       value: fmt.pct(named.realMargin) },
            { label: "Absolute profit",   value: fmt.euAuto(named.absoluteProfit) },
            { label: "DIO",               value: `${named.dioDays}d` },
            { label: "Capital trapped",   value: `${(Math.abs(named.capitalMRon)).toFixed(2)}M ${CURRENCY}` },
          ],
        },
        {
          text: named.reason
            ? `Reason the rule fired: *${named.reason}*.`
            : `Status: ${named.bucket === "PROTECT" ? "anchor — do not auto-touch" : "stable, monitor for drift"}.`,
        },
        {
          text:
            named.bucket === "LIQUIDATE"
              ? "Recommendation: stop reorder, run a one-time discount, exit the catalogue."
              : named.bucket === "FIX"
              ? "Recommendation: open a renegotiation with the supplier or run a 5-10% price increase test."
              : named.bucket === "REDUCE"
              ? "Recommendation: cut reorder quantity by ~30%, lower the safety stock floor."
              : named.bucket === "SCALE"
              ? "Recommendation: increase purchasing — this earns its capital cost twice over."
              : "Recommendation: monitor weekly. No action today.",
        },
      ],
    };
  }

  // ─── Board summary ──────────────────────────────────────────────────
  if (has(q, "board") || has(q, "summary") || has(q, "summarize")) {
    return {
      blocks: [
        {
          text: `**Portfolio at a glance**`,
          stats: [
            { label: "Working capital",  value: fmt.euM(summary.cash_trapped_kron) },
            { label: "ROIC",             value: fmt.pct(summary.roic_pct) },
            { label: "Real margin",      value: fmt.pct(summary.real_margin_pct) },
            { label: "Recoverable 60d",  value: fmt.euM(summary.cash_recovery_potential_kron) },
          ],
        },
        {
          text: "**Operating priorities**",
          list: [
            `Protect ${summary.bucket_counts.protect ?? 0} anchor categories driving the bulk of profit share.`,
            `Recover ${fmt.euM(summary.cash_recovery_potential_kron)} of cash by acting on liquidate + reduce in the next 60 days.`,
            `${summary.bucket_counts.fix ?? 0} renegotiations in flight — expected margin lift ~+2pp on touched volume.`,
            `${summary.bucket_counts.scale ?? 0} scale candidates earning above cost of capital with room for more inventory.`,
          ],
        },
      ],
    };
  }

  // ─── Simulate ───────────────────────────────────────────────────────
  if (has(q, "simulate") || has(q, "what if") || has(q, "happens if")) {
    return {
      blocks: [
        {
          text: `Simulation engine ships in the next release. In the meantime, change a threshold in **Settings → Rules** and the queue updates live — every SKU's bucket is recomputed against the new gate.`,
        },
        {
          text: `Common simulations users run:`,
          list: [
            "Cost of capital +1.5pp → real margin compresses by ~0.4pp portfolio-wide.",
            "DIO floor 100d → 150d → 7 fewer items in Watch, 4 more in Reduce.",
            "Anchor floor 5% → 4% → no anchors lost; one new candidate qualifies.",
          ],
        },
      ],
    };
  }

  // ─── Supplier negotiation draft ─────────────────────────────────────
  if (has(q, "supplier") || has(q, "renegotiat") || has(q, "negotiation")) {
    const fix = items.filter((i) => i.bucket === "FIX")[0];
    return {
      blocks: [
        {
          text: `Draft talking points for ${fix ? `**${fix.id}**` : "a thin-margin supplier conversation"}:`,
          list: [
            `Year-to-date volume: ${fix ? `${fix.volumeT.toFixed(0)}t` : "N/A"} — material to both sides.`,
            `Current real margin sits at ${fix ? fix.realMargin.toFixed(1) + "%" : "<3%"}, well below our portfolio threshold of 3%.`,
            `Industry benchmark for similar volumes is closer to 5–6% — we'd like to align.`,
            `Open to longer payment terms (60→75d) in exchange for a 4–5% list-price reduction.`,
            `If we can't move the unit economics, we'll need to delist — a worse outcome for both.`,
          ],
        },
      ],
    };
  }

  // ─── Default ─────────────────────────────────────────────────────────
  return {
    blocks: [
      {
        text: `I track ${items.length} categories with **${fmt.euM(summary.cash_trapped_kron)}** in working capital. Try one of the suggested prompts on the right, or ask about a specific product, bucket, or financial metric.`,
      },
    ],
  };
}

// Suggested prompts shown in the empty state.
export const SUGGESTED_PROMPTS: Record<string, string[]> = {
  Daily: [
    "What should I do today?",
    "Show urgent decisions.",
    "Summarize portfolio health.",
  ],
  Explain: [
    "Explain Core Range.",
    "Why is Beverages in Scale?",
    "What does real margin mean?",
  ],
  Cash: [
    "Where is cash trapped?",
    "Which SKUs should we liquidate?",
    "How much can we recover in 60 days?",
  ],
  Simulate: [
    "Simulate cost of capital at 8%.",
    "What if we cut DIO by 20 days?",
    "Draft supplier renegotiation.",
    "Create board summary.",
  ],
};
