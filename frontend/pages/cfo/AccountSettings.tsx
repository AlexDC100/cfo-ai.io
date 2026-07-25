// /account/settings — the Settings surface WITHOUT the app shell.
//
// Reached from the landing page's account dropdown ("Settings"). Renders the
// exact same <Settings /> page the in-app /settings route uses, but under the
// landing page's own tab bar (MarketingHeader, fixed to the top) instead of
// AppShell — no sidebar, no app header. Auth is enforced by the AuthGuard
// wrapper on the route in App.tsx.
//
// The header uses `fixed` (position:fixed, out of flow) rather than the
// sticky-in-flow default, so it never pushes this page's own layout down —
// <main> carries its own top padding to clear it instead.

import Settings from "./Settings";
import { MarketingHeader } from "./Landing";

export default function AccountSettings() {
  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <MarketingHeader fixed />

      <main className="flex-1 w-full max-w-[1400px] mx-auto px-5 sm:px-8 pt-24 pb-8">
        <Settings />
      </main>
    </div>
  );
}
