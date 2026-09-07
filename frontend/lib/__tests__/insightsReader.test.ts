/**
 * The insight READER, over the block the engine actually emits.
 *
 * `frontend/lib/insights.ts` must never compute a number. This suite
 * proves it by reading `tests/engine/fixtures/firm/insights.json` — the
 * block captured from real engine output by
 * `tests/engine/fixtures/firm/capture_insights.py` over the four
 * committed real books — and asserting that every string the reader
 * produces is the string the ENGINE already produced for the same
 * measure.
 *
 * WHAT THIS GATE REDS ON, after the repair:
 *   · the reader's `formatMeasure` drifting from
 *     `engine.insights.measures.format_measure` — proved per measure by
 *     rebuilding every claim from the serialized measures and comparing
 *     it byte-for-byte with the engine's own `claim` string;
 *   · a `null` measure rendering as `0`, `—`, or an empty string instead
 *     of the stated gap (ABSENT != ZERO);
 *   · a genuinely non-zero share printing as "0.0%", which a reader reads
 *     as nothing (SMALL != ZERO — measured on carniprod, where an
 *     unclassified balance is 0.0125% of assets);
 *   · `readInsights` synthesising an empty block for a payload that
 *     carries none, which would assert a clean book that was never read;
 *   · the severity ladder losing its ACTIVE marker or its basis, so a
 *     level prints as a bare threshold claim (R4);
 *   · `renderInsightClaim` silently leaving `{money:step}` visible for a
 *     measure the insight does not carry.
 *
 * WHAT IT CANNOT SEE: what the REPORT renders. This asserts over the
 * reader, not over the printed document — the export gate is lanes B/C's
 * to write against `frontend/lib/__tests__/exportBooks.ts` once the
 * section exists. It also cannot see the served route: nothing attaches
 * this block to `GET /api/period/{id}` yet.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type Insight,
  type InsightMeasure,
  type InsightsBlock,
  SEVERITY_ORDER,
  formatMeasure,
  insightById,
  measure,
  readInsights,
  renderInsightClaim,
  severityCaption,
  severityLadder,
  summaryInsights,
} from "@/lib/insights";

const repoRoot = resolve(__dirname, "../../..");
const RAW = JSON.parse(
  readFileSync(
    resolve(repoRoot, "tests/engine/fixtures/firm/insights.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

const BOOKS = ["agras", "carniprod", "realestate", "retail"] as const;
type Book = (typeof BOOKS)[number];

function blockFor(book: Book): InsightsBlock {
  const read = readInsights({ insights: RAW[book] });
  if (!read) throw new Error(`the captured fixture carries no ${book} block`);
  return read;
}

describe("readInsights", () => {
  it("refuses to synthesise a block for a payload that carries none", () => {
    // An empty "no findings" section would assert a clean book. Nothing
    // read the book at all.
    expect(readInsights(undefined)).toBeNull();
    expect(readInsights({})).toBeNull();
    expect(readInsights({ insights: null })).toBeNull();
    expect(readInsights({ insights: [] })).toBeNull();
    expect(readInsights({ insights: { insights: "nope" } })).toBeNull();
  });

  it.each(BOOKS)("reads the %s block the engine emitted", (book) => {
    const block = blockFor(book);
    expect(block.schema_version).toBe("insights/1");
    expect(block.currency).toBe("RON");
    expect(block.insights.length).toBeGreaterThan(0);
    const raw = RAW[book] as { insights: unknown[] };
    expect(block.insights).toHaveLength(raw.insights.length);
  });
});

describe("the reader formats; it does not compute", () => {
  it.each(BOOKS)(
    "rebuilds every %s claim byte-for-byte from the serialized measures",
    (book) => {
      const block = blockFor(book);
      for (const insight of block.insights) {
        expect(renderInsightClaim(insight, block.currency)).toBe(insight.claim);
      }
    },
  );

  it("renders an absent measure as a stated gap, never as zero", () => {
    // realestate has no cost of goods sold, so DPO cannot be computed.
    const block = blockFor("realestate");
    const trade = insightById(block, "trade_float");
    expect(trade).not.toBeNull();
    const dpo = measure(trade as Insight, "dpo");
    expect(dpo?.value).toBeNull();
    expect(formatMeasure(dpo as InsightMeasure, block.currency)).toBe(
      "not reported",
    );
    expect((trade as Insight).claim).toContain("not reported");
  });

  it("does not print a genuinely non-zero share as 0.0%", () => {
    // carniprod: 15,750.23 unclassified against 125.9M of assets.
    const block = blockFor("carniprod");
    const unclassified = insightById(block, "unclassified_balances");
    const share = measure(unclassified as Insight, "share_of_assets");
    expect(share?.value).toBeGreaterThan(0);
    const printed = formatMeasure(share as InsightMeasure, block.currency);
    expect(printed).not.toBe("0.0%");
    expect(printed).toBe("0.01%");
  });

  it("names what a count counts", () => {
    const agras = insightById(blockFor("agras"), "unclassified_balances");
    const one = measure(agras as Insight, "account_count");
    expect(formatMeasure(one as InsightMeasure, "RON")).toBe("1 account");
    const carniprod = insightById(
      blockFor("carniprod"),
      "unclassified_balances",
    );
    const many = measure(carniprod as Insight, "account_count");
    expect(formatMeasure(many as InsightMeasure, "RON")).toBe("3 accounts");
  });

  it("throws rather than shipping a visible placeholder to a reader", () => {
    const block = blockFor("agras");
    const insight = insightById(block, "asset_age") as Insight;
    const broken: Insight = {
      ...insight,
      claim_template: "the gap is {money:not_a_measure}",
    };
    expect(() => renderInsightClaim(broken, "RON")).toThrow(
      /does not carry/,
    );
    const mistyped: Insight = {
      ...insight,
      claim_template: "the gap is {money:depreciated_share}",
    };
    expect(() => renderInsightClaim(mistyped, "RON")).toThrow(/is a ratio/);
  });
});

describe("severity is scaled, and says so", () => {
  it.each(BOOKS)("every %s caption names the basis, not just a level", (book) => {
    for (const insight of blockFor(book).insights) {
      const caption = severityCaption(insight);
      expect(caption).toContain("·");
      // A level alone ("High") is a threshold claim a reader cannot check.
      expect(caption.length).toBeGreaterThan("Critical".length + 4);
      if (insight.severity.materiality !== null) {
        expect(caption).toContain(
          insight.severity.basis_label.toLowerCase(),
        );
      }
    }
  });

  it("renders the ladder the verdict was actually read against", () => {
    const insight = insightById(blockFor("agras"), "asset_age") as Insight;
    const ladder = severityLadder(insight);
    expect(ladder.map((r) => r.level)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ]);
    expect(ladder.filter((r) => r.active)).toHaveLength(1);
    expect(ladder.find((r) => r.active)?.level).toBe("high");
    // TC-10: the cutoff renders from the same data the verdict used.
    expect(ladder[1].label).toContain("70.0%");
    expect(ladder[1].label).toContain("gross pp&e");
    expect(ladder[4].label).toContain("below every cutoff");
  });

  it.each(BOOKS)("%s ranks severity-first with a stated tie-break", (book) => {
    const block = blockFor(book);
    let previous: [number, number, number, string] | null = null;
    for (const insight of block.insights) {
      const key: [number, number, number, string] = [
        SEVERITY_ORDER.indexOf(insight.severity.level),
        insight.severity.materiality === null ? 1 : 0,
        -(insight.severity.materiality ?? 0),
        insight.id,
      ];
      if (previous) {
        expect(compare(previous, key)).toBeLessThanOrEqual(0);
      }
      previous = key;
      expect(insight.rank_basis.toLowerCase()).toContain("tie");
    }
  });
});

function compare(
  a: [number, number, number, string],
  b: [number, number, number, string],
): number {
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] as number) !== (b[i] as number)) {
      return (a[i] as number) < (b[i] as number) ? -1 : 1;
    }
  }
  return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0;
}

describe("the summary, and the stated gaps", () => {
  it.each(BOOKS)("%s carries at most five summary insights", (book) => {
    const block = blockFor(book);
    expect(block.summary_ids.length).toBeLessThanOrEqual(5);
    expect(summaryInsights(block).map((i) => i.id)).toEqual(block.summary_ids);
  });

  it("carries the detectors that found nothing, with a reason", () => {
    const block = blockFor("retail");
    const ids = block.not_fired.map((n) => n.id);
    expect(ids).toContain("unclassified_balances");
    const entry = block.not_fired.find(
      (n) => n.id === "unclassified_balances",
    );
    expect(entry?.reason).toMatch(/matched a classification rule/);
    expect(entry?.title).toBeTruthy();
  });
});

describe("the owner's own findings survive into the reader", () => {
  it("carries account 413 and its 46,613.06 on the agras book", () => {
    const block = blockFor("agras");
    const insight = insightById(block, "unclassified_balances") as Insight;
    expect(insight.accounts.map((a) => a.code)).toEqual(["413"]);
    expect(insight.accounts[0].amount).toBeCloseTo(46613.06, 2);
    expect(insight.claim).toContain("RON 46,613.06");
  });

  it("carries 70.4% depreciated and about four years of book life", () => {
    const insight = insightById(blockFor("agras"), "asset_age") as Insight;
    expect(insight.claim).toContain("70.4%");
    expect(insight.claim).toContain("4.0 years");
  });

  it("carries the 2.11 to 1.51 current-ratio restatement", () => {
    const insight = insightById(
      blockFor("agras"),
      "liquidity_quality",
    ) as Insight;
    expect(insight.claim).toContain("2.11×");
    expect(insight.claim).toContain("1.51×");
  });

  it("carries the 46.6% reconstruction gap", () => {
    const insight = insightById(
      blockFor("agras"),
      "reconstruction_gap",
    ) as Insight;
    expect(insight.claim).toContain("46.6%");
  });
});

describe("every insight carries its evidence", () => {
  it.each(BOOKS)("%s: accounts, formula, facts and a narrative", (book) => {
    for (const insight of blockFor(book).insights) {
      expect(insight.formula.length).toBeGreaterThan(10);
      expect(insight.facts.length).toBeGreaterThan(0);
      expect(insight.measures.length).toBeGreaterThan(0);
      expect(insight.narrative.explanation).toBeTruthy();
      expect(insight.narrative.so_what).toBeTruthy();
      // The captured block is built with no advisory lane, so every
      // narrative must declare itself deterministic rather than pass as
      // model-authored.
      expect(insight.narrative.source).toBe("deterministic");
      for (const account of insight.accounts) {
        expect(account.code).toBeTruthy();
        expect(Number.isFinite(account.amount)).toBe(true);
      }
    }
  });
});
