#!/usr/bin/env tsx
/**
 * i18n coverage gate — verifies all locales have the same key set.
 *
 * Fails CI on any of:
 *   · Key in en.json missing from ro.json or fr.json (English-only leak)
 *   · Key in ro.json or fr.json with no en.json counterpart (orphan)
 *   · Empty string values (translator forgot to fill in)
 *   · Placeholder mismatches ({{name}} in en but not in ro for same key)
 *
 * Run locally:
 *   npx tsx scripts/check-i18n-coverage.ts
 * Run in CI:
 *   add `npx tsx scripts/check-i18n-coverage.ts` to the lint job
 */
import en from "../src/i18n/locales/en.json" assert { type: "json" };
import ro from "../src/i18n/locales/ro.json" assert { type: "json" };
import fr from "../src/i18n/locales/fr.json" assert { type: "json" };

type Tree = Record<string, unknown>;

function flatten(obj: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [sk, sv] of flatten(v as Tree, path)) out.set(sk, sv);
    } else if (typeof v === "string") {
      out.set(path, v);
    }
  }
  return out;
}

/** Extract i18next interpolation placeholders like {{name}} from a string. */
function placeholders(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) {
    out.add(m[1]);
  }
  return out;
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

const enFlat = flatten(en as Tree);
const roFlat = flatten(ro as Tree);
const frFlat = flatten(fr as Tree);

const enKeys = new Set(enFlat.keys());
const roKeys = new Set(roFlat.keys());
const frKeys = new Set(frFlat.keys());

const missingInRo = [...enKeys].filter((k) => !roKeys.has(k));
const missingInFr = [...enKeys].filter((k) => !frKeys.has(k));
const extraInRo = [...roKeys].filter((k) => !enKeys.has(k));
const extraInFr = [...frKeys].filter((k) => !enKeys.has(k));

// Empty values — translator forgot to fill in.
const emptyEn = [...enFlat.entries()].filter(([, v]) => v.trim() === "");
const emptyRo = [...roFlat.entries()].filter(([, v]) => v.trim() === "");
const emptyFr = [...frFlat.entries()].filter(([, v]) => v.trim() === "");

// Placeholder mismatches — common bug: en has {{count}}, ro forgets it,
// so the count shows as "{{count}}" literal text to RO users.
const placeholderMismatch: string[] = [];
for (const [k, v] of enFlat) {
  const enP = placeholders(v);
  if (enP.size === 0) continue;
  const roV = roFlat.get(k);
  if (roV !== undefined && !setEq(enP, placeholders(roV))) {
    placeholderMismatch.push(`ro: ${k}  (en: ${[...enP].join(",")} vs ro: ${[...placeholders(roV)].join(",") || "—"})`);
  }
  const frV = frFlat.get(k);
  if (frV !== undefined && !setEq(enP, placeholders(frV))) {
    placeholderMismatch.push(`fr: ${k}  (en: ${[...enP].join(",")} vs fr: ${[...placeholders(frV)].join(",") || "—"})`);
  }
}

let failed = false;
const log = (label: string, items: string[] | [string, string][]) => {
  if (!items.length) return;
  failed = true;
  console.error(`\n[i18n] ${label} (${items.length}):`);
  for (const item of items.slice(0, 30)) {
    console.error("  -", Array.isArray(item) ? item[0] : item);
  }
  if (items.length > 30) console.error(`  …and ${items.length - 30} more`);
};

log("Missing in RO", missingInRo);
log("Missing in FR", missingInFr);
log("Extra in RO (no EN counterpart)", extraInRo);
log("Extra in FR (no EN counterpart)", extraInFr);
log("Empty values in EN", emptyEn);
log("Empty values in RO", emptyRo);
log("Empty values in FR", emptyFr);
log("Placeholder mismatches", placeholderMismatch);

if (failed) {
  console.error(
    `\ni18n coverage FAILED. EN=${enKeys.size}, RO=${roKeys.size}, FR=${frKeys.size}.`,
  );
  process.exit(1);
}

console.log(
  `i18n coverage OK. ${enKeys.size} keys × 3 locales, no gaps, no orphans, no empty values, placeholders aligned.`,
);
