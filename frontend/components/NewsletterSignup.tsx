// Public newsletter signup — email input + subscribe button.
//
// No auth required; calls POST /api/newsletter/subscribe which starts the
// double opt-in flow (a confirmation email is sent via Resend). Drop this
// anywhere public — landing page footer is the natural home:
//
//   import { NewsletterSignup } from "@/components/NewsletterSignup";
//   <NewsletterSignup />

import { useState } from "react";
import { subscribe, NewsletterApiError } from "@/lib/newsletterApi";

type State = "idle" | "loading" | "sent" | "already" | "error";

export function NewsletterSignup({ source = "landing-footer" }: { source?: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || state === "loading") return;
    setState("loading");
    setMessage(null);
    try {
      const res = await subscribe(email.trim(), source);
      if (res.status === "already_subscribed") {
        setState("already");
        setMessage("You're already subscribed.");
      } else {
        setState("sent");
        setMessage("Check your inbox to confirm your subscription.");
      }
      setEmail("");
    } catch (err) {
      setState("error");
      setMessage(
        err instanceof NewsletterApiError && err.status === 422
          ? "Please enter a valid email address."
          : "Something went wrong. Please try again.",
      );
    }
  }

  const done = state === "sent" || state === "already";

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm">
      <label htmlFor="newsletter-email" className="block text-[12px] font-medium text-ink-soft mb-1.5">
        Newsletter
      </label>
      <div className="flex gap-2">
        <input
          id="newsletter-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          placeholder="you@company.com"
          disabled={state === "loading"}
          className="
            flex-1 h-10 px-3 rounded-lg
            border border-rule bg-surface
            text-[13px] text-ink placeholder:text-ink-mute
            focus:outline-none focus:ring-2 focus:ring-brand/40
            disabled:opacity-60
          "
        />
        <button
          type="submit"
          disabled={state === "loading"}
          className="
            shrink-0 h-10 px-4 rounded-lg text-[13px] font-medium
            bg-ink text-paper hover:bg-ink/90 transition-colors
            disabled:opacity-50 disabled:cursor-not-allowed
          "
        >
          {state === "loading" ? "…" : "Subscribe"}
        </button>
      </div>
      {message && (
        <p
          className={`mt-2 text-[12px] ${
            state === "error" ? "text-alert" : done ? "text-success" : "text-ink-soft"
          }`}
        >
          {message}
        </p>
      )}
    </form>
  );
}
