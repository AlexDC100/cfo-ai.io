// THE GROUNDED CHAT RECEIVES THE SPLIT AND ITS CLAIM POLICY (owner spec
// 2026-09-26 P1.5, design B5): the workspace snapshot the chat model is
// grounded in carries the ONE inventory-days block as every surface prints
// it, and says whether stock may be called slow — "MAY" only where the
// engine's claim policy allows it (split AND average), with its reason.

import { describe, expect, it } from "vitest";

import { buildWorkspaceSnapshot } from "@/pages/cfo/Chat";
import { STOCK_SLOW_CLAIM_RULE, printInventoryDays, readInventoryDaysSplit } from "@/lib/inventoryDays";
import { readServedOneEbitda } from "@/lib/servedOneEbitda";
import type { Statements } from "@/lib/financialReport";

import constructedJson from "@/lib/__tests__/fixtures/oneEbitda/constructed_books.json";
import pairJson from "@/lib/__tests__/fixtures/comparatives/pair_served.json";

type Json = Record<string, unknown>;
const pair = pairJson as unknown as { current_body: { statements: Statements & Json; metrics: { name: string; value: number | null }[] } };

const periodOf = (statements: Statements & Json) =>
  ({
    id: "p1", label: "FY2025", periodEnd: "2025-12-31", organizationId: null, industry: null,
    statements, invoices: null, metrics: pair.current_body.metrics, recommendations: [], alerts: [], briefing: null,
  }) as unknown as Parameters<typeof buildWorkspaceSnapshot>[0];

describe("the chat snapshot carries the inventory-days split and its claim policy", () => {
  it("prints every leg, the total, the basis and MAY on a split-and-average block", () => {
    const s = JSON.parse(JSON.stringify(pair.current_body.statements)) as Statements & Json;
    const text = buildWorkspaceSnapshot(periodOf(s))!;
    const printed = printInventoryDays(readInventoryDaysSplit(s)!, "en");
    for (const r of [...printed.legs, printed.total]) {
      expect(text).toContain(`${r.label}`);
      expect(text).toContain(r.days);
    }
    expect(text).toContain(printed.basis);
    const policy = (s.inventory_days as Json).claim_policy as Json;
    expect(policy.may_call_slow).toBe(true);
    expect(text).toContain("Claim policy: stock MAY be called slow or high");
    expect(text).toContain(((policy.reason_text as Json).en as string));
  });

  it("says may NOT on a snapshot-only block", () => {
    const s = JSON.parse(JSON.stringify(pair.current_body.statements)) as Statements & Json;
    const block = s.inventory_days as Json;
    block.claim_policy = {
      may_call_slow: false, requires: ["split_by_stock_type", "average_balance"], reason: "snapshot_only",
      reason_text: { ro: "x", en: "inventory days rest on a single period-end balance; stock cannot be called slow" },
    };
    const text = buildWorkspaceSnapshot(periodOf(s))!;
    expect(text).toContain("Claim policy: stock may NOT be called slow or high — inventory days rest on a single period-end balance");
  });

  it("no block, no inventory section", () => {
    const s = JSON.parse(JSON.stringify(pair.current_body.statements)) as Statements & Json;
    delete s.inventory_days;
    expect(buildWorkspaceSnapshot(periodOf(s))!).not.toContain("Claim policy");
  });
});

// ── THE CHAT CLAIM RULE RIDES IN THE SNAPSHOT (release r-rulings, 2026-09-28)
//
// The Ask CFO AI edge function (supabase/functions/chat-llm) is not
// redeployable in this release, so the rule the design (B5) put into its
// system prompt travels in the workspace snapshot it already receives as
// `dataset_summary`. On every constructed book (all seven on a
// `year_end_snapshot` basis, `may_call_slow` false) the snapshot must carry:
// the served inventory-days TOTAL with its basis LABEL on the same line; ONE
// plain rule line, the owner's Romanian and its English; and the served ONE
// EBITDA with its 711 / 72x components — or the engine's refusal words for
// it and for a refused component, never a figure.
//
// WHAT IT REDS ON (TC-11): the rule line missing (or doubled) on a
// snapshot-basis period, or present where the policy allows the claim; the
// total printed without its basis label; an EBITDA or component figure that
// is not the served one; a refused EBITDA printed as a figure, or a refused
// 711 component silently dropped (its reason missing).


type ConstructedBook = { statements: Statements & Json; line_items: unknown[] };
const constructed = constructedJson as unknown as Record<string, ConstructedBook>;
const CONSTRUCTED = Object.keys(constructed).sort();
const RULE_LINE = `  · Rule: ${STOCK_SLOW_CLAIM_RULE.en} (RO: ${STOCK_SLOW_CLAIM_RULE.ro})`;
const fmt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);

const snapshotOf = (name: string): string =>
  buildWorkspaceSnapshot({
    id: `p-${name}`, label: "FY2025", periodEnd: "2025-12-31", organizationId: null, industry: null,
    statements: constructed[name].statements, lineItems: constructed[name].line_items, invoices: null,
    metrics: [], recommendations: [], alerts: [], briefing: null, source: "upload",
  } as unknown as Parameters<typeof buildWorkspaceSnapshot>[0]) ?? "";

describe("the chat claim rule and the one EBITDA ride in the workspace snapshot (edge function not redeployed)", () => {
  it("the rule is the owner's Romanian sentence, with its English", () => {
    expect(STOCK_SLOW_CLAIM_RULE.ro).toBe(
      "Nu descrie stocurile ca lente sau mari pe baza soldului de la o singură dată; citează împărțirea pe tipuri de stoc și media.",
    );
    expect(STOCK_SLOW_CLAIM_RULE.en).toMatch(/^Do not describe the stock as slow or high .* single date; cite the split by stock type and the average\.$/);
  });

  it("POSITIVE CONTROL: every constructed book is a snapshot-basis period that may NOT call stock slow", () => {
    expect(CONSTRUCTED.length).toBeGreaterThanOrEqual(7);
    for (const name of CONSTRUCTED) {
      const split = readInventoryDaysSplit(constructed[name].statements)!;
      expect(split.basis, name).toBe("year_end_snapshot");
      expect(split.maySlowClaim, name).toBe(false);
    }
  });

  it.each(CONSTRUCTED)("%s: the snapshot-basis period carries ONE rule line and the total with its basis label", (name) => {
    const text = snapshotOf(name);
    const lines = text.split("\n");
    expect(lines.filter((l) => l === RULE_LINE), `${name}: the rule line`).toHaveLength(1);
    const printed = printInventoryDays(readInventoryDaysSplit(constructed[name].statements)!, "en");
    const basisLabel = readInventoryDaysSplit(constructed[name].statements)!.basisLabel!.en;
    const totalLine = lines.find((l) => l.startsWith(`  · ${printed.total.label}`) && l.includes(printed.total.days));
    expect(totalLine, `${name}: no total line`).toBeTruthy();
    expect(totalLine!.endsWith(` — ${printed.basis}`), `${name}: "${totalLine}" lacks its basis label`).toBe(true);
    expect(totalLine).toContain(basisLabel);
  });

  it("a split-and-average period (may call slow) carries no rule line", () => {
    const s = JSON.parse(JSON.stringify(pair.current_body.statements)) as Statements & Json;
    const text = buildWorkspaceSnapshot(periodOf(s))!;
    expect(readInventoryDaysSplit(s)!.maySlowClaim).toBe(true);
    expect(text).not.toContain(STOCK_SLOW_CLAIM_RULE.en);
    expect(text).not.toContain(STOCK_SLOW_CLAIM_RULE.ro);
  });

  it.each(CONSTRUCTED)("%s: the one EBITDA with its 711 / 72x components, or the engine's refusal words", (name) => {
    const text = snapshotOf(name);
    const one = readServedOneEbitda(constructed[name].statements.assembled_pl)!;
    const iv = one.inventoryVariation;
    const cw = one.capitalizedOwnWork;
    if (one.ebitda !== null) {
      expect(text).toContain(`  · EBITDA (711 and 72x inside): ${fmt(one.ebitda)}\n`);
      expect(text).not.toContain("EBITDA: REFUSED");
      expect(iv?.value, `${name}: a served EBITDA with no served 711`).not.toBeNull();
      expect(text).toContain(`  · Variația stocurilor de produse (net 711, inside EBITDA): ${fmt(iv!.value as number)}\n`);
      expect(text).toContain(`  · Own work capitalised (net 72x, inside EBITDA): ${fmt(cw!.value as number)}\n`);
    } else {
      expect(text).toContain(`  · EBITDA: REFUSED — ${one.refusal!.text.en}`);
      expect(text).not.toMatch(/EBITDA \(711 and 72x inside\):/);
      // The refused component states its own reason — never a figure, never silence.
      expect(iv?.value ?? null).toBeNull();
      expect(text).toContain(`  · Variația stocurilor de produse (net 711, inside EBITDA): REFUSED — ${iv!.refusal!.text.en}`);
    }
  });

  it("POSITIVE CONTROL: the constructed books hold both a served EBITDA with a non-zero 711 and 72x, and a refused one", () => {
    const ones = CONSTRUCTED.map((n) => readServedOneEbitda(constructed[n].statements.assembled_pl)!);
    expect(ones.some((o) => o.ebitda !== null && (o.inventoryVariation?.value ?? 0) !== 0 && (o.capitalizedOwnWork?.value ?? 0) !== 0)).toBe(true);
    expect(ones.some((o) => o.ebitda === null)).toBe(true);
  });
});
