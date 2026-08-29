/**
 * THE INSTRUMENT — gate D8: raw-error zero.
 *
 * Contract: when the AI backend returns a 400-class error, the string
 * shown to the user must never contain the raw payload — no braces, no
 * request_id, no provider error-type slugs. The chat lane owns the
 * mapper (frontend/lib/aiDegraded); this test drives a realistic raw
 * body through every exported function and asserts nothing leaks.
 *
 * ─────────────────────────────────────────────────────────────────────
 * LOUD NOTE (2026-08-29, gates lane): frontend/lib/aiDegraded does NOT
 * exist yet — the chat lane had not landed it when this gate was
 * written. The suite below is skipIf(module missing), so today it
 * SKIPS and reports; the moment the chat lane ships the module this
 * gate arms itself on the next `npx vitest run`. If the module lands
 * with an API these generic probes cannot drive, the test FAILS with
 * instructions to bind it to the real signature — a loud failure is
 * the point; silent passes are not.
 * ─────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect } from "vitest";

// A realistic Anthropic-style 400 body: braces, request_id, error slug.
const RAW_400_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "max_tokens: field required for this model",
  },
  request_id: "req_011CTHagbPFpjPQ2VYbAdi8n",
});

// Fragments that must NEVER surface to a user.
const FORBIDDEN = ["{", "}", "request_id", "req_011", "invalid_request_error"];

// Dynamic import so a missing module skips instead of exploding the
// whole vitest run at transform time.
const aiDegraded: Record<string, unknown> | null = await import("@/lib/aiDegraded")
  .catch(() => null);

describe.skipIf(!aiDegraded)("D8 raw-error zero — aiDegraded mapper", () => {
  it("maps an AI 400 to copy with no raw payload leakage", () => {
    const fns = Object.entries(aiDegraded!).filter(
      (e): e is [string, (...a: unknown[]) => unknown] => typeof e[1] === "function",
    );
    expect(fns.length, "aiDegraded exports no functions to gate").toBeGreaterThan(0);

    // Error shapes a mapper plausibly accepts; we drive each exported
    // function with each and collect every string that comes back.
    const inputs: unknown[] = [
      new Error(RAW_400_BODY),
      RAW_400_BODY,
      { status: 400, body: RAW_400_BODY },
      { status: 400, message: RAW_400_BODY },
      JSON.parse(RAW_400_BODY),
    ];

    const produced: Array<{ fn: string; out: string }> = [];
    for (const [name, fn] of fns) {
      for (const input of inputs) {
        try {
          const out: unknown = fn(input);
          if (typeof out === "string" && out.length > 0) {
            produced.push({ fn: name, out });
          } else if (out && typeof out === "object") {
            // Mappers that return a structured message ({ title, detail }).
            for (const v of Object.values(out as Record<string, unknown>)) {
              if (typeof v === "string" && v.length > 0) produced.push({ fn: name, out: v });
            }
          }
        } catch {
          // A signature this probe can't drive — fine, another will.
        }
      }
    }

    // If the module exists but none of its exports produced a message
    // from a raw 400, this gate cannot see the user-facing string —
    // fail loudly so the gate gets bound to the real API instead of
    // silently passing forever.
    expect(
      produced.length,
      "aiDegraded exists but no export produced a message from a raw 400 — " +
        "bind designGateRawError.test.ts to the module's real signature",
    ).toBeGreaterThan(0);

    for (const { fn, out } of produced) {
      for (const frag of FORBIDDEN) {
        expect(
          out.includes(frag),
          `aiDegraded.${fn}() leaked "${frag}" into user copy: "${out.slice(0, 120)}"`,
        ).toBe(false);
      }
    }
  });
});

// Always-on tripwire so the suite is never invisibly green: when the
// module is missing, this records the gap in the run output.
describe.skipIf(!!aiDegraded)("D8 raw-error zero — module gap", () => {
  it("reports that frontend/lib/aiDegraded has not landed yet", () => {
    console.warn(
      "[design-gate D8] frontend/lib/aiDegraded missing — raw-error gate is DORMANT. " +
        "It arms automatically once the chat lane lands the module.",
    );
    expect(aiDegraded).toBeNull();
  });
});
