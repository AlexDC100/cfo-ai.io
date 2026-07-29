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
import { useAuth } from "@/lib/auth";
import {
  readPeriodVerdict,
  writePeriodVerdict,
  forgetPeriodVerdict,
} from "@/lib/dataPresence";
import { getActiveOrgId } from "@/lib/activeOrg";
import { fetchWorkspacePeriodsDirect, isCurrentMonthPeriod } from "@/lib/orgPeriods";

/** The workspace's permanent current-month period, when it exists.
 *
 *  `active_period_id` is only set once a period has been ANALYZED, so a
 *  workspace whose only period is the auto-created empty current month
 *  resolved to "none" and painted the no-data empty state — even though a
 *  perfectly good month was sitting there to upload into (2026-07-26 per
 *  operator: "select this non-deletable period if no period is available").
 *  Read straight from Supabase so this also works with the engine stopped. */
async function currentMonthPeriodId(uid: string | null): Promise<string | null> {
  const orgId = getActiveOrgId(uid);
  if (!orgId) return null;
  const payload = await fetchWorkspacePeriodsDirect(orgId);
  if (!payload) return null;
  const current = payload.periods.find((p) => isCurrentMonthPeriod(p.period_end));
  // Fall back to the newest period when the current month somehow isn't there
  // yet (useEnsureCurrentPeriod may still be creating it) — any real month
  // beats an empty state.
  return current?.period_id ?? payload.periods[0]?.period_id ?? null;
}

type ResolutionStatus = "ready" | "resolving" | "none";

// UUID-shape check — mirrors lib/activePeriod.ts. Distinguishes a real backend
// period (worth caching as proof the org has documents) from a sample/demo id.
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// The active-period resolution is remembered per user in lib/dataPresence
// (in-memory + localStorage, uid-scoped). A /api/org/periods-with-documents
// round-trip previously ran fresh on every page that landed without ?period= —
// so opening /benchmark with no data flashed a ~1s spinner every time, even
// across reloads. Now the verdict persists: once we know the user has no
// periods, this hook returns `status: "none"` on the very first paint and makes
// ZERO API calls. The verdict is refreshed when a real period appears in the
// URL and cleared on sign-out (see lib/dataPresence.clearDataPresence).

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
  const { user } = useAuth();
  const uid = user?.id ?? null;
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
    periodId
      ? "ready"
      : emptyFlag
        ? "none"
        // Persisted verdict already says this user has no periods → skip the
        // spinner entirely and paint the empty state on the very first render,
        // with no network call (even on a hard refresh / deep link).
        : uid && readPeriodVerdict(uid) === null
          ? "none"
          : "resolving",
  );

  useEffect(() => {
    // Already have a period from the URL? Mark ready and exit.
    if (periodId) {
      setStatus("ready");
      // Keep the verdict fresh: a real (uuid) period in the URL is proof the org
      // has at least this period, so a later bare-URL visit can skip the lookup
      // and canonicalize straight to it. Covers the just-uploaded case, where
      // the app navigates to ?period=<new uuid> directly.
      if (uid && isUuid(periodId)) writePeriodVerdict(uid, periodId);
      return;
    }
    // User just deleted/reset a period — show empty state, don't auto-resolve.
    // Forget the verdict so the next bare-URL visit re-resolves rather than
    // trusting a now-stale id (the period it points at may have just been
    // deleted).
    if (emptyFlag) {
      if (uid) forgetPeriodVerdict(uid);
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
    // Persisted verdict hit — no network needed.
    //   · null   → user has no periods: paint the empty state immediately.
    //   · string → known active period: canonicalize the URL without a fetch.
    const verdict = uid ? readPeriodVerdict(uid) : undefined;
    if (verdict === null) {
      // "No analyzed period" is no longer the same as "nowhere to go": the
      // workspace always keeps a current-month container. Look for it before
      // settling on the empty state.
      let cancelledVerdict = false;
      setStatus("resolving");
      void (async () => {
        const fallbackId = await currentMonthPeriodId(uid);
        if (cancelledVerdict) return;
        if (fallbackId) {
          const target = opts.basePath ?? window.location.pathname;
          navigate(
            `${target}?period=${encodeURIComponent(fallbackId)}${window.location.hash || ""}`,
            { replace: true },
          );
          return;
        }
        setStatus("none");
      })();
      return () => { cancelledVerdict = true; };
    }
    if (typeof verdict === "string") {
      const target = opts.basePath ?? window.location.pathname;
      navigate(
        `${target}?period=${encodeURIComponent(verdict)}${window.location.hash || ""}`,
        { replace: true },
      );
      return;
    }
    // Verdict unknown — one network resolution, then remember it so this and
    // every sibling page skip the round-trip for the rest of the session (and,
    // via localStorage, across future reloads too).
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
          // Remember the id so a later bare-URL visit skips the round-trip.
          if (uid) writePeriodVerdict(uid, body.active_period_id);
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
          // No ANALYZED period — but the workspace still keeps a current-month
          // container to land on (see currentMonthPeriodId above).
          const fallbackId = await currentMonthPeriodId(uid);
          if (cancelled) return;
          if (fallbackId) {
            const target = opts.basePath ?? window.location.pathname;
            navigate(
              `${target}?period=${encodeURIComponent(fallbackId)}${window.location.hash || ""}`,
              { replace: true },
            );
            return;
          }
          // Remember "no periods" so this + sibling pages render the empty
          // state instantly (and callless) instead of re-running this lookup.
          if (uid) writePeriodVerdict(uid, null);
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
  }, [periodId, emptyFlag, navigate, uid]);

  return { periodId, status };
}
