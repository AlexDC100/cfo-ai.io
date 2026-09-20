// staleChunkReload.ts — recover a tab that outlived a deploy (2026-09-20 P0).
//
// Every lazy route/module is a content-hashed chunk. A tab loaded before a
// deploy asks for hashes that no longer exist; Vite reports that as a
// `vite:preloadError` on window. Left alone the dynamic import rejects and
// whatever awaited it fails in its own way — on the upload path that was
// "Analysis failed" for a document the server was ready to run.
//
// One reload fetches the new index.html and the new hashes. Guarded twice:
//   · never while an upload is in flight (a reload would drop the file the
//     user just chose — the banner's Retry covers that case instead);
//   · at most once per RELOAD_WINDOW_MS, so a chunk that is genuinely missing
//     from the server can never become a reload loop.
import { isInFlight, readUploadStore } from "@/lib/uploadStore";

export const RELOAD_STAMP_KEY = "cfo-stale-chunk-reload-at";
export const RELOAD_WINDOW_MS = 60_000;

export function shouldReloadForStaleChunk(now: number = Date.now()): boolean {
  try {
    const current = readUploadStore().current;
    if (current && isInFlight(current.status)) return false;
  } catch { /* store unreadable — fall through to the loop guard */ }
  try {
    const last = Number(sessionStorage.getItem(RELOAD_STAMP_KEY) ?? 0);
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(now));
    return true;
  } catch {
    return false; // no sessionStorage → no loop guard → never reload
  }
}

export function installStaleChunkReload(reload: () => void = () => window.location.reload()): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (!shouldReloadForStaleChunk()) return;
    event.preventDefault(); // we are handling it; don't rethrow into the importer
    reload();
  });
}
