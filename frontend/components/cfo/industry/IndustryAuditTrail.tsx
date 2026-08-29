// IndustryAuditTrail — read-only history of industry reassignments for a period.
//
// Hits GET /api/industry/audit-log/{period_id}. The table is server-tamper-
// resistant: writes only flow through the service role (no member-write RLS
// policy). Reads honor RLS via the per_user client, so each row in the
// response is already scoped to the caller's org.
//
// Use cases
//   · Settings → Industry → "View history" panel
//   · Compliance / audit export
//   · Debugging classification drift across iterations
//
// Empty / loading / error states each have their own surface so callers
// can drop this in without worrying about flicker.

import { useEffect, useState } from "react";
import { ArrowRight, History, Loader2, ShieldAlert } from "lucide-react";

import type { AuditLogRow } from "@/lib/industryApi";
import { IndustryApiError, getAuditLog, sourceLabel } from "@/lib/industryApi";

interface Props {
  periodId: string;
  /** Maximum rows to fetch. Defaults to 50; the backend caps at 200. */
  limit?: number;
  /** Title override — useful when nested inside a larger settings card. */
  title?: string;
}

export function IndustryAuditTrail({ periodId, limit = 50, title }: Props) {
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);
  const [error, setError] = useState<IndustryApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    getAuditLog(periodId, limit)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof IndustryApiError) setError(e);
        else setError(new IndustryApiError(String(e), 0, null));
      });
    return () => { cancelled = true; };
  }, [periodId, limit]);

  return (
    <section data-testid="industry-audit-trail" className="space-y-3">
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-[15px] font-semibold text-ink inline-flex items-center gap-2">
          <History size={14} strokeWidth={1.75} className="text-ink-mute" />
          {title ?? "Classification history"}
        </h3>
        {rows && rows.length > 0 && (
          <span className="text-[11px] text-ink-mute">
            {rows.length} {rows.length === 1 ? "change" : "changes"}
          </span>
        )}
      </header>

      {rows === null && !error && (
        <div className="rounded-md border border-rule bg-bg-2/40 px-3 py-3 text-[12.5px] text-ink-mute inline-flex items-center gap-2">
          <Loader2 size={13} className="animate-spin" /> Loading…
        </div>
      )}

      {error && (
        <div
          data-testid="industry-audit-trail-error"
          className="rounded-md border border-brand-l/50 bg-brand-tint/60 px-3 py-2.5 text-[12.5px] text-brand-d dark:text-brand-l inline-flex items-center gap-2"
        >
          <ShieldAlert size={13} strokeWidth={1.75} />
          {error.status === 403
            ? "You don't have permission to view this audit trail."
            : `Couldn't load history (HTTP ${error.status}).`}
        </div>
      )}

      {rows !== null && rows.length === 0 && !error && (
        <div
          data-testid="industry-audit-trail-empty"
          className="rounded-md border border-rule bg-bg-2/40 px-3 py-3 text-[12.5px] text-ink-mute"
        >
          No reassignments recorded yet for this period.
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <ol
          data-testid="industry-audit-trail-list"
          className="rounded-lg border border-rule bg-surface divide-y divide-rule"
        >
          {rows.map((row) => (
            <li key={row.id} className="px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-[12.5px] text-ink inline-flex items-center gap-1.5 flex-wrap">
                  {row.prev_industry_key ? (
                    <>
                      <span className="font-medium">{row.prev_industry_key}</span>
                      <ArrowRight size={11} strokeWidth={1.75} className="text-ink-mute" />
                    </>
                  ) : (
                    <span className="text-ink-mute italic">— first assignment —</span>
                  )}
                  <span className="font-medium text-ink">{row.new_industry_key}</span>
                </div>
                <time
                  dateTime={row.changed_at}
                  className="text-[11px] text-ink-mute tabular-nums"
                  title={row.changed_at}
                >
                  {formatTimestamp(row.changed_at)}
                </time>
              </div>
              <div className="mt-1 text-[11px] text-ink-mute flex flex-wrap gap-x-3 gap-y-0.5">
                <span>
                  Source:{" "}
                  <span className="text-ink-soft">
                    {row.prev_source ? `${sourceLabel(row.prev_source as never)} → ` : ""}
                    {sourceLabel(row.new_source as never)}
                  </span>
                </span>
                {row.changed_by && (
                  <span title={row.changed_by}>
                    By: <code className="text-[10.5px] text-ink-soft">{row.changed_by.slice(0, 8)}…</code>
                  </span>
                )}
              </div>
              {row.reason && (
                <p className="mt-1 text-[12px] text-ink-soft leading-relaxed">
                  “{row.reason}”
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}
