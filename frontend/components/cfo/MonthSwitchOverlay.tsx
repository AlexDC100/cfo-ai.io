// MonthSwitchOverlay — a full-screen loading veil shown while the app switches
// between months (the TopHeader month stepper changes ?period=<id>, which
// refetches the whole active period). Mounted once in AppShell so the veil
// covers every route.
//
// It only fires on a REAL switch (one loaded period → another), never on the
// very first load, and only while the new period is actually fetching — a
// cached month switches instantly with no flash (render gates on
// `switching && isLoading`, which is false when the data is already warm).

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { useActivePeriod } from "@/lib/activePeriod";

export function MonthSwitchOverlay() {
  const { id, isLoading } = useActivePeriod();
  const prevId = useRef<string | null>(id);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    // A month switch = the active period id changed from one real id to
    // another. The initial null → first-id resolve is NOT a switch.
    if (prevId.current !== null && id !== null && prevId.current !== id) {
      setSwitching(true);
    }
    prevId.current = id;
  }, [id]);

  // Clear once the new month's data has landed.
  useEffect(() => {
    if (switching && !isLoading) setSwitching(false);
  }, [switching, isLoading]);

  if (!switching || !isLoading) return null;

  return (
    <div
      className="fixed inset-0 z-[200] grid place-items-center bg-bg/70 backdrop-blur-sm"
      role="status"
      aria-busy="true"
      aria-label="Loading month"
      data-testid="month-switch-overlay"
    >
      <div className="flex flex-col items-center gap-3 text-ink-soft">
        <Loader2 size={30} strokeWidth={2} className="animate-spin text-brand-d" />
        <span className="text-[12.5px] font-medium">Loading month…</span>
      </div>
    </div>
  );
}
