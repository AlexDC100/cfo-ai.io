// GATE (2026-09-20 P0): a stale-chunk error reloads the tab ONCE, never in a
// loop, and never while an upload is in flight. Fails on: a second reload
// inside the window; a reload during an in-flight upload; no reload at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("stale chunk reload", () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.resetModules(); });

  it("reloads once, then holds for the window, then may reload again", async () => {
    const { shouldReloadForStaleChunk, RELOAD_WINDOW_MS } = await import("@/lib/staleChunkReload");
    expect(shouldReloadForStaleChunk(1_000_000)).toBe(true);
    expect(shouldReloadForStaleChunk(1_000_500)).toBe(false);
    expect(shouldReloadForStaleChunk(1_000_000 + RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(shouldReloadForStaleChunk(1_000_000 + RELOAD_WINDOW_MS + 1)).toBe(true);
  });

  it("never reloads while an upload is in flight; a failed one does not block it", async () => {
    const entry = (status: string) => localStorage.setItem("cfo-upload-current", JSON.stringify({
      docId: "d1", filename: "tb.xlsx", status, surface: "dashboard", startedAt: Date.now(), updatedAt: Date.now() }));
    entry("extracting");
    let mod = await import("@/lib/staleChunkReload");
    expect(mod.shouldReloadForStaleChunk()).toBe(false);
    vi.resetModules(); sessionStorage.clear(); entry("failed");
    mod = await import("@/lib/staleChunkReload");
    expect(mod.shouldReloadForStaleChunk()).toBe(true);
  });

  it("the window listener calls reload exactly once for a burst of errors", async () => {
    const { installStaleChunkReload } = await import("@/lib/staleChunkReload");
    const reload = vi.fn();
    installStaleChunkReload(reload);
    for (let i = 0; i < 3; i++) window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
