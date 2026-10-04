// workspaceRestoreNotice — what a reader is told when "Restore" is refused.
//
// The database's cap guard refuses a restore that would put an owner over
// their plan's workspace limit. The two screens that restore (the workspace
// page's "Recently deleted" shelf, and the redesigned home's) used to answer
// every refusal with "Couldn't restore" — no reason, no next step, while the
// workspace's purge date kept counting down. This is the one sentence both
// show instead: the limit is reached, and where to upgrade.
//
// Nothing here decides anything: `lastWorkspaceRestoreRefusal()` is the
// database's own refusal, read where the RPC answered (lib/org.ts).
import type { TFunction } from "i18next";

import { lastWorkspaceRestoreRefusal, type WorkspaceRestoreRefusal } from "@/lib/org";

/** Where a reader upgrades. A route of the app (gate links-routed). */
export const WORKSPACE_UPGRADE_PATH = "/pricing";

export interface WorkspaceRestoreNotice {
  title: string;
  description: string;
  /** The label of the one action: open the plans. */
  cta: string;
  /** Where that action goes. */
  href: string;
}

/** The limit notice for a refusal, or null when the refusal was not the
 *  limit (the caller then shows its own "couldn't restore"). */
export function workspaceRestoreLimitNotice(
  t: TFunction,
  refusal: WorkspaceRestoreRefusal = lastWorkspaceRestoreRefusal(),
): WorkspaceRestoreNotice | null {
  if (!refusal.capReached) return null;
  return {
    title: t("pricing.workspaceLimitTitle"),
    description:
      refusal.cap !== null
        ? t("pricing.workspaceRestoreLimitDesc", { count: refusal.cap })
        : t("pricing.workspaceRestoreLimitDescNoCount"),
    cta: t("pricing.workspaceLimitCta"),
    href: WORKSPACE_UPGRADE_PATH,
  };
}
