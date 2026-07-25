// Polls the FastAPI engine's /health so the TopHeader can show whether the
// backend is actually reachable — most useful in local dev (the engine
// often isn't running unless you started it), but works the same way in
// prod. Ask CFO AI chat is NOT gated by this — it runs on a Supabase Edge
// Function independent of the engine (see CLAUDE.md "Milestone D"); this
// indicator only reflects the FastAPI backend (Today/Cash/Profit/Products/
// pipeline/etc).

import { useEffect, useRef, useState } from "react";
import { checkBackendHealth } from "@/lib/cfoApi";

export type BackendStatus = "checking" | "connected" | "disconnected";

const POLL_MS = 20_000;

export function useBackendStatus(): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>("checking");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function probe() {
      const ok = await checkBackendHealth();
      if (mountedRef.current) setStatus(ok ? "connected" : "disconnected");
    }

    probe();
    const interval = setInterval(probe, POLL_MS);
    // Re-probe on focus/online so "I just started the backend" or "wifi
    // came back" reflects instantly instead of waiting up to POLL_MS.
    window.addEventListener("focus", probe);
    window.addEventListener("online", probe);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      window.removeEventListener("focus", probe);
      window.removeEventListener("online", probe);
    };
  }, []);

  return status;
}
