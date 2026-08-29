// EXPLAIN ANYTHING (Prompt 12, Part D) — lib/explain contract.
//
//   · templateExplanation is DETERMINISTIC — same inputs, same string,
//     EN + RO, and always non-empty (Simple mode must work with AI dead).
//   · getExplanation NEVER throws and never returns an error shape: a
//     dead AI path (thrown OR the Edge Function's 200-with-error
//     sentinel) collapses to the template with `degraded` set.
//   · AI successes cache in localStorage by (promptVersion, panelId,
//     snapshotKey, lang, figures-hash) with a size cap; changed figure
//     values can never hit a stale entry.

import { describe, it, expect, beforeEach, vi } from "vitest";

// This jsdom build exposes localStorage as a bare object with no working
// methods (same as viewModes.test.ts) — install an in-memory Storage,
// which also makes the suite hermetic.
const bag = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() { return bag.size; },
  },
});

// Partial-mock the API client: the REAL CfoApiError class (instanceof
// checks in classifyAiFailure must hold), a controllable chatLlm.
const chatLlmMock = vi.fn();
vi.mock("@/lib/cfoApi", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/cfoApi")>();
  return { ...orig, cfoApi: { ...orig.cfoApi, chatLlm: chatLlmMock } };
});

const { CfoApiError } = await import("@/lib/cfoApi");
const { getExplanation, templateExplanation, explainCacheKey, glossaryIdForMetric } =
  await import("@/lib/explain");
import type { ExplainRequest } from "@/lib/explain";

const REQ: ExplainRequest = {
  panelId: "benchmark-profitability",
  panelKind: "benchmark",
  snapshotKey: "period-1",
  lang: "en",
  title: "Profitability",
  figures: [
    { termId: "ebitda", label: "EBITDA margin", value: "12.4%", compare: "9.8%" },
    { label: "Net margin", value: "6.1%", compare: "4.2%" },
  ],
};

// Fragments of a raw failure payload that must never surface.
const RAW_SENTINEL =
  'Couldn\'t reach Claude: 529 {"type":"error","error":{"type":"overloaded_error"},"request_id":"req_011X"}';

beforeEach(() => {
  chatLlmMock.mockReset();
  localStorage.clear();
});

describe("templateExplanation — the deterministic floor", () => {
  it("is deterministic and carries the on-screen figures verbatim", () => {
    const a = templateExplanation(REQ);
    const b = templateExplanation({ ...REQ, figures: [...REQ.figures] });
    expect(a).toBe(b);
    expect(a).toContain("12.4%");
    expect(a).toContain("9.8%");
    expect(a.length).toBeGreaterThan(40);
  });

  it("renders Romanian for ro locales (tu-form dictionary text included)", () => {
    const ro = templateExplanation({ ...REQ, lang: "ro-RO" });
    expect(ro).toContain("industrie");
    expect(ro).toContain("12.4%");
    // The ebitda glossary plain sentence (RO) rides along.
    expect(ro).toContain("activitatea de zi cu zi");
    expect(ro).not.toContain("typical");
  });

  it("says something useful even with zero figures (gate M4 floor)", () => {
    const empty = templateExplanation({ ...REQ, figures: [] });
    expect(empty.trim().length).toBeGreaterThan(20);
  });

  it("scenario-impact kind renders before → after phrasing", () => {
    const t = templateExplanation({
      ...REQ,
      panelKind: "scenario-impact",
      figures: [{ label: "Net debt / EBITDA", value: "2.1×", compare: "5.9×" }],
    });
    expect(t).toContain("from 2.1× to 5.9×");
    expect(t).toContain("stay untouched");
  });
});

describe("getExplanation — AI path with template collapse", () => {
  it("returns the AI answer and caches it (second call = no network)", async () => {
    chatLlmMock.mockResolvedValue({ answer: "A calm plain-language read.", model: "m", usage: null });
    const first = await getExplanation(REQ);
    expect(first).toEqual({ text: "A calm plain-language read.", source: "ai", degraded: null });
    expect(chatLlmMock).toHaveBeenCalledTimes(1);

    const second = await getExplanation(REQ);
    expect(second.text).toBe("A calm plain-language read.");
    expect(second.source).toBe("ai");
    expect(chatLlmMock).toHaveBeenCalledTimes(1); // cache hit
  });

  it("changed figure values miss the cache (no stale explanations)", async () => {
    chatLlmMock.mockResolvedValue({ answer: "Answer one.", model: null, usage: null });
    await getExplanation(REQ);
    const changed = {
      ...REQ,
      figures: [{ label: "EBITDA margin", value: "3.0%" }],
    };
    expect(explainCacheKey(changed)).not.toBe(explainCacheKey(REQ));
    chatLlmMock.mockResolvedValue({ answer: "Answer two.", model: null, usage: null });
    const res = await getExplanation(changed);
    expect(res.text).toBe("Answer two.");
    expect(chatLlmMock).toHaveBeenCalledTimes(2);
  });

  it("network failure -> template, degraded=network, nothing thrown", async () => {
    chatLlmMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const res = await getExplanation(REQ);
    expect(res.source).toBe("template");
    expect(res.degraded).toBe("network");
    expect(res.text).toBe(templateExplanation(REQ));
  });

  it("HTTP error -> template, degraded=service; 429 -> usage", async () => {
    chatLlmMock.mockRejectedValue(new CfoApiError("boom", 500, { request_id: "req_1" }));
    const service = await getExplanation(REQ);
    expect(service.source).toBe("template");
    expect(service.degraded).toBe("service");

    chatLlmMock.mockRejectedValue(new CfoApiError("cap", 429, {}));
    const usage = await getExplanation(REQ);
    expect(usage.degraded).toBe("usage");
  });

  it("the 200-with-error sentinel collapses to template and NEVER leaks", async () => {
    chatLlmMock.mockResolvedValue({ answer: RAW_SENTINEL, model: null, usage: null });
    const res = await getExplanation(REQ);
    expect(res.source).toBe("template");
    expect(res.degraded).toBe("service");
    expect(res.text).not.toContain("Couldn't reach Claude");
    expect(res.text).not.toContain("request_id");
    expect(res.text).not.toContain("{");
    // And the sentinel must not be cached as a real answer.
    chatLlmMock.mockResolvedValue({ answer: "Real answer.", model: null, usage: null });
    const after = await getExplanation(REQ);
    expect(after.text).toBe("Real answer.");
  });

  it("empty figures short-circuits to template without a network call", async () => {
    const res = await getExplanation({ ...REQ, figures: [] });
    expect(res.source).toBe("template");
    expect(chatLlmMock).not.toHaveBeenCalled();
  });

  it("caps the cache size (oldest entries evicted, storage never grows unbounded)", async () => {
    chatLlmMock.mockResolvedValue({ answer: "cached", model: null, usage: null });
    for (let i = 0; i < 45; i++) {
      await getExplanation({ ...REQ, snapshotKey: `p-${i}` });
    }
    const raw = localStorage.getItem("cfo-explain-cache-v1");
    expect(raw).toBeTruthy();
    expect(Object.keys(JSON.parse(raw!)).length).toBeLessThanOrEqual(40);
  });
});

describe("glossaryIdForMetric", () => {
  it("maps common metric names and returns null for strangers", () => {
    expect(glossaryIdForMetric("ebitda_margin_pct")).toBe("ebitda");
    expect(glossaryIdForMetric("gross_margin_pct")).toBe("gross_margin");
    expect(glossaryIdForMetric("debt_to_equity")).toBe("leverage");
    expect(glossaryIdForMetric("weird_metric_xyz")).toBeNull();
  });
});
