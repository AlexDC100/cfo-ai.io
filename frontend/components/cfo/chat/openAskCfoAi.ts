// Cross-page entry point: open the Ask CFO AI panel from anywhere
// with an optional prefilled prompt.
//
// The pattern: pages dispatch a `cfo-ai-open-ask` CustomEvent (with an
// optional `prompt` payload). AppShell listens for that event and
// opens the slide-over panel; CFOChatPanel forwards the prefilled
// prompt to its mounted shell once the panel is open, and the shell's
// composer.setText() inserts the text and focuses.
//
// This keeps individual pages decoupled from AppShell internals — a
// Products prompt chip just imports `openAskCfoAi("Which SKUs are
// loss-makers?")` and the mechanics happen via DOM event.

const EVENT_NAME = "cfo-ai-open-ask";

export interface OpenAskCfoAiDetail {
  /** Optional text to prefill into the composer once the panel opens.
   *  The chat shell focuses the composer and places the caret at the
   *  end so the user can edit or hit Enter to send. */
  prompt?: string;
}

/** Fire-and-forget. Returns false in non-browser contexts. */
export function openAskCfoAi(prompt?: string): boolean {
  if (typeof window === "undefined") return false;
  const detail: OpenAskCfoAiDetail = prompt ? { prompt } : {};
  try {
    window.dispatchEvent(new CustomEvent<OpenAskCfoAiDetail>(EVENT_NAME, { detail }));
    return true;
  } catch {
    return false;
  }
}

/** AppShell + CFOChatPanel use this name to subscribe. Exported as a
 *  constant rather than a magic string so a future rename is grep-safe. */
export const OPEN_ASK_CFO_AI_EVENT = EVENT_NAME;
