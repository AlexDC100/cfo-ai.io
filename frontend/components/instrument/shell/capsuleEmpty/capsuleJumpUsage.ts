// THE CAPSULE — which four destinations the JUMP zone shows.
//
// "Most-used" has to mean measured, or it means "the order someone typed
// the rail in". This module measures.
//
// ── What is counted, and what is not ──────────────────────────────────
//
// Only jumps taken FROM THE CAPSULE. Not rail clicks, not deep links,
// not back-button navigations. The zone answers "what do you reach for
// when you open this surface", and a rail click is evidence about the
// rail, not about here. It is also the only signal this lane can collect
// without instrumenting a file it does not own.
//
// ── Storage ───────────────────────────────────────────────────────────
//
// Per-org localStorage, same key discipline as `capsuleRecents`: switching
// workspace must not carry one company's habits into another's surface.
// A read failure (private mode, blocked storage, corrupt JSON) yields an
// empty ranking, which falls back to the rail's own order — the zone
// still renders, it is simply not yet personalised.
//
// ── Decay ─────────────────────────────────────────────────────────────
//
// Counts halve when the total passes `DECAY_AT`. Without it the first
// week of use pins the list permanently: a destination visited forty
// times in January outranks one visited eight times a day in March. The
// halving is integer, so a long-unused entry eventually reaches zero and
// drops out on the next write.
//
// No clock is read for ordering — only for nothing at all, in fact. The
// ranking is a pure function of the counts, so the same store always
// yields the same four rows.

const KEY_PREFIX = "cfo-capsule-jumps-v1";

/** Counts halve once the store's total reaches this. */
export const DECAY_AT = 200;

/** Beyond this many distinct destinations the tail is noise. */
export const MAX_TRACKED = 24;

export type JumpCounts = Record<string, number>;

function keyFor(orgKey: string): string {
  return `${KEY_PREFIX}:${orgKey || "anon"}`;
}

export function readJumpCounts(orgKey: string): JumpCounts {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(keyFor(orgKey));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: JumpCounts = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      // A non-finite or negative count is corrupt, not a hint. Dropping
      // it is safer than coercing it to something that then ranks.
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
      out[id] = Math.floor(value);
    }
    return out;
  } catch {
    return {};
  }
}

function write(orgKey: string, counts: JumpCounts): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(keyFor(orgKey), JSON.stringify(counts));
  } catch {
    /* quota or private mode — the ranking degrades to rail order */
  }
}

/** Record one jump taken from the capsule. Returns the new counts so a
 *  caller can rank without a second read. */
export function recordJump(orgKey: string, id: string): JumpCounts {
  if (!id) return readJumpCounts(orgKey);
  const counts = readJumpCounts(orgKey);
  counts[id] = (counts[id] ?? 0) + 1;

  let total = 0;
  for (const n of Object.values(counts)) total += n;
  if (total >= DECAY_AT) {
    for (const [k, n] of Object.entries(counts)) {
      const halved = Math.floor(n / 2);
      if (halved > 0) counts[k] = halved;
      else delete counts[k];
    }
  }

  const entries = Object.entries(counts);
  if (entries.length > MAX_TRACKED) {
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const kept: JumpCounts = {};
    for (const [k, n] of entries.slice(0, MAX_TRACKED)) kept[k] = n;
    write(orgKey, kept);
    return kept;
  }

  write(orgKey, counts);
  return counts;
}

export function clearJumpCounts(orgKey: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(keyFor(orgKey));
  } catch {
    /* nothing to clear */
  }
}

/**
 * Rank `items` by measured use, keeping the caller's order as the tie
 * break AND as the fallback for everything never used.
 *
 * Stable and total: an unused list comes back in exactly the order it
 * arrived, which is what makes a brand-new workspace show the rail's own
 * priorities rather than an arbitrary shuffle.
 */
export function rankByUsage<T extends { id: string }>(
  items: readonly T[],
  counts: JumpCounts,
): T[] {
  return items
    .map((item, index) => ({ item, index, count: counts[item.id] ?? 0 }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map((e) => e.item);
}
