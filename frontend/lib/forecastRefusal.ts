// THE FORECAST ENGINE'S REFUSAL, IN ITS OWN WORDS.
//
// `/api/forecast/{id}/recompute` answers a refusal as 422 `{code, text,
// field}` (and a statements rebuild failure as 409 `{code, text}`), so the
// sentence arrives as a structured `detail` — and `cfoApi`'s fallback, which
// has no `message` key to find, stringifies the whole object. Printing
// `{"code":"out_of_bounds","text":"…"}` at a reader is the envelope, not the
// sentence. `text` is what the engine wrote; `field` is the driver it names.
//
// Anything that is not that shape falls back to the error's message, which is
// where a transport failure and a 500 already live. Same reading as the
// Forecast page's own (pages/cfo/Forecast.tsx `readRefusal`); lifted here so
// the Scenarios page reads refusals the same way without importing a page.

export interface EngineRefusal {
  readonly text: string;
  readonly field: string | null;
  readonly code: string | null;
}

export function readEngineRefusal(err: unknown): EngineRefusal | null {
  const detail = (err as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object") {
    const rec = detail as { text?: unknown; field?: unknown; code?: unknown };
    if (typeof rec.text === "string" && rec.text.length > 0) {
      return {
        text: rec.text,
        field: typeof rec.field === "string" ? rec.field : null,
        code: typeof rec.code === "string" ? rec.code : null,
      };
    }
  }
  const message = (err as Error | null)?.message;
  return typeof message === "string" && message.length > 0
    ? { text: message, field: null, code: null }
    : null;
}
