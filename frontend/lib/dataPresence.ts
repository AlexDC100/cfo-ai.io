// Client-side "does this signed-in user have any uploaded data?" memory.
//
// Several pages (Benchmark, Products, the dashboard) would otherwise fetch on
// mount purely to DISCOVER that the user has nothing yet, then render an empty
// state — a wasted round-trip + loader for the common brand-new / no-upload
// case. This module remembers the verdict per user so those pages can render
// their empty state INSTANTLY with ZERO API calls once it's known.
//
// The verdict is:
//   · learned from the first real fetch (or seeded when data appears in the URL)
//   · persisted to localStorage (uid-scoped) so it survives reloads + deep links
//   · updated when the user uploads (→ has data) or resets (→ unknown)
//   · cleared on sign-out / user-switch (see clearDataPresence)
//
// Two independent domains, because they are separate uploads:
//   · "period" — trial-balance periods (Benchmark, dashboard, reports). The
//     verdict is the active period id (string) or null ("no periods").
//   · "sku"    — SKU sales datasets (Products). The verdict is a boolean.
//
// uid-scoping (both the in-memory Map key and the localStorage key carry the
// user id) makes the cache self-correcting across users: a different user reads
// their OWN key, misses, and resolves once via the network — never inheriting
// the previous user's verdict even before the auth sign-out handler clears it.

// In-memory caches (per uid) — the fast path; localStorage is the durable path.
const periodMem = new Map<string, string | null>();
const skuMem = new Map<string, boolean>();

const PERIOD_PREFIX = "cfoai:v1:period-verdict:";
const SKU_PREFIX = "cfoai:v1:sku-verdict:";
const periodKey = (uid: string) => `${PERIOD_PREFIX}${uid}`;
const skuKey = (uid: string) => `${SKU_PREFIX}${uid}`;

// ── period (trial-balance) verdict ─────────────────────────────────────────
// undefined = unknown (must resolve); null = no periods; string = active id.

export function readPeriodVerdict(uid: string): string | null | undefined {
  if (periodMem.has(uid)) return periodMem.get(uid);
  try {
    const raw = localStorage.getItem(periodKey(uid));
    if (raw === null) return undefined;
    const v = raw === "__none__" ? null : raw;
    periodMem.set(uid, v);
    return v;
  } catch {
    return undefined;
  }
}

export function writePeriodVerdict(uid: string, verdict: string | null): void {
  periodMem.set(uid, verdict);
  try {
    localStorage.setItem(periodKey(uid), verdict === null ? "__none__" : verdict);
  } catch {
    /* private mode / quota — in-memory value still applies for this session */
  }
}

/** Forget the period verdict for this user, forcing a fresh resolve next time.
 *  Used on explicit workspace reset (?empty=1) since the remembered period may
 *  have just been deleted. */
export function forgetPeriodVerdict(uid: string): void {
  periodMem.delete(uid);
  try {
    localStorage.removeItem(periodKey(uid));
  } catch {
    /* ignore */
  }
}

/** Forget any remembered verdict that points at `periodId` — call this when a
 *  period is DELETED. Without it the remembered id survives the delete and the
 *  next bare-URL visit canonicalizes straight to a period that no longer
 *  exists. Sweeps every uid because the caller (the Workspace tab) doesn't
 *  carry one, and a verdict naming a deleted period is wrong for any user. */
export function forgetPeriodVerdictFor(periodId: string): void {
  for (const [uid, v] of periodMem) {
    if (v === periodId) periodMem.delete(uid);
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PERIOD_PREFIX) && localStorage.getItem(k) === periodId) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    /* ignore */
  }
}

// ── sku (datasets) verdict ─────────────────────────────────────────────────
// undefined = unknown (must resolve); false = no datasets; true = has datasets.

export function readSkuVerdict(uid: string): boolean | undefined {
  if (skuMem.has(uid)) return skuMem.get(uid);
  try {
    const raw = localStorage.getItem(skuKey(uid));
    if (raw === null) return undefined;
    const v = raw === "1";
    skuMem.set(uid, v);
    return v;
  } catch {
    return undefined;
  }
}

export function writeSkuVerdict(uid: string, hasData: boolean): void {
  skuMem.set(uid, hasData);
  try {
    localStorage.setItem(skuKey(uid), hasData ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// ── lifecycle ──────────────────────────────────────────────────────────────

/** Clear ALL cached verdicts (every user) — wired into the auth ownership-
 *  change handler so a new session never inherits stale data-presence state. */
export function clearDataPresence(): void {
  periodMem.clear();
  skuMem.clear();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(PERIOD_PREFIX) || k.startsWith(SKU_PREFIX))) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    /* ignore */
  }
}
