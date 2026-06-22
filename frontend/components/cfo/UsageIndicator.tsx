// Phase 5 — Per-user current-month usage chip.
//
// Compact pill in the dashboard header: "3/5 uploads" with a hover-card
// detailing all metrics. Polls /api/billing/usage every 60s.
//
// Hidden entirely when there's no tier (pre-checkout) or USAGE_LIMITS_ENABLED
// is off backend-side (the API returns null limits).

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { AlertTriangle } from "lucide-react";

interface UsageResponse {
  tier: string | null;
  tier_name: string | null;
  month: string;
  limits: {
    uploads_per_month: number;
    llm_calls_per_month: number;
    max_users: number;
    max_companies: number;
    overage_price_per_doc_eur: number | null;
  } | null;
  used: {
    uploads: number;
    llm_calls: number;
    exports: number;
    storage_bytes: number;
  };
  status: string | null;
  is_founding_member: boolean;
  trial_end: string | null;
  current_period_end: string | null;
}

async function fetchUsage(): Promise<UsageResponse | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return null;
  const apiUrl =
    (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  try {
    const r = await fetch(`${apiUrl}/api/billing/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return (await r.json()) as UsageResponse;
  } catch {
    return null;
  }
}

function pct(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, Math.round((used / cap) * 100));
}

export function UsageIndicator() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      const next = await fetchUsage();
      if (!cancelled) setData(next);
    };
    void poll();
    timer = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  if (!data || !data.limits || !data.tier) return null;

  const uploadsPct = pct(data.used.uploads, data.limits.uploads_per_month);
  const llmPct = pct(data.used.llm_calls, data.limits.llm_calls_per_month);
  const worst = Math.max(uploadsPct, llmPct);
  const tone =
    worst >= 100
      ? "text-red-500 border-red-500/30 bg-red-500/5"
      : worst >= 80
        ? "text-amber-500 border-amber-500/30 bg-amber-500/5"
        : "text-ink-soft border-rule bg-surface";

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((o) => !o)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) {
            setTimeout(() => setOpen(false), 100);
          }
        }}
        className={
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11.5px] transition-colors " +
          tone
        }
        aria-label="Monthly usage"
      >
        {worst >= 80 && <AlertTriangle size={11} aria-hidden />}
        <span>
          {data.used.uploads}/{data.limits.uploads_per_month} uploads
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[320px] rounded-lg border border-rule bg-surface shadow-lg p-4 z-50">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] uppercase tracking-wide text-ink-soft">
              {data.tier_name} · {data.month}
            </p>
            {data.is_founding_member && (
              <span className="text-[10px] uppercase tracking-wide text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                Founding
              </span>
            )}
          </div>
          <UsageRow
            label="Document uploads"
            used={data.used.uploads}
            cap={data.limits.uploads_per_month}
          />
          <UsageRow
            label="AI analyses"
            used={data.used.llm_calls}
            cap={data.limits.llm_calls_per_month}
          />
          <p className="text-[11px] text-ink-soft mt-3 leading-relaxed">
            Counters reset on the 1st of each month (UTC).
          </p>
          {worst >= 80 && (
            <a
              href="/pricing"
              className="block mt-3 text-center text-[12px] font-medium text-ink bg-ink/5 hover:bg-ink/10 py-2 rounded-md transition-colors"
            >
              {data.limits.overage_price_per_doc_eur !== null
                ? `Buy more or upgrade · €${data.limits.overage_price_per_doc_eur}/doc`
                : "Upgrade to keep going →"}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function UsageRow({
  label,
  used,
  cap,
}: {
  label: string;
  used: number;
  cap: number;
}) {
  const percent = pct(used, cap);
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-[12.5px] text-ink">{label}</span>
        <span className="text-[11.5px] text-ink-soft">
          {used} / {cap}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-rule/40 overflow-hidden">
        <div
          className={
            "h-full transition-all " +
            (percent >= 100
              ? "bg-red-500"
              : percent >= 80
                ? "bg-amber-500"
                : "bg-ink/60")
          }
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
