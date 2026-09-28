// THE GROUNDED CHAT RECEIVES THE SPLIT AND ITS CLAIM POLICY (owner spec
// 2026-09-26 P1.5, design B5): the workspace snapshot the chat model is
// grounded in carries the ONE inventory-days block as every surface prints
// it, and says whether stock may be called slow — "MAY" only where the
// engine's claim policy allows it (split AND average), with its reason.

import { describe, expect, it } from "vitest";

import { buildWorkspaceSnapshot } from "@/pages/cfo/Chat";
import { printInventoryDays, readInventoryDaysSplit } from "@/lib/inventoryDays";
import type { Statements } from "@/lib/financialReport";

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
