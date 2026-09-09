// /_native/sheet/:kind — the page the iOS shell hosts INSIDE a SwiftUI
// bottom sheet (2026-09-08 per operator, "native bottom sheets"). A second
// WebView loads it, sharing the main WebView's localStorage session, so the
// account surface and the notifications list render with live data.
//
// Leaving this route (a quick action calling navigate("/workspace"), the
// sign-out redirect…) is watched by <NativeSheetRouteWatcher> in App.tsx:
// it tells the shell to dismiss the sheet and route the MAIN WebView there.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { CommandCenter } from "@/components/cfo/command";
import { NotificationsList, useAlertsFeed } from "@/components/cfo/NotificationsMenu";
import { closeNativeSheet } from "@/lib/nativeShell";
import { refreshPlanState } from "@/lib/planState";

/** The shell keeps this page booted between showings and dispatches this
 *  event each time it presents the sheet (mobile/src/NativeSheet.tsx). */
const PRESENTED_EVENT = "cfo:sheet-presented";

export default function NativeSheetPage() {
  const { kind } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  // Counts presentations: the page shows what it already has (cached plan,
  // cached alerts, the session) and revalidates each time it is shown.
  const [shownCount, setShownCount] = useState(0);
  useEffect(() => {
    const onPresented = () => {
      setShownCount((n) => n + 1);
      void refreshPlanState();
    };
    window.addEventListener(PRESENTED_EVENT, onPresented);
    return () => window.removeEventListener(PRESENTED_EVENT, onPresented);
  }, []);
  return (
    <div
      className="min-h-[100dvh] text-ink"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      data-testid={`native-sheet-${kind}`}
    >
      {kind === "notifications" ? (
        <NotificationsSheet title={t("topbar.notifications")} description={t("panels.notificationsDesc")} refresh={shownCount} />
      ) : (
        <CommandCenter
          open
          onOpenChange={(o) => {
            if (!o) closeNativeSheet();
          }}
          onOpenAi={() => navigate("/chat")}
          onOpenUpload={() => navigate("/dashboard")}
          presentation="inline"
        />
      )}
    </div>
  );
}

function NotificationsSheet({ title, description, refresh }: { title: string; description: string; refresh: number }) {
  const { alerts, loading } = useAlertsFeed(refresh);
  return (
    <div className="px-5 pt-9 pb-4">
      <h1 className="text-[15px] font-semibold text-ink">{title}</h1>
      <p className="mt-0.5 text-[12.5px] text-ink-soft">{description}</p>
      {/* Divider under the title block (2026-09-08 per operator). */}
      <div className="my-4 border-t border-rule" />
      <NotificationsList alerts={alerts} loading={loading} />
    </div>
  );
}
