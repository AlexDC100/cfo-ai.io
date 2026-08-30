// Web Storage shim for the vitest runner — MUST be imported first.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────
// Node 25 defines its own `localStorage` / `sessionStorage` globals as part
// of the built-in Web Storage API. When no `--localstorage-file` is
// configured, Node still installs the global but the value degrades to a
// bare `{}` — no getItem, no setItem, no clear, prototype is Object.prototype.
// Reproduce it with nothing but Node:
//
//     $ node -e "console.log(typeof localStorage, typeof localStorage.clear)"
//     object undefined
//     (node:NNNNN) Warning: `--localstorage-file` was provided without a valid path
//
// That global is installed on `globalThis` before vitest's jsdom environment
// runs. jsdom DOES build a real `Storage`, but in the jsdom environment
// `window === globalThis`, so Node's own lazily-defined property already
// occupies the name and jsdom's working implementation never becomes
// reachable. Every test therefore sees a dud object, and any call as
// ordinary as `localStorage.clear()` throws `TypeError: ... is not a
// function`.
//
// The symptom was previously worked around by hand-rolling a private stub at
// the top of ~18 individual test files. That is a per-file patch for a
// per-process defect: every new test that touches storage starts life broken
// and has to rediscover the workaround. This module fixes it once, in the
// shared setup, for every test file.
//
// ── WHY IT IS NOT A MOCK ──────────────────────────────────────────────
// This is a faithful in-memory implementation of the Storage interface, not
// a test double with convenient behaviour. Missing keys return `null` (not
// `undefined`), values are coerced to strings, `length` and `key(n)` follow
// insertion order. Product code cannot tell it apart from a browser's, which
// is the point — tests must exercise the real persistence paths.
//
// Imported for side effects only, and it must come BEFORE any module that
// reads storage at import time (i18next's language detector does). ES import
// bindings are hoisted and evaluated in source order, so keeping this as the
// first import in setup.ts is what guarantees the ordering.

/** Faithful in-memory implementation of the DOM `Storage` interface. */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    if (!Number.isInteger(index) || index < 0) return null;
    const keys = Array.from(this.map.keys());
    return index < keys.length ? keys[index] : null;
  }

  getItem(key: string): string | null {
    // Storage returns null — not undefined — for an absent key. Code under
    // test branches on `=== null`, so this distinction is load-bearing.
    const value = this.map.get(String(key));
    return value === undefined ? null : value;
  }

  setItem(key: string, value: string): void {
    // Real Storage stringifies both arguments; a test that writes a number
    // and reads back a number would pass here and fail in a browser.
    this.map.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.map.delete(String(key));
  }

  clear(): void {
    this.map.clear();
  }

  [name: string]: unknown;
}

/** True only when `candidate` implements the whole Storage surface we rely on. */
function isUsableStorage(candidate: unknown): candidate is Storage {
  if (!candidate || typeof candidate !== "object") return false;
  const c = candidate as Record<string, unknown>;
  return (
    typeof c.getItem === "function" &&
    typeof c.setItem === "function" &&
    typeof c.removeItem === "function" &&
    typeof c.clear === "function" &&
    typeof c.key === "function"
  );
}

function install(name: "localStorage" | "sessionStorage"): void {
  const existing = (globalThis as Record<string, unknown>)[name];

  // If the host environment ever supplies a genuinely working Storage — a
  // future Node that fixes this, or a different test environment — defer to
  // it rather than shadowing a real implementation with our own.
  if (isUsableStorage(existing)) return;

  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, name, {
    value: storage,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  // In the jsdom environment `window === globalThis`, so the define above
  // already covers `window.x`. Guard the case where they ever diverge, so
  // `window.localStorage` and bare `localStorage` can never disagree —
  // a split between them would be worse than the bug this file fixes.
  if (typeof window !== "undefined" && (window as unknown) !== globalThis) {
    Object.defineProperty(window, name, {
      value: storage,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
}

install("localStorage");
install("sessionStorage");

// ── CANARY ────────────────────────────────────────────────────────────
// This module works by *discovering* what the environment provides, and the
// project has been burned by discovery-shaped checks that quietly find
// nothing and report success. So it must not be possible for this file to
// run, do nothing, and leave the suite in exactly the broken state it exists
// to prevent. Prove the post-condition on the real globals and fail loudly
// and immediately if storage is not usable — a hard error naming the cause
// beats 7 confusing `is not a function` failures in unrelated test files.
for (const name of ["localStorage", "sessionStorage"] as const) {
  const store = (globalThis as Record<string, unknown>)[name];
  if (!isUsableStorage(store)) {
    throw new Error(
      `[webStorageShim] ${name} is still unusable after install. ` +
        `Tests cannot run reliably. Got: ${Object.prototype.toString.call(store)}`,
    );
  }
  const probe = `__webStorageShim_probe_${name}__`;
  store.setItem(probe, "1");
  if (store.getItem(probe) !== "1") {
    throw new Error(`[webStorageShim] ${name} did not round-trip a write.`);
  }
  if (store.getItem("__webStorageShim_absent__") !== null) {
    throw new Error(`[webStorageShim] ${name}.getItem must return null for absent keys.`);
  }
  store.removeItem(probe);
  if (store.getItem(probe) !== null) {
    throw new Error(`[webStorageShim] ${name}.removeItem did not remove the key.`);
  }
}

export {};
