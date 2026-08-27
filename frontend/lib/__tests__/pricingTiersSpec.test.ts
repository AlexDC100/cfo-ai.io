// Pricing 2026-08 tier restructure — pure-helper contract tests.
//
// THE TIER SPEC (single source of truth):
//   trial 0 · intro 0.99 one-time · solo 4.99 · pro 9.99 · multi 16.99
// Rules under test here:
//   · `purchasablePaidPlans` returns the recurring purchasable tiers,
//     price-ascending, NEVER including retired `starter` (even when an
//     old backend omits the `purchasable` flag entirely).
//   · `workspaceCapReached` fails OPEN: no plan state / no cap field
//     ⇒ never blocks the create-workspace UI (server is the floor).
//   · `parseUploadRefusal` recognizes the typed non-RO refusal from the
//     upload/scan path in both wire shapes (FastAPI `detail` envelope
//     and bare top-level `error`).

import { describe, it, expect } from "vitest";

import {
  purchasablePaidPlans,
  type PlanConfig,
  type PricingPublicConfig,
} from "@/lib/pricingConfig";
import { workspaceCapReached, type PlanState } from "@/lib/planState";
import { friendlyDocumentError, parseUploadRefusal } from "@/lib/uploadRefusals";
import { isWorkspaceLimitMessage } from "@/lib/org";

function plan(p: Partial<PlanConfig> & { key: PlanConfig["key"] }): PlanConfig {
  return {
    display_name: p.key,
    blurb: "",
    price_eur: 0,
    recurring: false,
    requires_card: false,
    included_docs: 1,
    extra_doc_eur: null,
    chat_daily_cap: null,
    chat_monthly_cap: null,
    window_days: null,
    ...p,
  } as PlanConfig;
}

const NEW_CONFIG: PricingPublicConfig = {
  plans: [
    plan({ key: "trial", price_eur: 0 }),
    plan({ key: "intro", price_eur: 0.99 }),
    plan({ key: "multi", price_eur: 16.99, recurring: true, purchasable: true }),
    plan({ key: "solo", price_eur: 4.99, recurring: true, purchasable: true }),
    plan({ key: "pro", price_eur: 9.99, recurring: true, purchasable: true }),
    // Retired tier: backend keeps it resolvable for legacy holders but
    // marks it non-purchasable.
    plan({ key: "starter", price_eur: 14.99, recurring: true, purchasable: false }),
  ],
};

const OLD_CONFIG: PricingPublicConfig = {
  // Pre-restructure backend: no purchasable flag anywhere.
  plans: [
    plan({ key: "trial" }),
    plan({ key: "intro", price_eur: 0.99 }),
    plan({ key: "starter", price_eur: 14.99, recurring: true }),
    plan({ key: "pro", price_eur: 39.99, recurring: true }),
  ],
};

describe("purchasablePaidPlans", () => {
  it("returns solo/pro/multi price-ascending from the new config", () => {
    const keys = purchasablePaidPlans(NEW_CONFIG).map((p) => p.key);
    expect(keys).toEqual(["solo", "pro", "multi"]);
  });

  it("never returns starter, even from an old backend without the flag", () => {
    const keys = purchasablePaidPlans(OLD_CONFIG).map((p) => p.key);
    expect(keys).toEqual(["pro"]);
  });

  it("excludes trial and intro (non-recurring)", () => {
    for (const p of purchasablePaidPlans(NEW_CONFIG)) {
      expect(p.recurring).toBe(true);
    }
  });

  it("returns [] on null config", () => {
    expect(purchasablePaidPlans(null)).toEqual([]);
  });
});

describe("workspaceCapReached", () => {
  const base = {
    plan_key: "solo",
    plan_display_name: "RO Solo",
    plan_price_eur: 4.99,
    plan_recurring: true,
    included_docs: 3,
    extra_doc_eur: 1.49,
    docs_used: 0,
    extra_docs_billed_this_period: 0,
    chat_used_today: 0,
    chat_daily_cap: 10,
    chat_used_this_period: 0,
    chat_monthly_cap: 50,
    window_expires_at: null,
    today: "2026-08-27",
    period_month: "2026-08",
  } as PlanState;

  it("fails open when there is no plan state", () => {
    expect(workspaceCapReached(null, 99)).toBe(false);
  });

  it("fails open when the backend hasn't surfaced max_workspaces yet", () => {
    expect(workspaceCapReached(base, 99)).toBe(false);
  });

  it("blocks at the cap and above it", () => {
    const s = { ...base, max_workspaces: 1 };
    expect(workspaceCapReached(s, 0)).toBe(false);
    expect(workspaceCapReached(s, 1)).toBe(true);
    expect(workspaceCapReached(s, 2)).toBe(true);
  });

  it("allows below the cap on multi-workspace tiers", () => {
    const s = { ...base, plan_key: "pro" as const, max_workspaces: 5 };
    expect(workspaceCapReached(s, 4)).toBe(false);
    expect(workspaceCapReached(s, 5)).toBe(true);
  });
});

describe("parseUploadRefusal", () => {
  it("recognizes the FastAPI detail envelope", () => {
    const r = parseUploadRefusal({
      detail: {
        error: "non_ro_not_included",
        upgrade_to: "multi",
        message: "Non-Romanian documents require Multi-Country.",
      },
    });
    expect(r).toEqual({
      kind: "non_ro_blocked",
      upgradeTo: "multi",
      message: "Non-Romanian documents require Multi-Country.",
    });
  });

  it("recognizes the bare top-level shape", () => {
    const r = parseUploadRefusal({ error: "non_ro_not_included", upgrade_to: "multi" });
    expect(r?.kind).toBe("non_ro_blocked");
    expect(r?.upgradeTo).toBe("multi");
  });

  it("also accepts `code` as the discriminator field", () => {
    const r = parseUploadRefusal({ detail: { code: "non_ro_not_included" } });
    expect(r?.kind).toBe("non_ro_blocked");
    expect(r?.upgradeTo).toBe("multi"); // default target
  });

  it("returns null for anything else", () => {
    expect(parseUploadRefusal({ detail: { code: "doc_quota_blocked" } })).toBeNull();
    expect(parseUploadRefusal({})).toBeNull();
    expect(parseUploadRefusal(null)).toBeNull();
    expect(parseUploadRefusal("nope")).toBeNull();
  });
});

describe("friendlyDocumentError", () => {
  // The pipeline persists the refusal VERBATIM into documents.error —
  // this is what the status subscription hands to every failure surface.
  const persisted = JSON.stringify({
    error: "non_ro_not_included",
    upgrade_to: "multi",
    plan_key: "solo",
    message: "Non-RO documents require the Multi-Country plan.",
  });

  it("swaps the persisted refusal JSON for friendly copy", () => {
    const out = friendlyDocumentError(persisted);
    expect(out).toBeTruthy();
    expect(out).not.toContain("{");
    expect(out).not.toContain("non_ro_not_included");
  });

  it("passes ordinary errors through untouched", () => {
    expect(friendlyDocumentError("Extraction failed: bad workbook")).toBe(
      "Extraction failed: bad workbook",
    );
    expect(friendlyDocumentError(null)).toBeNull();
    expect(friendlyDocumentError(undefined)).toBeUndefined();
  });

  it("surfaces the server message for the non-RO monthly cap", () => {
    const capped = JSON.stringify({
      error: "nonro_quota_exhausted",
      message: "You've used all 8 non-RO documents this month.",
    });
    expect(friendlyDocumentError(capped)).toBe(
      "You've used all 8 non-RO documents this month.",
    );
  });
});

describe("isWorkspaceLimitMessage", () => {
  it("matches the RPC's workspace_cap_reached prefix", () => {
    expect(
      isWorkspaceLimitMessage(
        "workspace_cap_reached: your solo plan allows 1 workspace(s). Upgrade to add more.",
      ),
    ).toBe(true);
  });

  it("matches legacy 'workspace limit' phrasings", () => {
    expect(isWorkspaceLimitMessage("Workspace limit reached")).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isWorkspaceLimitMessage("Not authenticated.")).toBe(false);
    expect(isWorkspaceLimitMessage(null)).toBe(false);
  });
});
