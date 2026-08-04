// TopHeader notifications — bell button + modal list.
//
// Sits immediately left of <AccountMenu/>. Reads the org's persisted,
// un-resolved alerts (`alerts` table, via lib/supabase's `fetchAlerts`) —
// the same snapshot the Today/alerts surfaces render, so the bell can
// never disagree with the page beneath it.
//
// Deliberately NOT a second alert engine: `lib/alerts.ts` also derives
// alerts client-side from a DailyRun as a seed/fallback, but those are
// scoped to a loaded dataset on one page. The header is global and must
// work on every route, so it reads the persisted org-scoped rows instead.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchAlerts, type AlertRow, type AlertSeverity } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { activeLocale } from "@/lib/locale";

/** Chip colours per severity — mirrors the ladder used elsewhere in the
 *  app (critical/high read as alert, medium as caution, low/info muted). */
const SEVERITY_CHIP: Record<AlertSeverity, string> = {
  critical: "bg-red-500/10 text-red-600 border-red-500/30",
  high: "bg-red-500/10 text-red-600 border-red-500/25",
  medium: "bg-amber-500/10 text-amber-600 border-amber-500/30",
  low: "bg-bg-2 text-ink-soft border-rule",
  info: "bg-bg-2 text-ink-soft border-rule",
};

/** Severities that earn the unread dot. A workspace always carries a few
 *  low/info items; badging those would leave the bell permanently lit and
 *  train the user to ignore it. */
const BADGED: AlertSeverity[] = ["critical", "high", "medium"];

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(activeLocale(), { dateStyle: "medium", timeStyle: "short" });
}

export function NotificationsMenu({ variant = "icon" }: { variant?: "icon" | "row" } = {}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAlerts(await fetchAlerts());
    } finally {
      setLoading(false);
    }
  }, []);

  // Once on mount for the badge count, and again on open so a panel
  // opened an hour later isn't showing an hour-old list.
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  const badgeCount = alerts.filter((a) => BADGED.includes(a.severity)).length;

  return (
    <>
      {variant === "row" ? (
        // Mobile drawer row (native-mobile pass 2026-08-04): the bell left
        // the phone header; this full-width row inside the nav sheet is its
        // home there. ≥44px tall, pressed state, same dialog.
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="notifications-row"
          className="w-full inline-flex items-center gap-3 px-2.5 min-h-[44px] rounded-lg text-left text-[13.5px] text-ink hover:bg-bg-2/60 active:bg-bg-2 transition-colors duration-150"
        >
          <Bell size={16} strokeWidth={1.75} className="shrink-0 text-ink-soft" />
          <span className="flex-1">{t("topbar.notifications")}</span>
          {badgeCount > 0 && (
            <span className="min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-semibold leading-none tabular-nums">
              {badgeCount > 9 ? "9+" : badgeCount}
            </span>
          )}
        </button>
      ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="notifications-button"
        aria-label={
          badgeCount > 0
            ? t("panels.notificationsAttentionAria", { count: badgeCount })
            : t("topbar.notifications")
        }
        className="relative inline-flex items-center justify-center h-9 w-9 rounded-md text-ink-soft hover:text-ink hover:bg-bg-2 active:bg-bg-2/80 transition-colors"
      >
        <Bell size={16} strokeWidth={1.75} />
        {badgeCount > 0 && (
          <span
            data-testid="notifications-badge"
            className="absolute top-1.5 right-1.5 min-w-[15px] h-[15px] px-1 inline-flex items-center justify-center rounded-full bg-red-600 text-white text-[9.5px] font-semibold leading-none tabular-nums"
          >
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        )}
      </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[560px]" data-testid="notifications-dialog">
          <DialogHeader>
            <DialogTitle>{t("topbar.notifications")}</DialogTitle>
            <DialogDescription>
              {t("panels.notificationsDesc")}
            </DialogDescription>
          </DialogHeader>

          {/* Capped height so a noisy workspace scrolls inside the modal
              instead of pushing the dialog past the viewport. */}
          <div className="max-h-[60vh] overflow-y-auto chat-scroll -mx-1 px-1">
            {loading ? (
              <div className="py-10 flex items-center justify-center gap-2 text-[13px] text-ink-soft">
                <Loader2 size={14} className="animate-spin" />
                {t("common.loading")}
              </div>
            ) : alerts.length === 0 ? (
              <div className="py-10 text-center">
                <p className="text-[13px] text-ink">{t("panels.notificationsEmpty")}</p>
                <p className="mt-1 text-[12px] text-ink-mute">
                  {t("panels.notificationsEmptyHint")}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-rule/60">
                {alerts.map((a) => (
                  <li key={a.id} className="py-3 first:pt-0">
                    <div className="flex items-start gap-3">
                      <span
                        className={cn(
                          "shrink-0 mt-0.5 inline-flex items-center h-[19px] px-2 rounded-full border text-[10px] font-medium uppercase tracking-[0.06em]",
                          SEVERITY_CHIP[a.severity],
                        )}
                      >
                        {a.severity}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13.5px] text-ink">{a.title}</div>
                        {a.body && (
                          <p className="mt-0.5 text-[12px] text-ink-soft leading-snug">
                            {a.body}
                          </p>
                        )}
                        <div className="mt-1 text-[11px] text-ink-mute">
                          {a.category.replace(/_/g, " ")} · {formatWhen(a.created_at)}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
