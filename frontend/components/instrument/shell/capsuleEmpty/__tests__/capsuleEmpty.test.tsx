/**
 * THE CAPSULE — empty state + degraded gate (Parts D + F).
 *
 * Drives `CapsuleEmptyStateView` (pure props) rather than the connected
 * mount point, so the suite needs no query client, no router and no auth
 * provider — and so a failure here is a failure of THIS lane, not of the
 * app shell around it.
 *
 * What it locks:
 *   D  the context zone leads; suggestions are computed, capped at three,
 *      and never padded; recents render as pills.
 *   F  C7 — with the assistant down the Ask row reads "CFO AI is
 *      unavailable — search still works" and the router's navigate lane
 *      still resolves with NO model call;
 *      A2 — zero raw payload in the DOM, driven by a realistic provider
 *      400 body pushed through the real mapper.
 */
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CfoApiError } from "@/lib/cfoApi";
import { clearAiDegraded, reportAiFailure, setAiDegraded } from "@/lib/aiDegraded";
import { routeQuery, willCallModel } from "@/lib/capsuleRouter";
import {
  CAPSULE_COVENANT_TESTS,
  buildCapsuleContext,
  buildCapsuleSuggestions,
  looksLikeFigure,
  type CapsuleWorkspaceSnapshot,
} from "@/lib/capsuleSuggestions";

import { CapsuleEmptyStateView } from "../CapsuleEmptyState";
import { CapsuleAskRowNotice, CapsuleAskUnavailable } from "../CapsuleAskUnavailable";
import { CapsuleScopeLabel } from "../CapsuleScopeLabel";
import strings from "../capsuleEmptyStrings.json";
import { useCapsuleAskAvailability } from "../useCapsuleAsk";
import { resetCapsuleAskGuard, reserveCapsuleAsk } from "../capsuleAskGuard";

// A realistic provider 400 body — braces, a request id, an error slug.
const RAW_400 = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "max_tokens: field required" },
  request_id: "req_011CTHagbPFpjPQ2VYbAdi8n",
});
const FORBIDDEN = ["{", "}", "request_id", "req_011", "invalid_request_error", "max_tokens", "400"];

function snapshot(over: Partial<CapsuleWorkspaceSnapshot> = {}): CapsuleWorkspaceSnapshot {
  return {
    hasPeriod: true,
    periodLabel: "Dec 2025",
    trustBand: "balanced",
    findings: [],
    silence: false,
    metrics: [],
    unattached: [],
    ...over,
  };
}

function renderView(
  snap: CapsuleWorkspaceSnapshot,
  mode: "simple" | "pro" = "pro",
  extra: Partial<React.ComponentProps<typeof CapsuleEmptyStateView>> = {},
) {
  const picked: string[] = [];
  render(
    <CapsuleEmptyStateView
      context={buildCapsuleContext(snap)}
      trustLabel={null}
      suggestions={buildCapsuleSuggestions(snap, mode)}
      recents={[]}
      onPick={(q) => picked.push(q)}
      {...extra}
    />,
  );
  return picked;
}

afterEach(() => {
  cleanup();
  clearAiDegraded();
  resetCapsuleAskGuard();
});

// ── D: the context zone ────────────────────────────────────────────────

describe("context zone leads", () => {
  it("names the period and shows the engine's own verdict wording", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot({ trustBand: "reconciled" }))}
        trustLabel="Reconciled"
        suggestions={[]}
        recents={[]}
        onPick={() => {}}
      />,
    );
    expect(screen.getByTestId("capsule-context-period")).toHaveTextContent("Dec 2025");
    expect(screen.getByTestId("capsule-context-trust")).toHaveTextContent("Reconciled");
  });

  it("badges NOTHING on a period with no verdict", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot({ trustBand: null }))}
        trustLabel={null}
        suggestions={[]}
        recents={[]}
        onPick={() => {}}
      />,
    );
    expect(screen.queryByTestId("capsule-context-trust")).toBeNull();
    expect(screen.getByTestId("capsule-context-unverified")).toBeInTheDocument();
  });

  it("with no period loaded, says so and still says search works", () => {
    renderView(snapshot({ hasPeriod: false, periodLabel: null, trustBand: null }));
    expect(screen.getByTestId("capsule-context-zone").textContent).toContain("No period loaded");
    expect(screen.getByTestId("capsule-context-zone").textContent).toMatch(/search/i);
  });

  it("never claims 'no period loaded' about a period it simply cannot name", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot({ periodLabel: "1.553.210", trustBand: "reconciled" }))}
        trustLabel="Reconciled"
        suggestions={[]}
        recents={[]}
        onPick={() => {}}
      />,
    );
    const zone = screen.getByTestId("capsule-context-zone");
    expect(zone.textContent).not.toContain("No period loaded");
    expect(screen.queryByTestId("capsule-context-period")).toBeNull();
    expect(screen.getByTestId("capsule-context-trust")).toHaveTextContent("Reconciled");
  });

  it("falls back to the band's own word when the presenter sent none", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot({ trustBand: "material_imbalance" }))}
        trustLabel={null}
        suggestions={[]}
        recents={[]}
        onPick={() => {}}
      />,
    );
    expect(screen.getByTestId("capsule-context-trust")).toHaveTextContent("Material imbalance");
  });
});

// ── D: computed suggestions, never boilerplate ─────────────────────────

describe("suggestions are computed from this workspace", () => {
  const busy = snapshot({
    findings: [{ key: "f1", severity: "critical", subject: "Receivables provision" }],
    trustBand: "reconciled",
    metrics: [{ name: "dscr", value: 1.2, unit: "ratio" }],
    unattached: [{ periodId: "p1", label: "Nov 2025" }],
  });

  it("renders three, each with its basis line", () => {
    renderView(busy);
    const rows = screen.getAllByTestId("capsule-suggestion");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Receivables provision");
    expect(rows[0].textContent).toContain("Anomaly Radar");
  });

  it("the covenant row admits its test is a default, not the user's facility", () => {
    renderView(snapshot({ metrics: [{ name: "dscr", value: 1.2, unit: "ratio" }] }));
    const row = screen.getByTestId("capsule-suggestion");
    expect(row.textContent).toContain("not your loan documents");
  });

  it("renders FEWER when the state yields fewer — no filler row", () => {
    renderView(snapshot({ unattached: [{ periodId: "p1", label: "Nov 2025" }] }));
    expect(screen.getAllByTestId("capsule-suggestion")).toHaveLength(1);
  });

  it("renders NO suggestion block at all on a clean period", () => {
    renderView(snapshot());
    expect(screen.queryByTestId("capsule-suggestions")).toBeNull();
    // One quiet line, not three invented questions.
    expect(screen.getByTestId("capsule-suggestions-empty")).toBeInTheDocument();
  });

  it("carries no figure in any rendered row", () => {
    renderView(busy);
    for (const row of screen.getAllByTestId("capsule-suggestion")) {
      // Grouped thousands, decimals and unit-bearing numbers are what a
      // presenter produces; none may appear in a palette row.
      expect(row.textContent ?? "").not.toMatch(/\d[.,]\d|\d{1,3}([.,]\d{3})+|\d\s*(RON|EUR|%)/i);
    }
  });

  it("picking hands back the resolved question and does NOT send", () => {
    const picked = renderView(snapshot({ metrics: [{ name: "dscr", value: 1.2, unit: "ratio" }] }));
    fireEvent.click(screen.getByTestId("capsule-suggestion"));
    expect(picked).toEqual(["DSCR headroom at current run-rate?"]);
  });
});

describe("mode-aware phrasing", () => {
  const s = snapshot({ metrics: [{ name: "dscr", value: 1.2, unit: "ratio" }] });

  it("Pro speaks in ratios", () => {
    renderView(s, "pro");
    expect(screen.getByTestId("capsule-suggestion")).toHaveTextContent(
      "DSCR headroom at current run-rate?",
    );
  });

  it("Simple speaks in the owner's words", () => {
    renderView(s, "simple");
    expect(screen.getByTestId("capsule-suggestion")).toHaveTextContent(
      "Can I still cover the loan payments?",
    );
  });
});

// ── D: recents ─────────────────────────────────────────────────────────

describe("recent questions", () => {
  it("lists them as pills with the recall hint", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot())}
        trustLabel={null}
        suggestions={[]}
        recents={["why is profit down?", "dscr headroom?"]}
        onPick={() => {}}
      />,
    );
    expect(screen.getAllByTestId("capsule-recent")).toHaveLength(2);
    expect(screen.getByTestId("capsule-recents").textContent).toContain("↑");
  });

  it("renders nothing when there are none", () => {
    renderView(snapshot());
    expect(screen.queryByTestId("capsule-recents")).toBeNull();
  });

  it("picking a recent reports its source", () => {
    const seen: Array<[string, string]> = [];
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot())}
        trustLabel={null}
        suggestions={[]}
        recents={["why is profit down?"]}
        onPick={(q, source) => seen.push([q, source])}
      />,
    );
    fireEvent.click(screen.getByTestId("capsule-recent"));
    expect(seen).toEqual([["why is profit down?", "recent"]]);
  });
});

// ── F: C7 degraded ─────────────────────────────────────────────────────

describe("C7 — degraded", () => {
  beforeEach(() => {
    // Drive the REAL mapper with a real provider error, then flip the
    // module flag exactly as the send pipeline does.
    setAiDegraded(reportAiFailure(new CfoApiError(RAW_400, 400, RAW_400)));
  });

  it("the Ask row reads 'CFO AI is unavailable — search still works'", () => {
    const { result } = renderHook(() => useCapsuleAskAvailability("u1"));
    expect(result.current.available).toBe(false);
    render(<CapsuleAskRowNotice block={result.current.block!} />);
    expect(screen.getByTestId("capsule-ask-row-notice")).toHaveTextContent(
      "CFO AI is unavailable — search still works",
    );
  });

  it("leaks ZERO raw payload into the DOM", () => {
    const { result } = renderHook(() => useCapsuleAskAvailability("u1"));
    render(
      <>
        <CapsuleAskRowNotice block={result.current.block!} />
        <CapsuleAskUnavailable block={result.current.block!} onRetry={() => {}} />
      </>,
    );
    const text = document.body.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    for (const fragment of FORBIDDEN) {
      expect(text, `leaked: ${fragment}`).not.toContain(fragment);
    }
  });

  it("says the figures are unaffected, and offers Retry when the host can", () => {
    const { result } = renderHook(() => useCapsuleAskAvailability("u1"));
    let retried = 0;
    render(<CapsuleAskUnavailable block={result.current.block!} onRetry={() => { retried += 1; }} />);
    expect(screen.getByTestId("capsule-ask-unavailable").textContent).toMatch(/figures are unchanged/i);
    fireEvent.click(screen.getByTestId("capsule-ask-retry"));
    expect(retried).toBe(1);
  });

  it("offers no Retry when the host has nothing to retry", () => {
    const { result } = renderHook(() => useCapsuleAskAvailability("u1"));
    render(<CapsuleAskUnavailable block={result.current.block!} />);
    expect(screen.queryByTestId("capsule-ask-retry")).toBeNull();
  });

  it("the empty state renders the notice UNDER its rows, not instead of them", () => {
    const { result } = renderHook(() => useCapsuleAskAvailability("u1"));
    renderView(
      snapshot({ metrics: [{ name: "dscr", value: 1.2, unit: "ratio" }] }),
      "pro",
      { askBlock: result.current.block },
    );
    expect(screen.getByTestId("capsule-suggestion")).toBeInTheDocument();
    expect(screen.getByTestId("capsule-ask-unavailable")).toBeInTheDocument();
  });

  it("NAVIGATE / ENTITY / ACTION keep working, and still cost no model call", () => {
    // The router is a pure function — a degraded assistant cannot touch
    // it. This is the structural half of the C7 promise.
    for (const query of ["cash flow", "TLV", "upload trial balance"]) {
      const result = routeQuery(query);
      expect(result.rows.length, query).toBeGreaterThan(0);
      expect(willCallModel(result, result.defaultIndex), query).toBe(false);
    }
  });
});

// ── F: the budget guard, rendered ──────────────────────────────────────

describe("throttle notice", () => {
  it("is calm, names a wait, and never mentions a downgrade", () => {
    reserveCapsuleAsk("u2");
    const { result } = renderHook(() => useCapsuleAskAvailability("u2"));
    expect(result.current.available).toBe(false);
    expect(result.current.block?.kind).toBe("throttled");

    render(<CapsuleAskUnavailable block={result.current.block!} />);
    const text = screen.getByTestId("capsule-ask-unavailable").textContent ?? "";
    expect(text).toMatch(/Nothing is downgraded/i);
    expect(screen.getByTestId("capsule-throttle-countdown")).toBeInTheDocument();
    // Never a Retry: retrying is exactly what the guard is refusing.
    expect(screen.queryByTestId("capsule-ask-retry")).toBeNull();
  });

  it("the Ask row says search still works", () => {
    reserveCapsuleAsk("u3");
    const { result } = renderHook(() => useCapsuleAskAvailability("u3"));
    render(<CapsuleAskRowNotice block={result.current.block!} />);
    expect(screen.getByTestId("capsule-ask-row-notice").textContent).toMatch(/search still works/i);
  });

  it("a dead service outranks a cooldown — one message, not two", () => {
    reserveCapsuleAsk("u4");
    setAiDegraded("network");
    const { result } = renderHook(() => useCapsuleAskAvailability("u4"));
    expect(result.current.block?.kind).toBe("degraded");
  });
});

// ── F: scope honesty ───────────────────────────────────────────────────

describe("scope honesty", () => {
  it("labels a general-knowledge answer 'Not from your books'", () => {
    render(<CapsuleScopeLabel scope="general" periodLabel="Dec 2025" />);
    expect(screen.getByTestId("capsule-scope")).toHaveTextContent("Not from your books");
    expect(screen.getByTestId("capsule-scope-hint").textContent).toMatch(/cites no figure/i);
  });

  it("names the period on a grounded answer, and adds no apology", () => {
    render(<CapsuleScopeLabel scope="books" periodLabel="Dec 2025" />);
    expect(screen.getByTestId("capsule-scope")).toHaveTextContent("From Dec 2025");
    expect(screen.queryByTestId("capsule-scope-hint")).toBeNull();
  });

  it("falls back to period-free wording rather than an empty interpolation", () => {
    render(<CapsuleScopeLabel scope="books" periodLabel={null} />);
    expect(screen.getByTestId("capsule-scope")).toHaveTextContent("From your books");
  });

  it("flags a mixed answer as the one a reader can misread", () => {
    render(<CapsuleScopeLabel scope="mixed" periodLabel="Dec 2025" />);
    expect(screen.getByTestId("capsule-scope")).toHaveTextContent("Partly from your books");
  });
});

// ── i18n: every key the engine can emit exists in BOTH languages ───────
//
// The engine builds keys from data (`CAPSULE_COVENANT_TESTS`, the trust
// variants, the two modes), so a new covenant test or a renamed variant
// silently produces a missing string. This walks the SAME data the
// builder walks and demands both bundles answer.

describe("EN/RO parity for every generated key", () => {
  const dig = (bag: unknown, key: string): unknown =>
    key.split(".").reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      bag,
    );

  const generatedKeys: string[] = [];
  for (const mode of ["simple", "pro"]) {
    generatedKeys.push(`suggest.unattached.${mode}`);
    generatedKeys.push(`suggest.finding.${mode}`);
    generatedKeys.push(`suggest.silence.${mode}`);
    for (const variant of ["imbalance", "drift", "reconciled"]) {
      generatedKeys.push(`suggest.trust.${variant}.${mode}`);
    }
    for (const test of CAPSULE_COVENANT_TESTS) {
      generatedKeys.push(`suggest.covenant.${test.id}.${mode}`);
    }
  }
  for (const kind of ["unattached", "finding", "trust", "covenant", "silence"]) {
    generatedKeys.push(`basis.${kind}`);
  }

  it.each(["en", "ro"] as const)("%s answers every generated key", (lang) => {
    const bag = (strings as Record<string, { capsuleEmpty: unknown }>)[lang].capsuleEmpty;
    const missing = generatedKeys.filter((k) => typeof dig(bag, k) !== "string");
    expect(missing, `missing in ${lang}: ${missing.join(", ")}`).toEqual([]);
  });

  it("the two bundles have identical key shapes", () => {
    const shape = (node: unknown, prefix = ""): string[] => {
      if (typeof node === "string") return [prefix];
      if (!node || typeof node !== "object") return [];
      return Object.entries(node as Record<string, unknown>)
        .flatMap(([k, v]) => shape(v, prefix ? `${prefix}.${k}` : k))
        .sort();
    };
    expect(shape(strings.ro.capsuleEmpty)).toEqual(shape(strings.en.capsuleEmpty));
  });

  it("no bundled string carries a hard-coded figure", () => {
    // Copy is written by hand; a numeral pasted into a suggestion would
    // walk straight past the engine's own parameter guard.
    const walk = (node: unknown, path: string, out: string[]): void => {
      if (typeof node === "string") {
        // `{{seconds}}s` in the throttle countdown is UI chrome, not a
        // financial figure — it interpolates, so the literal is clean.
        if (looksLikeFigure(node)) out.push(`${path}: ${node}`);
        return;
      }
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          walk(v, path ? `${path}.${k}` : k, out);
        }
      }
    };
    const offenders: string[] = [];
    walk(strings.en.capsuleEmpty, "en", offenders);
    walk(strings.ro.capsuleEmpty, "ro", offenders);
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });
});
