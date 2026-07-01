// Newsletter preference for signed-in users (Settings page).
//
// Reads the caller's subscription status and offers a one-click
// subscribe / unsubscribe. Because the account email is already verified
// by Supabase Auth, subscribing here skips the double opt-in and confirms
// immediately (backend POST /api/newsletter/subscribe-me).

import { useEffect, useState } from "react";
import {
  getStatus,
  subscribeMe,
  unsubscribeMe,
  type SubscriptionStatus,
} from "@/lib/newsletterApi";

export function NewsletterSettings() {
  const [status, setStatus] = useState<SubscriptionStatus | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus("none"));
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(subscribe: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = subscribe ? await subscribeMe() : await unsubscribeMe();
      setStatus(next);
    } catch {
      setError("Couldn't update your preference. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const subscribed = status === "confirmed" || status === "pending";

  return (
    <div className="rounded-lg border border-rule bg-surface px-4 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13.5px] text-ink font-medium">Product newsletter</div>
          <div className="text-[12px] text-ink-soft mt-0.5">
            Product updates and Romanian SME finance insights, occasionally.
          </div>
          <div className="text-[12px] text-ink-soft mt-0.5">
            {status === "loading"
              ? "Checking your preference…"
              : subscribed
                ? "You're subscribed. Occasional product updates and finance insights."
                : "Get occasional product updates and Romanian SME finance insights."}
          </div>
        </div>
        <button
          type="button"
          disabled={busy || status === "loading"}
          onClick={() => toggle(!subscribed)}
          className={`
            shrink-0 h-9 px-4 rounded-lg text-[12.5px] font-medium transition-colors
            disabled:opacity-50 disabled:cursor-not-allowed
            ${subscribed
              ? "border border-rule text-ink-soft hover:bg-bg-2"
              : "bg-ink text-paper hover:bg-ink/90"}
          `}
        >
          {busy ? "…" : subscribed ? "Unsubscribe" : "Subscribe"}
        </button>
      </div>
      {error && <p className="mt-2 text-[12px] text-alert">{error}</p>}
    </div>
  );
}
