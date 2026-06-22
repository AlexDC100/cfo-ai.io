// useActivePeriodFallback — auto-resolve the active period when a page
// is hit without an explicit ?period= URL param.
//
// Problem this solves: the entire app uses ?period=<uuid> in the URL as
// the source of truth for which period is being viewed. Pages like
// /benchmark, /products, /reports, /dashboard show empty "no analysis"
// states when the URL is missing the param — even when the user has
// uploaded documents (i.e. their `active_period_id` in the database is
// set). This caused operator-reported bugs: navigating between pages
// via the sidebar would drop the period and surface empty states.
//
// Fix: this hook fetches `/api/org/periods-with-documents`, reads
// `active_period_id`, and `replace`s the URL to canonicalize it. Pages
// continue to use the URL param as the source of truth — they just get
// the param populated automatically when the user has a default period.
//
// Usage:
//
//   const { periodId, status } = useActivePeriodFallback();
//   if (!periodId) {
//     if (status === "resolving") return <Spinner />;
//     return <EmptyState ... />;   // user genuinely has no docs
//   }
//   // ... rest of page reads periodId
//
// The hook is idempotent — once a `?period=` exists in the URL it does
// nothing on subsequent renders.

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { getSupabase } from "@/lib/supabase";
import { SITE } from "@/config/site";
import { isPublicTestMode } from "@/lib/testMode";
import { DEMO_SAMPLE_ID } from "@/lib/demo/demoCompany";

type ResolutionStatus = "ready" | "resolving" | "none";

interface UseActivePeriodFallbackOptions {
  /** When set, append this path to the URL after canonicalization
   *  (e.g. for routes that take additional path segments).
   *  Defaults to `location.pathname` so the user stays on the same page. */
  basePath?: string;
}

export function useActivePeriodFallback(
  opts: UseActivePeriodFallbackOptions = {},
): { periodId: string | null; status: ResolutionStatus } {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const periodId = params.get("period");
  // After resetWorkspace() deletes the current period, FinancialStatements
  // appends `?empty=1` to the URL so the user lands on the empty state
  // (upload zone + sample picker + public-company card) instead of being
  // auto-shunted to the next-most-recent period. Without this guard the
  // fallback would canonicalize the URL straight back to the next
  // active_period_id and the operator perceives reset as "next document".
  const emptyFlag = params.get("empty") === "1";

  // If URL already has period, we're done. Otherwise pending until lookup
  // resolves to a concrete value (canonicalize URL) or `none` (no docs).
  // emptyFlag overrides — we stay on the empty state without a fetch.
  const [status, setStatus] = useState<ResolutionStatus>(
    periodId ? "ready" : emptyFlag ? "none" : "resolving",
  );

  useEffect(() => {
    // Already have a period from the URL? Mark ready and exit.
    if (periodId) {
      setStatus("ready");
      return;
    }
    // User just deleted/reset a period — show empty state, don't auto-resolve.
    if (emptyFlag) {
      setStatus("none");
      return;
    }
    // F6.1 — Public/marketing surface: greet a bare-URL visitor with the
    // Meridian demo period (5-year history → the Trend view + multi-year
    // surfaces have data to show). This deliberately bypasses the backend
    // `active_period_id` lookup on the test surface. A real upload navigates
    // to `?period=<uuid>`, which wins via the `periodId` guard above, so the
    // demo is replaced the instant the visitor uploads their own data; a
    // reset (`?empty=1`) still lands on the empty state via the guard above.
    if (isPublicTestMode) {
      const target = opts.basePath ?? window.location.pathname;
      navigate(
        `${target}?period=${DEMO_SAMPLE_ID}${window.location.hash || ""}`,
        { replace: true },
      );
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const sb = getSupabase();
        if (!sb) {
          if (!cancelled) setStatus("none");
          return;
        }
        const { data: sess } = await sb.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) setStatus("none");
          return;
        }
        const resp = await fetch(`${SITE.apiUrl}/api/org/periods-with-documents`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
          if (!cancelled) setStatus("none");
          return;
        }
        const body = (await resp.json()) as { active_period_id?: string | null };
        if (cancelled) return;
        if (body.active_period_id) {
          // Canonicalize URL so deep links + browser back/forward stay
          // consistent. Use `replace` so back-button doesn't bounce
          // between the bare and canonical URLs.
          const target = opts.basePath ?? window.location.pathname;
          navigate(
            `${target}?period=${encodeURIComponent(body.active_period_id)}${window.location.hash || ""}`,
            { replace: true },
          );
          // The navigate triggers a re-render with periodId set; we don't
          // mark "ready" here because the URL change is what carries the
          // signal forward.
        } else {
          setStatus("none");
        }
      } catch {
        if (!cancelled) setStatus("none");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally exclude opts.basePath from deps — it's read once on
    // resolution; changing it during a session shouldn't re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId, emptyFlag, navigate]);

  return { periodId, status };
}
