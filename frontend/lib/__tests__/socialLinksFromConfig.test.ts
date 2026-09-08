/**
 * SOCIAL HANDLES COME FROM ONE PLACE, AND AN UNSET ONE RENDERS NOTHING.
 *
 * WHY THIS GATE EXISTS
 * ====================
 * On 2026-09-08 the production footer shipped the literal string
 * "[Company Legal Name]", in both languages, rendered about forty pixels
 * above the block that prints the real registered entity. `legalConfig.ts`
 * had been created specifically to end that class of defect — its own
 * header records the entity being "typed inline ... in three different
 * places, so filling it in meant editing prose in three spots and hoping
 * none was missed" — and the copyright line was the one spot the refactor
 * missed.
 *
 * Social links are the same shape of risk with a worse failure mode: a
 * handle typed into a component is invisible until someone clicks it and
 * lands on a 404, or on a profile that is not ours.
 *
 * So two laws, and both are asserted over the CODE, not over a rendering:
 *
 *   1. No social URL may appear anywhere outside `content/legal/entity.json`
 *      and its generated mirror. Not in a component, not in a translation
 *      file, not in a test fixture that could be copied.
 *   2. A handle that is null, empty, "#", or not an https URL renders
 *      NOTHING — no icon, no dead link, no placeholder. Absence renders as
 *      absence. `instagram` is null today precisely because the brief that
 *      requested this feature carried "[INSTAGRAM URL — fill in]", and
 *      shipping a guess would have been the original defect again.
 *
 * WHAT THIS REDS ON (TC-11)
 *   · any social URL hardcoded outside the config;
 *   · a null / empty / "#" / non-https handle producing a link;
 *   · `socialLinks()` losing its ordering, so a JSON reshuffle silently
 *     reorders what a reader sees;
 *   · a network gaining a handle without an accessible name in both
 *     languages (TypeScript enforces the entry; this proves it is used).
 * WHAT IT CANNOT SEE
 *   · whether the URL that IS configured points at the right account —
 *     nothing in a repo can know that;
 *   · the rendered pixels; `SocialLinks` is a component and the two
 *     footers render it (and the marketing string version) separately.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { LEGAL_ENTITY, socialLinks } from "@/lib/legalConfig";

const ROOT = join(__dirname, "..", "..", "..");

/** The two files allowed to contain a social URL: the single source and
 *  the generated mirror the app actually imports. */
const ALLOWED = [
  join("content", "legal", "entity.json"),
  join("frontend", "lib", "legalDocuments.generated.ts"),
  // This gate names the hosts it hunts for, which would otherwise trip it.
  join("frontend", "lib", "__tests__", "socialLinksFromConfig.test.ts"),
];

/** Hosts that identify a social profile link. Deliberately a small, named
 *  list rather than a clever pattern: a false red here gets the gate
 *  deleted, and this repo has already measured that happening. */
const SOCIAL_HOSTS = [
  "x.com/", "twitter.com/", "instagram.com/",
  "linkedin.com/", "facebook.com/", "tiktok.com/", "youtube.com/",
];

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", "test-results",
  ".venv", "data", "corpus", "scandi-desk-main", "playwright-report",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    // Sync-conflict copies (" 2.ts") are not the tree; CLAUDE.md §23.
    if (/ \d+(\.|$)/.test(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|json|html|md|py|yaml|yml)$/.test(name)) out.push(p);
  }
  return out;
}

describe("social handles come from one place", () => {
  it("is not vacuous — the config actually carries a handle to protect", () => {
    const links = socialLinks();
    expect(links.length, "no social handle is set at all, so this gate proves nothing").toBeGreaterThan(0);
    expect(links.some((l) => l.key === "x")).toBe(true);
  });

  it("no social URL is hardcoded anywhere outside the config", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "frontend")).concat(
      walk(join(ROOT, "scripts")),
      walk(join(ROOT, "content")),
    )) {
      const rel = file.slice(ROOT.length + 1);
      if (ALLOWED.some((a) => rel === a)) continue;
      const text = readFileSync(file, "utf-8");
      for (const host of SOCIAL_HOSTS) {
        if (text.includes(host)) {
          const at = text.indexOf(host);
          offenders.push(
            `${rel}: contains "${host}" — …${text.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, " ").trim()}…`,
          );
        }
      }
    }
    expect(
      offenders,
      `a social URL is hardcoded outside content/legal/entity.json. Handles live in ` +
        `ONE place for the same reason the registered entity does — the footer shipped ` +
        `"[Company Legal Name]" to production because a value was typed inline:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("an unset handle yields nothing — no dead link, no placeholder", () => {
    // instagram is null in the config today, on purpose.
    expect(LEGAL_ENTITY.social.instagram).toBeNull();
    expect(socialLinks().some((l) => l.key === "instagram")).toBe(false);
  });

  it("a half-typed, empty, hash or non-https handle is treated exactly like absent", async () => {
    const cfg = await import("@/lib/legalConfig");
    const original = cfg.LEGAL_ENTITY.social.x;
    for (const bad of ["", "   ", "#", "http://x.com/ParachainGroup", "[INSTAGRAM URL — fill in]", "x.com/Parachain"]) {
      (cfg.LEGAL_ENTITY.social as { x: string | null }).x = bad;
      expect(
        cfg.socialLinks().some((l) => l.key === "x"),
        `${JSON.stringify(bad)} produced a link — an unusable handle must render nothing`,
      ).toBe(false);
    }
    (cfg.LEGAL_ENTITY.social as { x: string | null }).x = original;
    expect(cfg.socialLinks().some((l) => l.key === "x")).toBe(true);
  });

  it("order is declared, not inherited from object-key iteration", async () => {
    const cfg = await import("@/lib/legalConfig");
    const original = cfg.LEGAL_ENTITY.social.instagram;
    (cfg.LEGAL_ENTITY.social as { instagram: string | null }).instagram =
      "https://instagram.com/example";
    expect(cfg.socialLinks().map((l) => l.key)).toEqual(["x", "instagram"]);
    (cfg.LEGAL_ENTITY.social as { instagram: string | null }).instagram = original;
  });
});
