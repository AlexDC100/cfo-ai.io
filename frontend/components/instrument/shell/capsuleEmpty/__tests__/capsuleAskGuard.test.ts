/**
 * THE CAPSULE — ask budget gate (Part F.5).
 *
 * The behavioural half is ordinary: a cooldown, a rolling burst cap, a
 * release path for a call that never left.
 *
 * The half that matters is the LAST describe block. "Never silently
 * downgrade the model for a judgment answer" is the kind of rule that
 * survives review and dies six months later when someone adds a cheap
 * fallback "just for throttled asks". So it is enforced structurally:
 * the decision union has no arm that could carry a model, and this gate
 * reads the guard's own source and fails if a model identifier ever
 * appears in its CODE. Comments may (and do) discuss the rule.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASK_BURST_LIMIT,
  ASK_MIN_GAP_MS,
  ASK_WINDOW_MS,
  checkCapsuleAsk,
  releaseCapsuleAsk,
  reserveCapsuleAsk,
  resetCapsuleAskGuard,
} from "../capsuleAskGuard";

const USER = "user-1";

beforeEach(() => resetCapsuleAskGuard());
afterEach(() => {
  resetCapsuleAskGuard();
  vi.useRealTimers();
});

describe("cooldown — the double-fire", () => {
  it("allows the first ask", () => {
    expect(reserveCapsuleAsk(USER, 1_000)).toEqual({ allowed: true });
  });

  it("refuses a second ask inside the minimum gap, and says when", () => {
    reserveCapsuleAsk(USER, 1_000);
    const d = checkCapsuleAsk(USER, 1_100);
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.reason).toBe("cooldown");
    expect(d.retryAt).toBe(1_000 + ASK_MIN_GAP_MS);
  });

  it("allows again once the gap has passed", () => {
    reserveCapsuleAsk(USER, 1_000);
    expect(checkCapsuleAsk(USER, 1_000 + ASK_MIN_GAP_MS).allowed).toBe(true);
  });

  it("a refused ask does NOT push its own retry time further away", () => {
    reserveCapsuleAsk(USER, 1_000);
    reserveCapsuleAsk(USER, 1_100); // refused
    reserveCapsuleAsk(USER, 1_200); // refused
    const d = checkCapsuleAsk(USER, 1_300);
    if (d.allowed) throw new Error("expected a block");
    expect(d.retryAt).toBe(1_000 + ASK_MIN_GAP_MS);
  });
});

describe("burst — the rolling window", () => {
  /** Fill the window without ever tripping the cooldown. */
  function fill(count: number, start = 0): number {
    let now = start;
    for (let i = 0; i < count; i += 1) {
      expect(reserveCapsuleAsk(USER, now).allowed, `ask ${i} at ${now}`).toBe(true);
      now += ASK_MIN_GAP_MS + 10;
    }
    return now;
  }

  it("allows exactly the limit inside one window", () => {
    const now = fill(ASK_BURST_LIMIT);
    const d = checkCapsuleAsk(USER, now);
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.reason).toBe("burst");
  });

  it("frees a slot when the OLDEST ask ages out of the window", () => {
    fill(ASK_BURST_LIMIT);
    // Just before the first ask (t=0) leaves the window.
    expect(checkCapsuleAsk(USER, ASK_WINDOW_MS - 1).allowed).toBe(false);
    expect(checkCapsuleAsk(USER, ASK_WINDOW_MS + 1).allowed).toBe(true);
  });

  it("the block names the moment the window frees, not an arbitrary delay", () => {
    fill(ASK_BURST_LIMIT);
    const d = checkCapsuleAsk(USER, ASK_MIN_GAP_MS * ASK_BURST_LIMIT + 1_000);
    if (d.allowed) throw new Error("expected a block");
    expect(d.retryAt).toBe(0 + ASK_WINDOW_MS);
  });
});

describe("per user, not per surface", () => {
  it("one user's burst never throttles another", () => {
    for (let i = 0; i < ASK_BURST_LIMIT; i += 1) {
      reserveCapsuleAsk("a", i * (ASK_MIN_GAP_MS + 10));
    }
    const now = ASK_BURST_LIMIT * (ASK_MIN_GAP_MS + 10);
    expect(checkCapsuleAsk("a", now).allowed).toBe(false);
    expect(checkCapsuleAsk("b", now).allowed).toBe(true);
  });

  it("a missing user key falls into one shared anonymous bucket", () => {
    reserveCapsuleAsk(null, 1_000);
    expect(checkCapsuleAsk(undefined, 1_100).allowed).toBe(false);
  });
});

describe("release — an ask that never left costs nothing", () => {
  it("hands the slot back", () => {
    reserveCapsuleAsk(USER, 1_000);
    expect(checkCapsuleAsk(USER, 1_100).allowed).toBe(false);
    releaseCapsuleAsk(USER);
    expect(checkCapsuleAsk(USER, 1_100).allowed).toBe(true);
  });

  it("is a no-op with nothing to release", () => {
    expect(() => releaseCapsuleAsk(USER)).not.toThrow();
    expect(checkCapsuleAsk(USER, 1_000).allowed).toBe(true);
  });
});

describe("checkCapsuleAsk records nothing", () => {
  it("is safe to call on every render", () => {
    for (let i = 0; i < 50; i += 1) checkCapsuleAsk(USER, 1_000 + i);
    expect(reserveCapsuleAsk(USER, 2_000).allowed).toBe(true);
  });
});

// ── the structural half ────────────────────────────────────────────────

describe("NEVER silently downgrade the model", () => {
  // Repo-root relative: `import.meta.url` is an http URL under the jsdom
  // environment, so it cannot be resolved to a file path here.
  const source = readFileSync(
    resolve(process.cwd(), "frontend/components/instrument/shell/capsuleEmpty/capsuleAskGuard.ts"),
    "utf8",
  );

  /** Source with comments removed — the rule is discussed in prose and
   *  must be absent from code. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

  it("names no model, tier, or token budget anywhere in its code", () => {
    const banned = /\bclaude|haiku|sonnet|opus|gpt-|\bmodel\b|max_tokens|fallback_model/i;
    const offenders = code
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((r) => banned.test(r.line));
    expect(offenders, JSON.stringify(offenders)).toEqual([]);
  });

  it("the decision union has exactly two shapes, and the refusal carries no payload", () => {
    resetCapsuleAskGuard();
    const allow = reserveCapsuleAsk(USER, 1_000);
    expect(Object.keys(allow).sort()).toEqual(["allowed"]);

    const deny = checkCapsuleAsk(USER, 1_100);
    expect(Object.keys(deny).sort()).toEqual(["allowed", "reason", "retryAt"]);
    if (deny.allowed) throw new Error("unreachable");
    // A "reason" is a word from a closed set, never a wire message.
    expect(["cooldown", "burst"]).toContain(deny.reason);
  });

  it("a refusal is a delay, never a different answer — retryAt is always in the future", () => {
    resetCapsuleAskGuard();
    reserveCapsuleAsk(USER, 5_000);
    const d = checkCapsuleAsk(USER, 5_100);
    if (d.allowed) throw new Error("expected a block");
    expect(d.retryAt).toBeGreaterThan(5_100);
  });
});
