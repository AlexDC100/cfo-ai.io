// Hermeticity self-test — the suite refuses to run against a developer's
// machine configuration.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────
// `npx vitest run` was green here and red everywhere else, for five weeks,
// because a gitignored `.env` supplied a real VITE_SUPABASE_URL and three
// money-boundary tests were quietly reaching a live seam through it. The
// failure mode is the dangerous one: the leak makes the suite MORE green,
// so nothing complains on the machine that has it, and the red lands on
// whoever clones next.
//
// frontend/test/envPin.ts closes that by pinning the whole VITE_ census
// before any module loads. This file is the part that makes a REGRESSION
// loud. Delete the pin, break its import order, or add a variable to the
// product without recording it, and the suite says so by name here —
// instead of going green on one machine and red on the next.
//
// It asserts ONE THING PER VARIABLE, not one aggregate "env is clean".
// The defect was a single variable out of fourteen; a count would have
// needed only that one to be forgotten to read green.
//
// The other half of the guard is scripts/check_hermetic.mjs, which this
// file cannot replace: an in-suite test can only see the environment it is
// already running in, so it cannot tell "the harness pinned this" from
// "the developer's .env happened to hold the same value". The gate runs the
// suite in two environments and compares. Both are needed.

import { describe, it, expect } from "vitest";
import manifest from "./hermeticEnv.json";

const HERMETIC_ENV = manifest.env as Record<string, string | null>;
const env = import.meta.env as unknown as Record<string, string | undefined>;

describe("hermeticity — build-time env comes from the harness, not the machine", () => {
  const entries = Object.entries(HERMETIC_ENV);

  // The discovery loop. Assertions about the loop itself come AFTER it
  // (TC-3): a check written inside cannot fire when the manifest is empty,
  // which is the one state it exists to catch.
  for (const [name, expected] of entries) {
    if (expected === null) {
      it(`${name} is absent`, () => {
        expect(
          env[name],
          `${name} resolved to a value. Nothing in the harness sets it, so it ` +
            `arrived from an untracked dotenv file on this machine. Either pin ` +
            `it in frontend/test/hermeticEnv.json or remove it from your .env.`,
        ).toBeUndefined();
      });
    } else {
      it(`${name} is pinned to the recorded value`, () => {
        expect(
          env[name],
          `${name} is not the value frontend/test/hermeticEnv.json records. ` +
            `Either envPin.ts stopped running before the modules under test, ` +
            `or something overwrote it mid-run.`,
        ).toBe(expected);
      });
    }
  }

  it("the manifest is not empty", () => {
    // A manifest that lost its entries would turn every assertion above into
    // zero assertions, and this file would report green having checked
    // nothing. Floor measured at 14 VITE_ variables read by frontend/**.
    expect(entries.length).toBeGreaterThanOrEqual(12);
  });

  it("the manifest names the variable the incident was about", () => {
    // Canary, asserted after the loop. Chosen because VITE_SUPABASE_URL is
    // the exact variable that made G7.a / K10.a / K10.f pass on one machine.
    expect(Object.keys(HERMETIC_ENV)).toContain("VITE_SUPABASE_URL");
    expect(HERMETIC_ENV.VITE_SUPABASE_URL).toBe("https://test.supabase.co");
  });

  it("no VITE_ variable reaches the run that the manifest does not name", () => {
    // The live half. Everything above checks variables we already know
    // about; this catches the NEXT one — a key added to someone's .env or
    // .env.local that no test file, and no reviewer, ever hears about.
    const unrecorded = Object.keys(env)
      .filter((k) => k.startsWith("VITE_"))
      .filter((k) => !(k in HERMETIC_ENV))
      .sort();
    expect(
      unrecorded,
      `These VITE_ variables reached the test run from outside the harness ` +
        `(a gitignored .env / .env.local, or the ambient shell). Record each ` +
        `one in frontend/test/hermeticEnv.json — with a pinned value if the ` +
        `product reads it, or null if it must be absent.`,
    ).toEqual([]);
  });
});
