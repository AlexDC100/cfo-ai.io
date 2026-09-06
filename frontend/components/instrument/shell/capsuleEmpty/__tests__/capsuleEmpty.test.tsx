/**
 * THE CAPSULE — empty state + degraded gate (Parts D + F).
 *
 * Drives `CapsuleEmptyStateView` (pure props) rather than the connected
 * mount point, so the suite needs no query client, no router and no auth
 * provider — and so a failure here is a failure of THIS lane, not of the
 * app shell around it.
 *
 * What it locks:
 *   B  THREE ZONES and no fourth — a one-line context strip, up to three
 *      computed asks, four jumps. Recents are NOT a zone (they moved to
 *      ⌘K → ArrowUp), and the removed sections stay removed.
 *   D  suggestions are computed, capped at three, and never padded.
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
import { MAX_JUMPS } from "../CapsuleJumpList";
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
    moves: [],
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
      jumps={[]}
      onJump={() => {}}
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

// ── B/D: ZONE 1 — the context strip ────────────────────────────────────

describe("zone 1 — the context strip is ONE line", () => {
  it("names the period and shows the engine's own verdict wording", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot({ trustBand: "reconciled" }))}
        trustLabel="Reconciled"
        suggestions={[]}
        jumps={[]}
        onJump={() => {}}
        onPick={() => {}}
      />,
    );
    expect(screen.getByTestId("capsule-context-period")).toHaveTextContent("Dec 2025");
    expect(screen.getByTestId("capsule-context-trust")).toHaveTextContent("Reconciled");
  });

  it("says 'Not verified' on a period with no verdict — and wears no badge", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot({ trustBand: null }))}
        trustLabel={null}
        suggestions={[]}
        jumps={[]}
        onJump={() => {}}
        onPick={() => {}}
      />,
    );
    // The verdict SLOT is always there — the strip is one line and its
    // parts do not appear and disappear. What must not appear is a
    // BADGE: a chip on an unverified period claims a check that never
    // ran. The strip renders the words in plain muted text instead.
    expect(screen.getByTestId("capsule-context-trust")).toHaveTextContent("Not verified");
    expect(screen.getByTestId("capsule-status-dot").className).toContain("bg-ink-mute");
  });

  it("with no period loaded, says so and still says search works", () => {
    renderView(
      snapshot({ hasPeriod: false, periodLabel: null, trustBand: null }),
      "pro",
      { onUpload: () => {} },
    );
    const strip = screen.getByTestId("capsule-context-strip");
    expect(strip.textContent).toContain("No period loaded");
    // The strip is an INVITATION, not an error: it offers the fix.
    expect(strip.textContent).toContain("Upload a document");
    expect(strip.dataset.state).toBe("no-period");
  });

  it("is ONE line — the strip's own height class fixes it to a single row", () => {
    renderView(snapshot({ trustBand: "reconciled" }));
    const cls = screen.getByTestId("capsule-context-strip").className;
    // A FIXED height class is the invariant, not the particular value:
    // the strip must not be allowed to become two lines by growing with
    // its content. (h-8/32px since the craft pass; h-7/28px before it.)
    expect(cls).toMatch(/\bh-[78]\b/);
  });

  it("makes 'periods without a file' a DESTINATION, not a statistic", () => {
    const jumped: string[] = [];
    renderView(
      snapshot({
        unattached: [
          { periodId: "p-nov", label: "Nov 2025" },
          { periodId: "p-oct", label: "Oct 2025" },
        ],
      }),
      "pro",
      { onFixUnattached: (id: string) => jumped.push(id) },
    );
    const fix = screen.getByTestId("capsule-open-thing");
    expect(fix.dataset.openKind).toBe("unattached");
    expect(fix.dataset.action).toBe("fix-unattached");
    expect(fix.textContent).toContain("2 periods without a file");
    fireEvent.click(fix);
    expect(jumped).toEqual(["p-nov"]);
  });

  it("renders the count as plain text when the host cannot act on it", () => {
    renderView(snapshot({ unattached: [{ periodId: "p1", label: "Nov 2025" }] }));
    // The ZONE still renders — it is the ACTION that does not, because
    // the host supplied no handler. A dead button is worse than a
    // sentence, and an absent sentence is worse than both.
    const open = screen.getByTestId("capsule-open-thing");
    expect(open.getAttribute("data-action")).toBeNull();
    expect(open.tagName).toBe("SPAN");
    expect(screen.getByTestId("capsule-context-strip").textContent).toContain(
      "1 period without a file",
    );
  });

  it("never claims 'no period loaded' about a period it simply cannot name", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot({ periodLabel: "1.553.210", trustBand: "reconciled" }))}
        trustLabel="Reconciled"
        suggestions={[]}
        jumps={[]}
        onJump={() => {}}
        onPick={() => {}}
      />,
    );
    const zone = screen.getByTestId("capsule-context-strip");
    expect(zone.textContent).not.toContain("No period loaded");
    // The figure-shaped label is REFUSED (S1) — it never reaches the
    // slot — and the slot then says what is true rather than going
    // silent: the period is loaded, it simply has no usable name.
    expect(zone.textContent).not.toContain("1.553.210");
    expect(screen.getByTestId("capsule-context-period")).toHaveTextContent(
      "Period not dated",
    );
    expect(screen.getByTestId("capsule-context-trust")).toHaveTextContent("Reconciled");
  });

  it("falls back to the band's own word when the presenter sent none", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot({ trustBand: "material_imbalance" }))}
        trustLabel={null}
        suggestions={[]}
        jumps={[]}
        onJump={() => {}}
        onPick={() => {}}
      />,
    );
    expect(screen.getByTestId("capsule-context-trust")).toHaveTextContent("Material imbalance");
  });
});

// ── D: computed suggestions, never boilerplate ─────────────────────────

describe("zone 2 — suggestions are computed from this workspace", () => {
  const busy = snapshot({
    findings: [{ key: "f1", severity: "critical", subject: "Receivables provision" }],
    trustBand: "reconciled",
    metrics: [{ name: "dscr", value: 1.2, unit: "ratio" }],
    unattached: [{ periodId: "p1", label: "Nov 2025" }],
  });

  // ── WHERE THE BASIS LIVES AFTER THE CRAFT PASS ──────────────────────
  //
  // The chips are pills now, and a pill the width of a paragraph is not
  // a pill. So the basis is stated in TWO places instead of one, and
  // both are asserted here — the pair is strictly more than the single
  // muted span the old row carried:
  //
  //   · per chip, in `aria-label`, so a screen-reader user hears the
  //     question and its source as one utterance;
  //   · once visibly, deduplicated, under the group.
  //
  // Weakening either half would let the covenant disclaimer fall off the
  // screen, which is the thing these two tests exist to prevent.

  it("renders three, and each chip names its basis in its accessible name", () => {
    renderView(busy);
    const chips = screen.getAllByTestId("capsule-suggestion");
    expect(chips).toHaveLength(3);
    expect(chips[0]).toHaveTextContent("Receivables provision");
    expect(chips[0].getAttribute("aria-label")).toContain("Anomaly Radar");
  });

  it("states every distinct basis VISIBLY, once, under the group", () => {
    renderView(busy);
    const line = screen.getByTestId("capsule-suggestion-basis").textContent ?? "";
    expect(line).toContain("Anomaly Radar");
    // Deduplicated: one source stated once, however many chips drew on it.
    expect(line.match(/Anomaly Radar/g)).toHaveLength(1);
  });

  it("the covenant chip admits its test is a default, not the user's facility", () => {
    renderView(snapshot({ metrics: [{ name: "dscr", value: 1.2, unit: "ratio" }] }));
    const chip = screen.getByTestId("capsule-suggestion");
    // Both halves, on the one chip that carries a disclaimer that matters.
    expect(chip.getAttribute("aria-label")).toContain("not your loan documents");
    expect(screen.getByTestId("capsule-suggestion-basis").textContent).toContain(
      "not your loan documents",
    );
  });

  it("carries NO native tooltip — `title` duplicates text already on screen", () => {
    renderView(busy);
    for (const chip of screen.getAllByTestId("capsule-suggestion")) {
      expect(
        chip.getAttribute("title"),
        "a `title` renders an OS-drawn tooltip restating the chip's own text — " +
          "one of the seven craft complaints, and it comes back the moment " +
          "someone adds `title` back for 'accessibility'. aria-label is the " +
          "accessible name; title is a second, worse one.",
      ).toBeNull();
    }
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

// ── B: ZONE 3, and the sections that are GONE ──────────────────────────

describe("zone 3 — jump", () => {
  const jumps = [
    { id: "page-/dashboard", label: "Dashboard", hint: "Overview" },
    { id: "page-/workspace", label: "Workspaces", hint: "Overview" },
    { id: "page-/products", label: "Products", hint: "Analyze" },
    { id: "page-/settings", label: "Settings" },
    { id: "page-/benchmark", label: "Benchmark", hint: "Analyze" },
  ];

  it("does NOT render at rest — the resting surface is context + chips only", () => {
    // The craft pass deleted the resting jump zone. The live host passes
    // no destinations at all; this asserts the DEFAULT, so a caller that
    // forgets the prop cannot silently bring the zone back.
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot())}
        trustLabel={null}
        suggestions={[]}
        onPick={() => {}}
      />,
    );
    expect(screen.queryByTestId("capsule-jump")).toBeNull();
  });

  it("prints NO category label on a destination row", () => {
    // "Dashboard … Overview" / "Scenarios … Analyze". The rail group
    // restated a place the reader recognised by name and gave every row
    // a second focal point at the far end of the line.
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot())}
        trustLabel={null}
        suggestions={[]}
        jumps={jumps}
        onJump={() => {}}
        onPick={() => {}}
      />,
    );
    const text = screen.getByTestId("capsule-jump").textContent ?? "";
    expect(text).toContain("Dashboard");
    expect(text).not.toContain("Overview");
    expect(text).not.toContain("Analyze");
  });

  it("rows are 36px — denser than the 40px they were", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot())}
        trustLabel={null}
        suggestions={[]}
        jumps={jumps}
        onJump={() => {}}
        onPick={() => {}}
      />,
    );
    for (const row of screen.getAllByTestId("capsule-jump-row")) {
      expect(row.className).toContain("h-9");
    }
  });

  it("shows FOUR destinations under one label, never five", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot())}
        trustLabel={null}
        suggestions={[]}
        jumps={jumps}
        onJump={() => {}}
        onPick={() => {}}
      />,
    );
    expect(screen.getAllByTestId("capsule-jump-row")).toHaveLength(MAX_JUMPS);
    expect(screen.getByTestId("capsule-jump").textContent).toContain("Jump to…");
  });

  it("renders nothing at all when the host offers no destinations", () => {
    renderView(snapshot());
    expect(screen.queryByTestId("capsule-jump")).toBeNull();
  });

  it("hands the item back rather than navigating itself", () => {
    const taken: string[] = [];
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snapshot())}
        trustLabel={null}
        suggestions={[]}
        jumps={jumps}
        onJump={(item) => taken.push(item.id)}
        onPick={() => {}}
      />,
    );
    fireEvent.click(screen.getAllByTestId("capsule-jump-row")[0]);
    expect(taken).toEqual(["page-/dashboard"]);
  });

  it("continues zone 2's flat keyboard order — no discontinuity between them", () => {
    const snap = snapshot({
      findings: [{ key: "f1", severity: "critical", subject: "Receivables provision" }],
      unattached: [{ periodId: "p1", label: "Nov 2025" }],
    });
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(snap)}
        trustLabel={null}
        suggestions={buildCapsuleSuggestions(snap, "pro")}
        jumps={jumps}
        onJump={() => {}}
        onPick={() => {}}
        indexOffset={0}
      />,
    );
    const idx = [
      ...screen.getAllByTestId("capsule-suggestion"),
      ...screen.getAllByTestId("capsule-jump-row"),
    ].map((el) => Number(el.dataset.idx));
    // 0,1,…,n with no gap and no repeat: ArrowDown walks one list.
    expect(idx).toEqual(idx.map((_, i) => i));
  });
});

describe("B — the 18-row firehose is gone", () => {
  const busy = snapshot({
    findings: [{ key: "f1", severity: "critical", subject: "Receivables provision" }],
    trustBand: "reconciled",
    metrics: [{ name: "dscr", value: 1.2, unit: "ratio" }],
    unattached: [{ periodId: "p1", label: "Nov 2025" }],
  });

  it("shows THREE ZONES and no fourth", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(busy)}
        trustLabel="Reconciled"
        suggestions={buildCapsuleSuggestions(busy, "pro")}
        jumps={[
          { id: "page-/dashboard", label: "Dashboard" },
          { id: "page-/workspace", label: "Workspaces" },
        ]}
        onJump={() => {}}
        onPick={() => {}}
      />,
    );
    expect(screen.getByTestId("capsule-context-strip")).toBeInTheDocument();
    expect(screen.getByTestId("capsule-suggestions")).toBeInTheDocument();
    expect(screen.getByTestId("capsule-jump")).toBeInTheDocument();
    // The two sections that used to sit between them.
    expect(screen.queryByTestId("capsule-recents")).toBeNull();
    expect(screen.queryByTestId("capsule-context-zone")).toBeNull();
  });

  it("the worst case is a HANDFUL of rows, not eighteen", () => {
    render(
      <CapsuleEmptyStateView
        context={buildCapsuleContext(busy)}
        trustLabel="Reconciled"
        suggestions={buildCapsuleSuggestions(busy, "pro")}
        jumps={[
          { id: "a", label: "Dashboard" },
          { id: "b", label: "Workspaces" },
          { id: "c", label: "Products" },
          { id: "d", label: "Settings" },
          { id: "e", label: "Benchmark" },
        ]}
        onJump={() => {}}
        onPick={() => {}}
      />,
    );
    // Three asks + four jumps is the ceiling this IA allows, and it is
    // the number the surface must not be able to exceed no matter how
    // much the workspace has to say.
    const rows = screen.getAllByRole("option");
    expect(rows.length).toBeLessThanOrEqual(3 + MAX_JUMPS);
  });

  it("recents are reachable, not displayed — the row component left the contract", async () => {
    // The recall STORE survives (⌘K → ArrowUp reads it) and must keep
    // working; the visible SECTION does not exist any more. The barrel
    // IS the contract, so asserting on the barrel is what stops the row
    // quietly coming back through a different import.
    const barrel = await import("../index");
    expect(barrel).not.toHaveProperty("CapsuleRecentQuestions");
    expect(barrel).not.toHaveProperty("RECENT_PILLS");
    expect(barrel).not.toHaveProperty("CapsuleContextZone");
    // …while the recall path the section was replaced BY is still here.
    expect(typeof barrel.useCapsuleRecall).toBe("function");
    expect(typeof barrel.rememberCapsuleQuestion).toBe("function");
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
    for (const direction of ["up", "down"]) {
      generatedKeys.push(`suggest.move.${direction}.${mode}`);
    }
    for (const variant of ["imbalance", "drift", "reconciled"]) {
      generatedKeys.push(`suggest.trust.${variant}.${mode}`);
    }
    for (const test of CAPSULE_COVENANT_TESTS) {
      generatedKeys.push(`suggest.covenant.${test.id}.${mode}`);
    }
  }
  for (const kind of ["unattached", "finding", "move", "trust", "covenant", "silence"]) {
    generatedKeys.push(`basis.${kind}`);
  }

  it.each(["en", "ro"] as const)("%s answers every generated key", (lang) => {
    const bag = (strings as Record<string, { capsuleEmpty: unknown }>)[lang].capsuleEmpty;
    const missing = generatedKeys.filter((k) => typeof dig(bag, k) !== "string");
    expect(missing, `missing in ${lang}: ${missing.join(", ")}`).toEqual([]);
  });

  // A LANGUAGE WITH MORE PLURAL FORMS IS NOT A MISSING TRANSLATION.
  //
  // English has two CLDR plural categories (one / other); Romanian has
  // three (one / few / other — "2 perioade" but "20 DE perioade"). A
  // byte-identical key-shape comparison therefore FAILS on a correctly
  // translated Romanian plural, which is exactly backwards: it would
  // push a translator to delete the `_few` form and ship wrong grammar
  // for every count from 2 to 19.
  //
  // So the shapes are compared MODULO the CLDR suffix, and the plural
  // FAMILIES are then asserted separately, each against the forms its
  // own language actually requires.
  const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];
  const stripPlural = (key: string): string => {
    for (const suffix of PLURAL_SUFFIXES) {
      if (key.endsWith(suffix)) return key.slice(0, -suffix.length);
    }
    return key;
  };
  const shape = (node: unknown, prefix = ""): string[] => {
    if (typeof node === "string") return [prefix];
    if (!node || typeof node !== "object") return [];
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      shape(v, prefix ? `${prefix}.${k}` : k),
    );
  };
  const families = (node: unknown): string[] =>
    [...new Set(shape(node).map(stripPlural))].sort();

  it("the two bundles have identical key shapes, modulo plural form", () => {
    expect(families(strings.ro.capsuleEmpty)).toEqual(families(strings.en.capsuleEmpty));
  });

  it("every plural family carries the forms ITS language requires", () => {
    // The families that are plural at all — detected from EN, which is
    // where a plural is introduced.
    const enKeys = shape(strings.en.capsuleEmpty);
    const pluralFamilies = [
      ...new Set(enKeys.filter((k) => k !== stripPlural(k)).map(stripPlural)),
    ].sort();
    expect(pluralFamilies.length, "no plural families found — the test is inert").toBeGreaterThan(0);

    const formsFor = (bag: unknown, family: string): string[] =>
      shape(bag)
        .filter((k) => stripPlural(k) === family && k !== family)
        .map((k) => k.slice(family.length))
        .sort();

    for (const family of pluralFamilies) {
      expect(formsFor(strings.en.capsuleEmpty, family), `en ${family}`).toEqual([
        "_one",
        "_other",
      ]);
      // Romanian: one (1), few (2-19), other (20+, the "de" form).
      expect(formsFor(strings.ro.capsuleEmpty, family), `ro ${family}`).toEqual([
        "_few",
        "_one",
        "_other",
      ]);
    }
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
