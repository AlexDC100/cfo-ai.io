// pricingMatchesRegistry — A PLAN MAY ONLY SELL WHAT THE PRODUCT SERVES.
//
// THE CLAIM THIS ASSERTS
//   For every plan the product offers, every feature line it shows names a
//   registry entry whose status is `active` — or is explicitly marked as
//   available after launch, in BOTH languages, and only while that
//   feature is genuinely not active.
//
// WHY THIS FILE EXISTS
//   Measured 2026-09-06 on https://cfo-ai.io/pricing: all three plans sold
//   an "Ask CFO AI" message allowance (Solo 10/day 50/month, Pro 25/day
//   150/month, Multi-Country 40/day 200/month) and Pro — the MOST POPULAR
//   card — sold "Benchmark intelligence", while GET /api/features/status
//   reported `chat_page: hidden` and `benchmarks: hidden`. A customer who
//   paid for either reached "Not in this release". Nothing checked pricing
//   copy against the registry; the existing LR3 gate only bans the literal
//   string "Coming soon".
//
// WHY IT IS DRIVEN BY THE REGISTRY FILE, NOT A LIST IN THIS FILE
//   The statuses are parsed out of `src/engine/api/_features.py` — the one
//   authority behind GET /api/features/status. Flip `benchmarks` to
//   `active` there and this gate follows without an edit here; flip
//   something a plan sells to `hidden` and it reds. A hand-kept copy of
//   the statuses would just be a second thing to forget.
//
// WHY VITEST AND NOT e2e/
//   The claim is about copy and the registry, and it must hold in the tree
//   it ships with — no dev server, no built bundle, no live backend, and
//   no import from an uncommitted wave. Rendering PricingTableV2 under
//   jsdom reads the real DOM (TC-7) in both languages while parsing the
//   real Python registry from disk. An e2e spec could only see whatever
//   registry the running backend happened to serve.
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11)
//   · a plan bullet naming a feature whose registry status is not `active`
//     without the after-launch marker — named plan, bullet, key, status;
//   · a bullet naming a key that is not in the registry at all;
//   · an after-launch marker left on a feature that has since gone
//     `active` (the copy lying in the other direction);
//   · a bullet missing its English or Romanian half;
//   · the rendered card showing a bullet the data does not declare, or
//     dropping the marker from a rendered after-launch line;
//   · the registry file becoming unparseable (floor assertion below).
//
// WHAT IT CANNOT SEE (TC-11)
//   Marketing prose that DESCRIBES a feature without naming its key. A
//   bullet may carry `featureKey: null` because it states a quota ("15
//   Romanian documents / month") — and the same escape would hide a line
//   like "Industry percentile comparison" that names `benchmarks` in
//   everything but the key. A stem-match sweep over prose was tried and
//   rejected: the registry's own labels produce false positives that would
//   force worse copy ("Accounting connector" hits Multi-Country's truthful
//   "Any accounting jurisdiction"). The null-key bullets are therefore
//   listed explicitly in the test below, so adding one is a visible diff
//   rather than a silent hole, and the reviewer's grep is recorded in the
//   Stream-3 report rather than encoded as a lossy law.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import i18n from "@/i18n";

import { PricingTableV2 } from "@/components/cfo/PricingTableV2";
import {
  AFTER_LAUNCH_MARKER_EN,
  AFTER_LAUNCH_MARKER_RO,
  planFeatureBulletsFor,
  planKeysWithFeatures,
  type PlanFeatureBullet,
} from "@/lib/planFeatures";
import {
  __clearFeaturesForTest,
  __setFeaturesForTest,
  type FeatureRegistry,
  type FeatureStatus,
} from "@/lib/features";
import {
  __clearPricingConfigForTest,
  __setPricingConfigForTest,
  type PlanConfig,
  type PlanKey,
  type PricingPublicConfig,
} from "@/lib/pricingConfig";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ status: "signed_out", displayName: null, user: null }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

// ── The registry, read from the file that serves it ───────────────────

const REGISTRY_PATH = resolve(__dirname, "../../../src/engine/api/_features.py");

/** Parse `"<key>": _feature("<status>",` out of the real registry. */
function parseRegistry(): Record<string, FeatureStatus> {
  const src = readFileSync(REGISTRY_PATH, "utf8");
  const out: Record<string, FeatureStatus> = {};
  const rx = /"([a-z0-9_]+)":\s*_feature\(\s*"(active|coming_soon|hidden)"/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) out[m[1]] = m[2] as FeatureStatus;
  return out;
}

let STATUS: Record<string, FeatureStatus>;

beforeAll(() => {
  STATUS = parseRegistry();
});

// ── A pricing config that carries every plan key with copy ────────────

function plan(p: Partial<PlanConfig> & { key: PlanKey }): PlanConfig {
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

const CONFIG: PricingPublicConfig = {
  plans: [
    plan({ key: "trial" }),
    plan({ key: "intro", price_eur: 0.99, window_days: 7 }),
    plan({
      key: "solo", display_name: "RO Solo", price_eur: 4.99, recurring: true,
      purchasable: true, included_docs: 3, extra_doc_eur: 1.49, max_workspaces: 1,
    }),
    plan({
      key: "pro", display_name: "Pro", price_eur: 9.99, recurring: true,
      purchasable: true, included_docs: 15, extra_doc_eur: 0.99, max_workspaces: 5,
    }),
    plan({
      key: "multi", display_name: "Multi-Country", price_eur: 16.99, recurring: true,
      purchasable: true, included_docs: 15, extra_doc_eur: 0.99, max_workspaces: 5,
      allows_non_ro: true, included_nonro_docs: 8, extra_nonro_doc_eur: 1.49,
    }),
    plan({ key: "starter", display_name: "Starter", price_eur: 14.99, recurring: true, purchasable: false }),
  ],
};

/** Seed lib/features' module cache with the REAL statuses, so the rendered
 *  page sees exactly what the backend would serve. */
function seedRegistry(overrides: Record<string, FeatureStatus> = {}) {
  const merged = { ...STATUS, ...overrides };
  const reg: FeatureRegistry = {};
  for (const [k, status] of Object.entries(merged)) {
    (reg as Record<string, unknown>)[k] = { status, label: k, description: "" };
  }
  __setFeaturesForTest(reg);
}

beforeEach(() => {
  cleanup();
  __setPricingConfigForTest(CONFIG);
  seedRegistry();
});

afterEach(async () => {
  cleanup();
  __clearPricingConfigForTest();
  __clearFeaturesForTest();
  await i18n.changeLanguage("en");
});

// ── 0. The parse itself ───────────────────────────────────────────────

describe("the registry this gate reads", () => {
  it("parses the real _features.py, not an empty file", () => {
    // A floor, so a rename or a reformat that breaks the regex reds here
    // instead of silently passing every plan.
    expect(Object.keys(STATUS).length).toBeGreaterThanOrEqual(40);
    expect(STATUS.dashboard).toBeDefined();
    expect(STATUS.chat_page).toBeDefined();
    expect(STATUS.benchmarks).toBeDefined();
  });
});

// ── 1. The data claim, every plan, both languages ─────────────────────

/** Bullets that deliberately name no registry key, listed so that adding
 *  one is a visible diff. Each is a plan quota/limit or a surface with no
 *  registry gate at all (Valuation + Export tabs, /workspace). */
const NULL_KEY_BULLETS_EN = [
  "HTML and Excel report export",
  "1 workspace",
  "Valuation module",
  "Up to 5 workspaces",
  "Everything in Pro",
  "Any accounting jurisdiction",
  "No card required",
  "7-day unlock, one-time payment",
];

function describeBullet(planKey: PlanKey, b: PlanFeatureBullet): string {
  return `plan "${planKey}" line "${b.en}" (key=${b.featureKey ?? "null"})`;
}

describe("every plan line names a feature the product serves", () => {
  it("names only keys that exist in the registry", () => {
    const offences: string[] = [];
    for (const key of planKeysWithFeatures()) {
      for (const b of planFeatureBulletsFor(key)) {
        if (b.featureKey && STATUS[b.featureKey] === undefined) {
          offences.push(`${describeBullet(key, b)} — no such registry entry`);
        }
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("sells nothing the registry does not report active, unless marked after launch", () => {
    const offences: string[] = [];
    for (const key of planKeysWithFeatures()) {
      for (const b of planFeatureBulletsFor(key)) {
        if (!b.featureKey) continue;
        const status = STATUS[b.featureKey];
        if (status === "active") continue;
        if (b.afterLaunch !== true) {
          offences.push(
            `${describeBullet(key, b)} — registry status is "${status}", ` +
              `and the line is not marked as available after launch`,
          );
          continue;
        }
        if (!b.en.includes(AFTER_LAUNCH_MARKER_EN)) {
          offences.push(`${describeBullet(key, b)} — EN copy omits "${AFTER_LAUNCH_MARKER_EN}"`);
        }
        if (!b.ro.includes(AFTER_LAUNCH_MARKER_RO)) {
          offences.push(`${describeBullet(key, b)} — RO copy omits "${AFTER_LAUNCH_MARKER_RO}"`);
        }
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("carries no stale after-launch marker on a feature that went active", () => {
    const offences: string[] = [];
    for (const key of planKeysWithFeatures()) {
      for (const b of planFeatureBulletsFor(key)) {
        const status = b.featureKey ? STATUS[b.featureKey] : undefined;
        if (b.afterLaunch === true && status === "active") {
          offences.push(
            `${describeBullet(key, b)} — marked after-launch but the registry ` +
              `now reports it active; the copy under-sells a live feature`,
          );
        }
        if (b.afterLaunch !== true) {
          if (b.en.includes(AFTER_LAUNCH_MARKER_EN) || b.ro.includes(AFTER_LAUNCH_MARKER_RO)) {
            offences.push(`${describeBullet(key, b)} — carries the marker text without the flag`);
          }
        }
        if (b.afterLaunch === true && !b.featureKey) {
          offences.push(`${describeBullet(key, b)} — after-launch with no feature to track`);
        }
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("has both language halves on every line", () => {
    const offences: string[] = [];
    for (const key of planKeysWithFeatures()) {
      for (const b of planFeatureBulletsFor(key)) {
        if (!b.en.trim()) offences.push(`plan "${key}" — a line has no English copy`);
        if (!b.ro.trim()) offences.push(`plan "${key}" line "${b.en}" — no Romanian copy`);
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("declares every key-less line, so a new one cannot slip in unnoticed", () => {
    const found = new Set<string>();
    for (const key of planKeysWithFeatures()) {
      for (const b of planFeatureBulletsFor(key)) {
        if (!b.featureKey) found.add(b.en);
      }
    }
    const undeclared = [...found].filter((s) => !NULL_KEY_BULLETS_EN.includes(s));
    expect(
      undeclared,
      `key-less lines not listed in NULL_KEY_BULLETS_EN (the gate cannot check ` +
        `what they name):\n${undeclared.join("\n")}`,
    ).toEqual([]);
  });
});

// ── 2. What actually renders (TC-7), EN and RO ────────────────────────

const RENDERED_PLANS: PlanKey[] = ["solo", "pro", "multi"];

function renderTable() {
  return render(
    <MemoryRouter>
      <PricingTableV2 />
    </MemoryRouter>,
  );
}

function renderedBullets(planKey: PlanKey) {
  const list = screen.getByTestId(`pricing-plan-${planKey}-features`);
  return [...list.querySelectorAll("li")].map((li) => ({
    text: (li.textContent ?? "").trim(),
    featureKey: li.getAttribute("data-feature-key") ?? "",
    afterLaunch: li.getAttribute("data-after-launch") === "true",
  }));
}

describe.each([
  ["en", AFTER_LAUNCH_MARKER_EN] as const,
  ["ro", AFTER_LAUNCH_MARKER_RO] as const,
])("the rendered /pricing cards (%s)", (lang, marker) => {
  beforeEach(async () => {
    await i18n.changeLanguage(lang);
  });

  it("shows a line for every declared bullet, and no others", () => {
    renderTable();
    for (const key of RENDERED_PLANS) {
      const declared = planFeatureBulletsFor(key).map((b) =>
        lang === "ro" ? b.ro : b.en,
      );
      const rendered = renderedBullets(key).map((r) => r.text);
      expect(rendered, `plan "${key}" (${lang}) rendered lines`).toEqual(declared);
    }
  });

  it("every rendered line resolves to an active feature or shows the marker", () => {
    renderTable();
    const offences: string[] = [];
    for (const key of RENDERED_PLANS) {
      for (const r of renderedBullets(key)) {
        if (!r.featureKey) continue;
        const status = STATUS[r.featureKey];
        if (status === "active") continue;
        offences.push(
          ...(r.afterLaunch
            ? []
            : [`${key} (${lang}): "${r.text}" names ${r.featureKey} (${status}) with no marker`]),
          ...(r.afterLaunch && !r.text.includes(marker)
            ? [`${key} (${lang}): "${r.text}" is marked after-launch but does not say so on screen`]
            : []),
        );
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("shows the two measured offenders as after-launch, not as included", () => {
    // The concrete regression this file was written for. Reds if the chat
    // allowance or benchmark intelligence goes back to reading as included
    // while its registry row is hidden.
    renderTable();
    for (const key of RENDERED_PLANS) {
      for (const r of renderedBullets(key)) {
        if (r.featureKey !== "chat_page" && r.featureKey !== "benchmarks") continue;
        if (STATUS[r.featureKey] === "active") continue;
        expect(r.afterLaunch, `${key} (${lang}): "${r.text}"`).toBe(true);
        expect(r.text, `${key} (${lang})`).toContain(marker);
      }
    }
  });
});
