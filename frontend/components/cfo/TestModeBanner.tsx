// Persistent TEST MODE banner — top of every page when
// `VITE_PUBLIC_TEST_MODE=1` is set at build time.
//
// Design rules (per operator spec):
//   - Unmistakable: distinct color (amber), high contrast, not visually
//     coexisting with normal app chrome.
//   - Not dismissable across sessions: a user closing the tab and
//     coming back must see the banner again. (We allow a same-session
//     close so the banner doesn't permanently steal vertical space
//     during heavy use; sessionStorage scopes the dismissal to one tab.)
//   - Explicit on-site disclosure: states the access posture (open
//     preview, no login) AND the data-sharing posture (uploads visible
//     to other visitors — the F3.27 shared-test-org tradeoff).
//
// Mounted once at the top of <App /> (above the route boundary) so it
// shows on Login/Signup/Landing/Dashboard/etc. without per-route
// plumbing. The component returns null when test mode is off, so the
// import + mount is a no-op in production posture.

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { isPublicTestMode } from "@/lib/testMode";

const DISMISS_KEY = "cfo:test-mode-banner-dismissed:v1";

export function TestModeBanner() {
  // No-op when test mode is off — keeps the mount site agnostic.
  if (!isPublicTestMode) return null;

  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="public-test-mode-banner"
      className="
        sticky top-0 z-[60]
        w-full
        bg-[#5CD3C5] text-[#1B7268]
        border-b border-[#2AA89B]/40
        shadow-[0_2px_8px_-2px_rgba(42,168,155,0.35)]
      "
    >
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-2 sm:py-2.5 flex items-center gap-3">
        <AlertTriangle
          size={18}
          strokeWidth={2.25}
          className="shrink-0 text-[#1B7268]"
          aria-hidden
        />
        <div className="flex-1 text-[12.5px] sm:text-[13px] leading-tight font-medium">
          <strong className="font-bold uppercase tracking-wide">
            TEST MODE —
          </strong>{" "}
          open preview. No login required. <span className="hidden sm:inline">
            Uploads are visible to other visitors.{" "}
          </span>
          <span className="font-semibold">
            Do not upload confidential or production data.
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            try {
              sessionStorage.setItem(DISMISS_KEY, "1");
            } catch {
              /* private mode */
            }
            setDismissed(true);
          }}
          data-testid="test-mode-banner-dismiss"
          aria-label="Hide test-mode banner for this session (reopens next tab)"
          className="
            shrink-0 inline-flex items-center justify-center
            h-7 w-7 rounded-md
            text-[#1B7268]/80 hover:text-[#1B7268] hover:bg-[#2AA89B]/30
            transition-colors
          "
        >
          <X size={15} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}
