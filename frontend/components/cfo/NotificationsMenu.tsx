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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { isNativeShell, openNativeSheet } from "@/lib/nativeShell";
import { tapHandlers } from "@/lib/tapHandlers";
import { fetchAlerts, type AlertRow, type AlertSeverity } from "@/lib/supabase";
import { getActiveOrgId } from "@/lib/activeOrg";
import { useAuth } from "@/lib/auth";
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

/** Last-fetched alerts, per workspace, so a re-opened list paints at once
 *  and revalidates behind it (2026-09-09 per operator: the iOS sheet must
 *  be instant). Keyed by org id so a different workspace — or a different
 *  user on the same device — never sees another's alerts. */
const ALERTS_CACHE_KEY = "cfo-ai-alerts-cache-v1";

function readAlertsCache(orgId: string | null): AlertRow[] | null {
  if (!orgId) return null;
  try {
    const raw = localStorage.getItem(ALERTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { orgId?: string; alerts?: AlertRow[] };
    return parsed.orgId === orgId && Array.isArray(parsed.alerts) ? parsed.alerts : null;
  } catch {
    return null;
  }
}

function writeAlertsCache(orgId: string | null, alerts: AlertRow[]): void {
  if (!orgId) return;
  try {
    localStorage.setItem(ALERTS_CACHE_KEY, JSON.stringify({ orgId, alerts }));
  } catch {
    /* quota / private mode */
  }
}

/** The workspace's open alerts: once on mount, again whenever `refresh`
 *  flips true or changes (a panel opened an hour later mustn't show an
 *  hour-old list). Seeded from the per-workspace cache, so `loading` is
 *  only true when there is nothing to show yet. */
export function useAlertsFeed(refresh: boolean | number): { alerts: AlertRow[]; loading: boolean } {
  const { user } = useAuth();
  const orgId = getActiveOrgId(user?.id);
  const [alerts, setAlerts] = useState<AlertRow[]>(() => readAlertsCache(orgId) ?? []);
  const [loading, setLoading] = useState(() => readAlertsCache(orgId) === null);
  const load = useCallback(async () => {
    if (readAlertsCache(orgId) === null) setLoading(true);
    try {
      const next = await fetchAlerts();
      setAlerts(next);
      writeAlertsCache(orgId, next);
    } finally {
      setLoading(false);
    }
  }, [orgId]);
  // The session (and so the org) resolves a beat after first render: adopt
  // the cache the moment the org is known, ahead of the network.
  useEffect(() => {
    const cached = readAlertsCache(orgId);
    if (cached) { setAlerts(cached); setLoading(false); }
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (refresh) void load(); }, [refresh, load]);
  return { alerts, loading };
}

/** The list itself — shared by the dialog, the in-page bottom sheet and the
 *  iOS native sheet page (/_native/sheet/notifications). */
export function NotificationsList({ alerts, loading }: { alerts: AlertRow[]; loading: boolean }) {
  const { t } = useTranslation();
  return (
    <>

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
    </>
  );
}

export function NotificationsMenu({ variant = "icon" }: { variant?: "icon" | "row" } = {}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { alerts, loading } = useAlertsFeed(open);
  // iOS shell (2026-09-08 per operator): a NATIVE sheet instead of the
  // in-page one; everywhere else the in-page dialog/sheet below.
  const openPanel = () => {
    if (openNativeSheet("notifications")) return;
    setOpen(true);
  };

  const badgeCount = alerts.filter((a) => BADGED.includes(a.severity)).length;

  // Shared list body — rendered inside a bottom sheet in the native shell
  // and inside the centred dialog everywhere else.
  const body = <NotificationsList alerts={alerts} loading={loading} />;

  return (
    <>
      {variant === "row" ? (
        // Mobile drawer row (native-mobile pass 2026-08-04): the bell left
        // the phone header; this full-width row inside the nav sheet is its
        // home there. ≥44px tall, pressed state, same dialog.
        <button
          type="button"
          onClick={openPanel}
        {...tapHandlers(openPanel)}
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
        onClick={openPanel}
        {...tapHandlers(openPanel)}
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

      {isNativeShell() ? (
        // Native shell (2026-09-08 per operator): a bottom sheet — it rises
        // over whatever is open (the drawer included), with the home-
        // indicator inset inside it so its edge is flush with the screen.
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            data-testid="notifications-dialog"
            className="p-0 rounded-t-3xl border-t border-x-0 border-b-0 border-rule-strong bg-surface dark:bg-bg-2 text-ink [&>button.absolute]:hidden flex flex-col"
            style={{
              paddingBottom: "env(safe-area-inset-bottom)",
              maxHeight: "calc(100dvh - env(safe-area-inset-top) - 2.5rem)",
            }}
          >
            <div aria-hidden className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-ink-mute/40" />
            <div className="px-5 pt-4 pb-3">
              <SheetTitle className="text-[15px] font-semibold text-ink">{t("topbar.notifications")}</SheetTitle>
              <SheetDescription className="mt-0.5 text-[12.5px] text-ink-soft">
                {t("panels.notificationsDesc")}
              </SheetDescription>
              <div className="mt-4 border-t border-rule" />
            </div>
            <div className="px-5 pb-5 overflow-y-auto chat-scroll min-h-0">{body}</div>
          </SheetContent>
        </Sheet>
      ) : (
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
          <div className="max-h-[60vh] overflow-y-auto chat-scroll -mx-1 px-1">{body}</div>
        </DialogContent>
      </Dialog>
      )}
    </>
  );
}
