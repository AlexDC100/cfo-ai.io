// THE DIAL — one-time trust hint (Prompt 12, Part C §3). Simple mode.
//
// "Every number here is machine-checked — tap to see how." rendered once
// near the trust chip; tapping the text opens the accuracy receipt the
// chip already owns, dismissing (or tapping) writes the guard key so it
// never nags again. The trust chip itself is untouched — its copy is
// FROZEN and identical across modes; this is only a pointer to it.

import { useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import "./storyI18n";

export const TRUST_HINT_SEEN_KEY = "cfo-trust-hint-seen-v1";

function hintSeen(): boolean {
  try {
    return localStorage.getItem(TRUST_HINT_SEEN_KEY) === "true";
  } catch {
    return false;
  }
}

function markHintSeen(): void {
  try {
    localStorage.setItem(TRUST_HINT_SEEN_KEY, "true");
  } catch {
    /* private mode — the hint simply shows again next session */
  }
}

export function TrustHint({ onSeeHow }: { onSeeHow: () => void }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<boolean>(hintSeen);
  if (dismissed) return null;
  return (
    <div
      data-testid="trust-hint"
      className="mt-1.5 inline-flex items-center gap-2 rounded-full border border-rule bg-bg-2 py-1 pl-3 pr-1.5"
    >
      <button
        type="button"
        data-testid="trust-hint-see-how"
        onClick={() => {
          markHintSeen();
          setDismissed(true);
          onSeeHow();
        }}
        className="text-left text-[12px] leading-snug text-ink-2 transition-colors duration-micro hover:text-ink"
      >
        {t("story.trustHint.text")}
      </button>
      <button
        type="button"
        aria-label={t("story.trustHint.dismiss")}
        data-testid="trust-hint-dismiss"
        onClick={() => {
          markHintSeen();
          setDismissed(true);
        }}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-mute transition-colors duration-micro hover:bg-bg hover:text-ink"
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
