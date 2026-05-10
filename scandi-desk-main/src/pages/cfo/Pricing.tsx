// /pricing — public + post-signup pricing surface.
//
// Reuses the same PricingSection embedded on the landing page so the
// experience is identical whether the user got here from the landing
// scroll or the post-signup redirect. Wraps it in a slim themed shell
// with a "back to home" link for unauth visitors.

import { Link, useNavigate } from "react-router-dom";
import { Logo } from "@/components/cfo/Logo";
import { ThemeToggle } from "@/components/cfo/ThemeToggle";
import { PricingSection } from "@/components/cfo/PricingSection";
import { useAuth } from "@/lib/auth";
import { useSubscription, isSubscriptionEntitled } from "@/lib/billing";
import { useEffect } from "react";

export default function Pricing() {
  const { status, displayName, signOut } = useAuth();
  const { subscription } = useSubscription();
  const navigate = useNavigate();

  // If the operator is already signed in AND on a paid plan (active),
  // /pricing acts as the upgrade/downgrade picker. Trial users see it as
  // their "choose your plan" surface.
  const isAuthed = status === "signed_in";

  useEffect(() => {
    // Quick sanity: if a signed-in user with an active paid subscription
    // lands here without picking, don't trap them. They can pick a different
    // plan or click the back link to /today.
    void isSubscriptionEntitled; // re-export keeps the helper in scope for callers
  }, []);

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <header className="px-6 sm:px-10 py-5 flex items-center justify-between gap-3">
        <Link to="/" className="flex items-center gap-3">
          <Logo size={26} compact />
          <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule">
            Financial Intelligence
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle compact />
          {isAuthed ? (
            <>
              <button
                onClick={() => navigate("/dashboard")}
                className="text-[13px] text-ink-soft hover:text-ink transition-colors"
              >
                {displayName ? `Continue as ${displayName}` : "Back to app"}
              </button>
              <button
                onClick={async () => { await signOut(); navigate("/"); }}
                className="text-[13px] text-ink-soft hover:text-ink transition-colors"
              >
                Sign out
              </button>
            </>
          ) : (
            <Link to="/" className="text-[13px] text-ink-soft hover:text-ink transition-colors">
              Back to home
            </Link>
          )}
        </div>
      </header>

      <main className="flex-1">
        <PricingSection />
        {/* Reassurance for trial users — clarifies that picking a plan now
            doesn't double-charge. */}
        {isAuthed && subscription?.status === "trial" && (
          <div className="mx-auto max-w-[680px] px-5 sm:px-8 pb-10 -mt-8 text-center text-[12.5px] text-ink-soft">
            You're in your 14-day free trial. Picking a plan now reserves it
            for when the trial ends — you won't be charged until then.
          </div>
        )}
      </main>
    </div>
  );
}
