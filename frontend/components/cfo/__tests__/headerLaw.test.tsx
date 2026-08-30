/**
 * THE PLACEMENT LAW — vitest half of gates H2 / H3 / H4.
 *
 *   H2 — no-duplicate law: no action wired at header level (TopHeader's
 *        own DOM) resolves to a SHELL_NAV_ALL destination. The sidebar
 *        list is imported from the real module, so the two surfaces can
 *        never drift apart silently. One grandfathered idiom: the brand
 *        mark navigates to /dashboard (logo-home); everything else that
 *        collides is a violation — including ANY control wired to
 *        onOpenAi, whose semantic destination is /chat (AppShell's
 *        openAskCfoAi navigates there).
 *   H3a — tone-map snapshot-lock: the engine-status → chip-tone mapping
 *        is pinned band by band to the classes the lane shipped:
 *          balanced                 → success  ("· machine-computed")
 *          balanced + AI-read (llm) → accent   ("AI-read · verified")
 *          reconciled               → caution  ("· auto-adjusted")
 *          minor_drift/needs_review → caution
 *          material_imbalance       → alert
 *          unverified               → NO chip (no fake trust)
 *   H3b — receipt field parity: the receipt sheet must keep every field
 *        row the receipt carried when the law was written: status
 *        sentence, difference, mapping version (the envelope's version
 *        identity — the closest thing to a snapshot hash it serves),
 *        extraction method + model, the reconciliation check rows, and
 *        the diagnosis codes.
 *   H4 — one ⌘K hint (static half): the palette-hint strings carry no
 *        shortcut text (the <kbd> is the one hint), and TopHeader's own
 *        markup renders exactly one <kbd>.
 *
 * The live halves (H1 budget, H4 live DOM, H5, H6) are in
 * e2e/design/header.spec.ts. The static tripwire that runs without any
 * runtime is scripts/check_header_law.mjs.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within, cleanup } from "@testing-library/react";

// ── jsdom polyfills Radix needs ────────────────────────────────────────
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}

// ── mocks: heavy runtime deps + header children not under this law ─────
// The law governs TopHeader's OWN wiring; popover interiors (account,
// notifications, currency menus) are second-level homes by design and
// carry their own suites. Stubs keep honest testids so the census the
// e2e half counts stays recognisable here.

const navSpy = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navSpy, useSearchParams: () => [new URLSearchParams(), vi.fn()] };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    status: "signed_in",
    user: { id: "u-test", email: "t@example.com" },
    displayName: "Test",
    initials: "T",
  }),
}));
vi.mock("@/lib/useBackendStatus", () => ({ useBackendStatus: () => "connected" }));
vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => mockActivePeriod,
  usePrefetchPeriod: () => () => {},
}));
vi.mock("@/lib/uploadStore", () => ({
  isInFlight: () => false,
  useUploadStore: () => ({ current: null }),
}));
vi.mock("@/lib/chatPendingStore", () => ({ useChatReplyPending: () => false }));
vi.mock("@/lib/features", () => ({ useFeatures: () => ({ features: {} }) }));
vi.mock("@/lib/prefs", () => ({ usePrefSync: () => {}, setPref: vi.fn() }));
vi.mock("@/theme", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn(), mounted: true }),
}));
vi.mock("@/lib/unsavedGuard", () => ({ confirmLeaveUnsaved: () => true }));

vi.mock("@/components/cfo/Logo", () => ({
  Logo: () => <span data-testid="stub-logo" />,
}));
vi.mock("@/components/cfo/AccountMenu", () => ({
  AccountMenu: () => <button type="button" data-testid="account-menu-trigger" />,
}));
vi.mock("@/components/cfo/NotificationsMenu", () => ({
  NotificationsMenu: () => <button type="button" data-testid="notifications-button" />,
}));
// NOTE: the mock for "@/components/cfo/CurrencyMenu" was DELETED here on
// 2026-08-30 (Part E). TopHeader never imported it, and CurrencyMenu is
// no longer rendered anywhere in the app — a mock for a module under
// test that nothing imports is dead weight that makes the suite look
// like it covers a surface it does not.
vi.mock("@/components/cfo/CurrencyToggle", () => ({
  CurrencyToggle: () => <button type="button" data-testid="currency-toggle" />,
}));
vi.mock("@/components/cfo/BackendStatusIndicator", () => ({
  BackendStatusIndicator: () => <span data-testid="stub-backend-dot" />,
}));
vi.mock("@/components/instrument/shell/ContextObject", () => ({
  ContextObject: () => <button type="button" data-testid="context-object" />,
  // The Capsule renders the identity inline instead of mounting the
  // popover, so ContextObject now also exports the label hook.
  useCapsuleLabel: () => "Test Workspace · Dec 2025",
}));
vi.mock("@/components/instrument/shell/ModeSwitch", () => ({
  ModeSwitch: () => <div role="radiogroup" data-testid="mode-switch" />,
  toggleViewMode: () => "pro",
  MODE_PALETTE_ACTION: {
    id: "act-view-mode",
    labelKey: "modes.switch.paletteLabel",
    hintKey: "modes.switch.hint",
    nextMode: () => "pro",
  },
  // The Capsule refactor (2026-08-30) moved the dial into the avatar
  // menu, whose content mounts lazily — so the cross-device sync was
  // extracted into this hook and seated in TopHeader, which is always
  // mounted. The mock must provide it or TopHeader cannot render.
  useViewModeSync: () => {},
}));

// TrustChip: mocked while TopHeader is under test (H2/H4), REAL in the
// H3 suites below — vitest hoists vi.mock, so the switch happens via
// this flag read inside the factory.
let renderRealTrustChip = false;
vi.mock("@/components/instrument/shell/TrustChip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/instrument/shell/TrustChip")>();
  return {
    TrustChip: (props: Record<string, unknown>) =>
      renderRealTrustChip ? <actual.TrustChip {...props} /> : <button type="button" data-testid="trust-chip" />,
  };
});

// servedFacts: the factsFrom gateway is swapped per-test for H3.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockFacts: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockActivePeriod: any = { statements: null, isLoading: false };
vi.mock("@/lib/servedFacts", () => ({ factsFrom: () => mockFacts }));

import { TopHeader } from "@/components/cfo/TopHeader";
import { SHELL_NAV_ALL } from "@/components/cfo/Sidebar";
// The mocked wrapper — delegates to the REAL TrustChip once
// renderRealTrustChip flips (see the vi.mock factory above).
import { TrustChip } from "@/components/instrument/shell/TrustChip";
import shellStrings from "@/components/instrument/shell/shellStrings.json";
// The census is defined ONCE, in the gate script, and imported by both
// runtime halves. See the header of that file for why.
import {
  INTERACTIVE_SELECTORS,
  COMPOSITE_SELECTORS,
  MAX_COMPOSITE_CHILDREN,
  headerCensus,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — plain .mjs gate module, no d.ts by design
} from "../../../../scripts/check_header_law.mjs";

beforeEach(() => {
  cleanup();
  navSpy.mockClear();
  renderRealTrustChip = false;
  mockFacts = null;
  mockActivePeriod = { statements: null, isLoading: false };
});

function renderHeader(overrides: Partial<Parameters<typeof TopHeader>[0]> = {}) {
  const onOpenAi = vi.fn();
  const onOpenPalette = vi.fn();
  const onOpenSidebar = vi.fn();
  const utils = render(
    <TopHeader
      onOpenAi={onOpenAi}
      onOpenSidebar={onOpenSidebar}
      onOpenPalette={onOpenPalette}
      {...overrides}
    />,
  );
  return { ...utils, onOpenAi, onOpenPalette, onOpenSidebar };
}

// ── H2 · the no-duplicate law ──────────────────────────────────────────

describe("H2 — no header-level action duplicates a SHELL_NAV_ALL destination", () => {
  it("clicking every header-level control opens no sidebar destination (brand /dashboard idiom exempt)", () => {
    const { container, onOpenAi } = renderHeader();
    const navDests = new Set(SHELL_NAV_ALL.map((i) => i.to));
    expect(navDests.size).toBeGreaterThan(4); // the import stayed real

    const header = container.querySelector("header");
    expect(header, "TopHeader did not render a <header>").toBeTruthy();

    const violations: string[] = [];
    for (const el of header!.querySelectorAll<HTMLElement>("button, a[href]")) {
      navSpy.mockClear();
      onOpenAi.mockClear();
      fireEvent.click(el);
      const id =
        el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.tagName.toLowerCase();
      if (onOpenAi.mock.calls.length > 0) {
        // onOpenAi's semantic destination is /chat (AppShell.openAskCfoAi)
        // — the sidebar's accent Ask row + ⌘J + palette own that. A header
        // control wired to it is the exact bug class this law exists for.
        violations.push(`${id} → onOpenAi (/chat duplicate)`);
      }
      for (const call of navSpy.mock.calls) {
        const target = String(call[0]).split("?")[0];
        if (!navDests.has(target)) continue;
        const isBrandHome =
          target === "/dashboard" && el.getAttribute("aria-label") === "Go to dashboard";
        if (!isBrandHome) violations.push(`${id} → navigate(${target})`);
      }
    }
    expect(
      violations,
      `PLACEMENT LAW (H2): header-level actions duplicate sidebar destinations:\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });

  it("anchors in the header resolve to no sidebar destination", () => {
    const { container } = renderHeader();
    const navDests = new Set(SHELL_NAV_ALL.map((i) => i.to));
    const hrefs = [...container.querySelectorAll<HTMLAnchorElement>("header a[href]")]
      .map((a) => a.getAttribute("href")!.split("?")[0])
      .filter((h) => navDests.has(h));
    expect(hrefs, `H2: header anchors duplicate sidebar destinations: ${hrefs.join(", ")}`).toEqual([]);
  });
});

// ── H3 · trust parity ──────────────────────────────────────────────────

type Band =
  | "balanced"
  | "reconciled"
  | "needs_review"
  | "minor_drift"
  | "material_imbalance"
  | "unverified";

function fakeFacts({
  band,
  aiRead = false,
  rec = null,
  diagnosis = [],
  mappingVersion = "ro-coa-v7",
  model = null as string | null,
}: {
  band: Band;
  aiRead?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rec?: any;
  diagnosis?: Array<{ code: string; detail: string }>;
  mappingVersion?: string | null;
  model?: string | null;
}) {
  const words: Record<Band, [string, string]> = {
    balanced: ["Balanced", "BALANCED"],
    reconciled: ["Reconciled", "RECONCILED"],
    needs_review: ["Minor drift", "MINOR_DRIFT"],
    minor_drift: ["Minor drift", "MINOR_DRIFT"],
    material_imbalance: ["Material imbalance", "MATERIAL_IMBALANCE"],
    unverified: ["Unverified", "UNVERIFIED"],
  };
  const [displayEn, machineStatus] = words[band];
  return {
    isCanonical: true,
    presentStatus: () => ({
      band,
      machineStatus,
      displayEn,
      displayRo: displayEn,
      exportDetail: null,
    }),
    canonicalForRender: () => ({
      extraction: { method: aiRead ? "llm" : "deterministic", model: model ?? undefined },
    }),
    reconciliation: () => rec,
    diagnosis: () => diagnosis,
    difference: () => 12.34,
    mappingVersion: () => mappingVersion,
  };
}

function renderTrustChip(facts: ReturnType<typeof fakeFacts> | null) {
  renderRealTrustChip = true;
  mockFacts = facts;
  mockActivePeriod = { statements: { currency: "RON" }, isLoading: false };
  return render(<TrustChip />);
}

describe("H3a — the status→tone map is locked, band by band", () => {
  const toneClass = (chip: HTMLElement) => {
    const span = chip.querySelector("span");
    expect(span, "Chip span missing inside trust-chip").toBeTruthy();
    return span!.className;
  };

  it("BALANCED (machine-computed) → success tone", () => {
    renderTrustChip(fakeFacts({ band: "balanced" }));
    const chip = screen.getByTestId("trust-chip");
    expect(chip.textContent).toContain("machine-computed");
    expect(toneClass(chip)).toContain("text-success");
  });

  it("BALANCED + AI-read → accent tone, 'AI-read · verified'", () => {
    renderTrustChip(fakeFacts({ band: "balanced", aiRead: true }));
    const chip = screen.getByTestId("trust-chip");
    expect(chip.textContent).toContain("AI-read");
    expect(chip.textContent).toContain("verified");
    expect(toneClass(chip)).toContain("bg-brand-tint");
  });

  it("RECONCILED → caution tone, '· auto-adjusted'", () => {
    renderTrustChip(fakeFacts({ band: "reconciled" }));
    const chip = screen.getByTestId("trust-chip");
    expect(chip.textContent).toContain("auto-adjusted");
    expect(toneClass(chip)).toContain("text-caution");
  });

  it("MINOR_DRIFT / needs_review → caution tone", () => {
    for (const band of ["minor_drift", "needs_review"] as Band[]) {
      cleanup();
      renderTrustChip(fakeFacts({ band }));
      expect(toneClass(screen.getByTestId("trust-chip"))).toContain("text-caution");
    }
  });

  it("MATERIAL_IMBALANCE → alert tone", () => {
    renderTrustChip(fakeFacts({ band: "material_imbalance" }));
    expect(toneClass(screen.getByTestId("trust-chip"))).toContain("text-alert");
  });

  it("UNVERIFIED → no chip at all (no fake trust)", () => {
    renderTrustChip(fakeFacts({ band: "unverified" }));
    expect(screen.queryByTestId("trust-chip")).toBeNull();
  });

  it("the chip's dot inherits the tone color (bg-current inside the tone span)", () => {
    renderTrustChip(fakeFacts({ band: "balanced" }));
    const dot = screen.getByTestId("trust-chip").querySelector("span > span[aria-hidden]");
    expect(dot, "tone dot missing from the chip").toBeTruthy();
    expect(dot!.className).toContain("bg-current");
  });
});

describe("H3b — the receipt keeps every locked field row", () => {
  it("status · difference · mapping version · method · model · checks · diagnosis all render", () => {
    renderTrustChip(
      fakeFacts({
        band: "reconciled",
        aiRead: true,
        model: "claude-test-1",
        mappingVersion: "ro-coa-v7",
        rec: {
          original_difference: 123.45,
          applied_delta: -123.45,
          placement: "pnl",
          origin: "llm_proposed",
          applied_at: "2026-08-29T00:00:00Z",
          rationale: "test rationale",
        },
        diagnosis: [{ code: "E8", detail: "jurisdiction guard" }],
      }),
    );
    fireEvent.click(screen.getByTestId("trust-chip"));
    const receipt = within(screen.getByTestId("trust-receipt"));

    // The status sentence.
    expect(receipt.getByText("Balance receipt")).toBeInTheDocument();
    expect(receipt.getByText("Status")).toBeInTheDocument();
    expect(receipt.getByText("RECONCILED")).toBeInTheDocument();
    // The number the verdict stands on.
    expect(receipt.getByText("Difference")).toBeInTheDocument();
    // The envelope's version identity (its snapshot/mapping hash).
    expect(receipt.getByText("Mapping version")).toBeInTheDocument();
    expect(receipt.getByText("ro-coa-v7")).toBeInTheDocument();
    // The method line — killing it must fail this gate.
    expect(receipt.getByText("Extraction")).toBeInTheDocument();
    expect(receipt.getByText("llm")).toBeInTheDocument();
    expect(receipt.getByText("Model")).toBeInTheDocument();
    expect(receipt.getByText("claude-test-1")).toBeInTheDocument();
    // The checks: reconciliation rows.
    expect(receipt.getByText("Reconciliation")).toBeInTheDocument();
    expect(receipt.getByText("Original difference")).toBeInTheDocument();
    expect(receipt.getByText("Applied adjustment")).toBeInTheDocument();
    expect(receipt.getByText("Placement")).toBeInTheDocument();
    expect(receipt.getByText("Origin")).toBeInTheDocument();
    // The diagnosis codes.
    expect(receipt.getByText("Diagnosis")).toBeInTheDocument();
    expect(receipt.getByText("E8")).toBeInTheDocument();
  });
});

// ── H4 · one ⌘K hint (static half) ─────────────────────────────────────

describe("H4 — the ⌘K hint lives in the <kbd> alone", () => {
  it("palette hint strings (en + ro) carry no shortcut text", () => {
    for (const lang of ["en", "ro"] as const) {
      // The Capsule has no placeholder sentence, so the key was removed
      // outright — absence is the strictest possible pass. If a future
      // hint is reintroduced it must still carry no shortcut text.
      const palette = (shellStrings as Record<string, { shell: { palette: Record<string, string> } }>)[
        lang
      ].shell.palette;
      const hint = palette.hint;
      if (hint === undefined) continue;
      expect(
        hint,
        `H4: shell.palette.hint (${lang}) repeats the shortcut ("${hint}") — the <kbd> is the ONE hint`,
      ).not.toMatch(/⌘|\{\{mod\}\}|ctrl|cmd/i);
    }
  });

  it("TopHeader's own markup renders exactly one <kbd>, and the bar text is clean", () => {
    const { container } = renderHeader();
    const header = container.querySelector("header")!;
    const kbds = header.querySelectorAll("kbd");
    expect(kbds.length, "H4: the header must render exactly one <kbd> (the ⌘K badge)").toBe(1);

    const bar = header.querySelector('[data-testid="header-command-bar"]');
    expect(bar, "header command bar missing").toBeTruthy();
    const clone = bar!.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("kbd").forEach((k) => k.remove());
    const text = (clone.textContent ?? "").trim();
    expect(
      text,
      `H4: the command bar's text ("${text}") repeats the shortcut — the <kbd> is the ONE hint`,
    ).not.toMatch(/⌘|ctrl|cmd|K\b/i);
  });
});

// ── H1s · the census, structurally (the trust-present case) ────────────
//
// The LIVE gate cannot reach this case: the test-mode demo period serves
// no canonical envelope, so the trust chip never renders there and the
// Capsule is only ever measured holding ONE child. Here the chip is
// mocked into existence, which is the only place the two-child Capsule
// can be proven to still collapse to one control.
//
// Structural, not responsive: jsdom has no layout and never resolves
// `lg:hidden`, so BOTH left-slot controls and the bell appear. The live
// gate owns which of them paint at which width.

describe("H1s — the Capsule collapses to ONE control even when it holds the trust chip", () => {
  const structuralCensus = (header: HTMLElement) =>
    headerCensus(header, {
      selectors: INTERACTIVE_SELECTORS,
      composites: COMPOSITE_SELECTORS,
      structural: true,
    });

  it("counts the Capsule once, and swallows both of its children", () => {
    const { container } = renderHeader();
    const header = container.querySelector("header")!;
    const census = structuralCensus(header);

    expect(
      census.items.map((i: { testid: string | null }) => i.testid),
      "H1s: the header's structural control set changed. Live-width filtering is the e2e gate's job; " +
        "this list is every control that exists at all.",
    ).toEqual([
      "header-nav-toggle",
      "header-brand",
      "header-capsule",
      "notifications-button",
      "account-menu-trigger",
    ]);

    const capsule = census.composites.find(
      (c: { testid: string | null }) => c.testid === "header-capsule",
    );
    expect(capsule, "H1s: the Capsule is no longer recognised as a composite").toBeTruthy();
    expect(
      capsule.children.map((c: { testid: string | null }) => c.testid),
      "H1s: the Capsule's interior changed — it must hold exactly the trust control and the command bar",
    ).toEqual(["trust-chip", "header-command-bar"]);
    expect(
      capsule.children.length,
      "H1b: a composite may not become a hiding place for a growing control cluster",
    ).toBeLessThanOrEqual(MAX_COMPOSITE_CHILDREN);
  });

  it("no radiogroup survives in the bar (the dial is gone, not hidden)", () => {
    const { container } = renderHeader();
    const header = container.querySelector("header")!;
    expect(
      header.querySelectorAll('[role="radiogroup"], [data-testid="mode-switch"]').length,
      "H7: the Simple|Pro dial is back in TopHeader's own markup. Its homes are the avatar menu, " +
        "Settings > Appearance and the ⌘K palette action (MODE_PALETTE_ACTION in ModeSwitch.tsx).",
    ).toBe(0);
  });
});

// ── H7 · the dial left the bar but not the product ─────────────────────

describe("H7 — the relocated dial is still wired", () => {
  it("TopHeader still seats useViewModeSync (cross-device adoption)", async () => {
    // The avatar menu's content mounts lazily, so the sync hook cannot
    // live there. Deleting this call from TopHeader would silently kill
    // remote view-mode adoption with no visible symptom.
    const src = await import("@/components/cfo/TopHeader?raw").catch(() => null);
    // `?raw` is a Vite feature and may be unavailable under some vitest
    // configs — fall back to asserting the module's behaviour instead.
    if (src && typeof (src as { default?: string }).default === "string") {
      expect((src as { default: string }).default).toMatch(/useViewModeSync\s*\(\s*\)/);
    } else {
      const mod = await import("@/components/instrument/shell/ModeSwitch");
      expect(typeof mod.useViewModeSync, "useViewModeSync must remain exported for TopHeader").toBe(
        "function",
      );
    }
  });

  it("publishes a palette action descriptor for the ⌘K lane", async () => {
    const mod = await vi.importActual<typeof import("@/components/instrument/shell/ModeSwitch")>(
      "@/components/instrument/shell/ModeSwitch",
    );
    expect(mod.MODE_PALETTE_ACTION.id).toBe("act-view-mode");
    expect(mod.MODE_PALETTE_ACTION.labelKey).toBe("modes.switch.paletteLabel");
    expect(typeof mod.toggleViewMode, "toggleViewMode is the one mutation the action needs").toBe(
      "function",
    );
    // The label key must actually resolve in BOTH languages, or the
    // palette row would render a raw key when the lane wires it up.
    const strings = (await import("@/components/instrument/shell/modeStrings.json")).default as {
      en: { modes: { switch: Record<string, string> } };
      ro: { modes: { switch: Record<string, string> } };
    };
    for (const lang of ["en", "ro"] as const) {
      expect(
        strings[lang].modes.switch.paletteLabel,
        `H7: modes.switch.paletteLabel missing for ${lang}`,
      ).toBeTruthy();
    }
  });
});

// ── H6s · the relocation coach mark (static half) ──────────────────────

describe("H6s — the relocation coach mark", () => {
  const COACH_KEY = "cfo:header-mode-coachmark-v1";
  const VIEW_MODE_KEY = "cfo-view-mode-v1";

  // This runner's `window.localStorage` is an EMPTY OBJECT with no
  // methods (Node's own localStorage shadows jsdom's — the runner even
  // warns "`--localstorage-file` was provided without a valid path").
  // The product guards every access in try/catch, so it degrades to
  // "never arm" here — which would let all four of these tests pass
  // while proving nothing. Install a real in-memory Storage instead.
  let store: Record<string, string> = {};
  const memoryStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };

  beforeEach(() => {
    store = {};
    Object.defineProperty(window, "localStorage", {
      value: memoryStorage,
      configurable: true,
      writable: true,
    });
  });

  it("does NOT arm for a user who never operated the dial", () => {
    renderHeader();
    expect(
      screen.queryByTestId("header-coach-mark"),
      "H6s: a first-run user is being told a control they never touched has moved",
    ).toBeNull();
  });

  it("arms for a user who holds an explicit view-mode choice", () => {
    window.localStorage.setItem(VIEW_MODE_KEY, "pro");
    renderHeader();
    expect(screen.getByTestId("header-coach-mark")).toBeInTheDocument();
  });

  it("Escape dismisses it, and it never re-shows", () => {
    window.localStorage.setItem(VIEW_MODE_KEY, "pro");
    renderHeader();
    expect(screen.getByTestId("header-coach-mark")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("header-coach-mark")).toBeNull();
    expect(window.localStorage.getItem(COACH_KEY)).toBe("dismissed");

    cleanup();
    renderHeader(); // a fresh mount == a reload
    expect(
      screen.queryByTestId("header-coach-mark"),
      "H6s: a dismissed coach mark came back — 'one-time' must survive a remount",
    ).toBeNull();
  });

  it("is portaled OUT of the header, so it spends no budget", () => {
    window.localStorage.setItem(VIEW_MODE_KEY, "pro");
    const { container } = renderHeader();
    const header = container.querySelector("header")!;
    expect(
      header.querySelector('[data-testid="header-coach-mark"]'),
      "H6s: the coach mark rendered INSIDE <header> — it would then count as a header control",
    ).toBeNull();
    expect(screen.getByTestId("header-coach-mark")).toBeInTheDocument();
  });
});
