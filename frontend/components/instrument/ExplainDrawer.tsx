// EXPLAIN ANYTHING — the drawer (Prompt 12, Part D).
//
// A right-side floating Sheet (the Command-Center shell geometry — the
// one drawer silhouette app-wide) titled "Explained simply". Behavior
// contract, in order of importance:
//
//   1. The deterministic TEMPLATE paints SYNCHRONOUSLY on open — the
//      drawer always says something useful before (and regardless of)
//      any network call. AI is an upgrade, never a dependency (gate M4).
//   2. When the AI answer lands it replaces the text and the source
//      caption switches to "AI explanation · grounded in your figures".
//   3. When the AI path fails (thrown, or the Edge Function's 200
//      sentinel), the template simply stands, with an A2-calm one-line
//      note and a quiet Retry — never an error state, never a raw
//      payload in the DOM.
//
// Figures render through the consumer's OWN <Amount>/<MoneyAmount>
// nodes passed via `figureDisplay` — the drawer shows the panel's exact
// rendered figures, cent-identical by construction, instead of
// re-formatting anything itself.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw, Sparkles } from "lucide-react";

import "@/components/cfo/simple/explainI18n";
import {
  getExplanation,
  templateExplanation,
  type Explanation,
  type ExplainInput,
} from "@/lib/explain";
import { useActiveLocale } from "@/lib/locale";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

import type { ReactNode } from "react";

export interface ExplainDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What to explain — built by the consumer from figures its panel
   *  already renders. Null while the consumer has nothing to explain. */
  request: ExplainInput | null;
  /** The panel's own rendered figures (<Amount>/<MoneyAmount> nodes) —
   *  shown in a quiet list above the prose. Optional. */
  figureDisplay?: ReactNode;
}

export function ExplainDrawer({ open, onOpenChange, request, figureDisplay }: ExplainDrawerProps) {
  const { t } = useTranslation();
  const locale = useActiveLocale();

  const fullRequest = useMemo(
    () => (request ? { ...request, lang: locale } : null),
    [request, locale],
  );

  // The synchronous floor: the template for the CURRENT request. Never
  // waits on anything.
  const template = useMemo<Explanation | null>(
    () =>
      fullRequest
        ? { text: templateExplanation(fullRequest), source: "template", degraded: null }
        : null,
    [fullRequest],
  );

  const [result, setResult] = useState<Explanation | null>(null);
  const [asking, setAsking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open || !fullRequest) return;
    const seq = ++seqRef.current;
    const controller = new AbortController();
    setResult(null);
    setAsking(true);
    getExplanation(fullRequest, { signal: controller.signal }).then((res) => {
      if (seqRef.current !== seq) return; // stale — a newer open/retry won
      setResult(res);
      setAsking(false);
    });
    return () => {
      controller.abort();
      if (seqRef.current === seq) setAsking(false);
    };
    // `attempt` re-runs the AI path on Retry; the cache only ever holds
    // successes, so a retry is a genuine re-ask.
  }, [open, fullRequest, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const shown = result ?? template;
  const degraded = !asking && result?.degraded != null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-testid="explain-drawer"
        className="
          w-[calc(100vw-16px)] sm:w-[400px] sm:max-w-[420px]
          p-0 m-2 sm:m-3 h-[calc(100dvh-16px)] sm:h-[calc(100dvh-24px)]
          rounded-2xl
          bg-surface dark:bg-bg-2
          border border-rule-strong
          text-ink
          shadow-4
          overflow-hidden
          flex flex-col
        "
      >
        <div className="flex items-start gap-2.5 border-b border-rule-soft px-5 pb-3.5 pt-5">
          <Sparkles size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-brand-d dark:text-brand-l" />
          <div className="min-w-0">
            <SheetTitle className="text-[15px] font-semibold leading-tight text-ink">
              {t("explain.title")}
            </SheetTitle>
            <SheetDescription className="mt-0.5 truncate text-[12px] text-ink-soft">
              {request?.title ?? ""}
            </SheetDescription>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {figureDisplay ? (
            <div className="mb-4 rounded-md border border-rule bg-bg-2 px-3.5 py-2.5">
              <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ink-mute">
                {t("explain.figures")}
              </div>
              {figureDisplay}
            </div>
          ) : null}

          <div data-testid="explain-text" className="space-y-2.5">
            {(shown?.text ?? "").split(/\n+/).filter(Boolean).map((para, i) => (
              <p key={i} className="text-[13.5px] leading-relaxed text-ink-2">
                {para}
              </p>
            ))}
          </div>

          {asking ? (
            <p className="mt-4 text-[11.5px] text-ink-mute" data-testid="explain-asking">
              {t("explain.asking")}
            </p>
          ) : null}

          {degraded ? (
            <div
              className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5"
              data-testid="explain-degraded"
            >
              <p className="text-[11.5px] text-ink-mute">{t("explain.aiUnavailable")}</p>
              <button
                type="button"
                onClick={retry}
                data-testid="explain-retry"
                className="inline-flex items-center gap-1 rounded-full border border-rule px-2.5 py-0.5 text-[11px] font-medium text-ink-soft transition-colors hover:border-rule-strong hover:text-ink"
              >
                <RotateCw size={11} strokeWidth={2} aria-hidden />
                {t("explain.retry")}
              </button>
            </div>
          ) : null}
        </div>

        <div className="border-t border-rule-soft px-5 py-2.5">
          <p className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-mute" data-testid="explain-source">
            {shown?.source === "ai" ? t("explain.sourceAi") : t("explain.sourceTemplate")}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
