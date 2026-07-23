// /account/settings — the Settings surface WITHOUT the app shell.
//
// Reached from the landing page's account dropdown ("Settings"). Renders the
// exact same <Settings /> page the in-app /settings route uses, but under the
// landing page's own tab bar (MarketingHeader, fixed to the top) instead of
// AppShell — no sidebar, no app header. Auth is enforced by the AuthGuard
// wrapper on the route in App.tsx.

import Settings from "./Settings";
import { MarketingHeader } from "./Landing";

export default function AccountSettings() {
  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <MarketingHeader />

      <main className="flex-1 w-full max-w-[1100px] mx-auto px-5 sm:px-8 py-8">
        <Settings />
      </main>
    </div>
  );
}
