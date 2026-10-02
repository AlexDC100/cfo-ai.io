// Admin — operator console. Today one section: CUSTOM SOLUTIONS — bespoke
// workspaces built on top of CFO AI for a single client (AutoMasters first),
// and the accounts allowed to open each one. Linking is by the account's
// e-mail; the person must already have a CFO AI account.
//
// Operator-only on the wire: every call is refused by the engine unless the
// verified user id is in PLATFORM_ADMIN_USER_IDS / PRICING_ADMIN_USER_IDS
// (src/engine/api/_custom_solutions.py). The page hides itself otherwise.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, Link2, Unlink } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { RouteFallback } from "@/components/cfo/RouteFallback";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import {
  SOLUTION_BY_KEY,
  adminApi,
  useInvalidateSolutions,
  usePlatformAdmin,
  type AdminSolution,
} from "@/lib/customSolutions";
import { formatDateTime } from "@/lib/locale";
import { Card, Empty } from "./automasters/ui";
import "./automasters/amI18n";

const LIST_KEY = ["custom-solutions", "admin-list"];

export default function Admin() {
  const { t } = useTranslation();
  const { isAdmin, loading } = usePlatformAdmin();
  const list = useQuery({ queryKey: LIST_KEY, queryFn: adminApi.list, enabled: isAdmin });

  if (loading) return <RouteFallback />;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-[720px] py-16">
        <Card><Empty title={t("admin.denied.title")} body={t("admin.denied.body")} /></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-16" data-testid="admin-page">
      <PageHeader eyebrow={t("admin.eyebrow")} title={t("admin.title")} subtitle={t("admin.subtitle")} />
      <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">{t("admin.solutions.heading")}</h2>
      {list.isLoading ? (
        <RouteFallback />
      ) : list.isError ? (
        <Card>
          <Empty title={t("admin.loadError")} body={(list.error as Error)?.message}
            action={<Button variant="secondary" onClick={() => list.refetch()}>{t("am.retry")}</Button>} />
        </Card>
      ) : (list.data?.solutions ?? []).length === 0 ? (
        <Card><Empty title={t("admin.solutions.none")} /></Card>
      ) : (
        list.data!.solutions.map((s) => <SolutionCard key={s.key} solution={s} />)
      )}
    </div>
  );
}

function SolutionCard({ solution }: { solution: AdminSolution }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const invalidateMine = useInvalidateSolutions();
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState<string | null>(null);
  const def = SOLUTION_BY_KEY[solution.key];

  const apply = (r: { solutions: AdminSolution[] }) => {
    qc.setQueryData(LIST_KEY, { solutions: r.solutions });
    void invalidateMine();
  };

  const link = async () => {
    const e = email.trim();
    if (!e) return;
    setBusy(true);
    try {
      apply(await adminApi.link(solution.key, e, note.trim() || undefined));
      toast.success(t("admin.solutions.linked", { email: e, name: solution.name }));
      setEmail("");
      setNote("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (userId: string, who: string) => {
    setBusy(true);
    try {
      apply(await adminApi.unlink(solution.key, userId));
      toast.success(t("admin.solutions.unlinked", { email: who, name: solution.name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirmUnlink(null);
    }
  };

  return (
    <Card
      title={solution.name}
      actions={def && (
        <Link to={def.path} className="inline-flex items-center gap-1 text-[12.5px] text-ink-soft hover:text-ink">
          {t("admin.solutions.open")} <ExternalLink size={13} aria-hidden />
        </Link>
      )}
    >
      <div className="space-y-5">
        {solution.description && <p className="text-[13.5px] leading-relaxed text-ink-soft">{solution.description}</p>}

        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void link(); }}>
          <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[12px] text-ink-soft">
            {t("admin.solutions.email")}
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.ro" autoComplete="off"
              className="h-9 rounded-sm border border-rule bg-surface px-3 text-[14px] text-ink placeholder:text-ink-mute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </label>
          <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[12px] text-ink-soft">
            {t("admin.solutions.note")}
            <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)}
              placeholder={t("admin.solutions.notePlaceholder")}
              className="h-9 rounded-sm border border-rule bg-surface px-3 text-[14px] text-ink placeholder:text-ink-mute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </label>
          <Button type="submit" disabled={busy || !email.trim()}>
            <Link2 /> {t("admin.solutions.link")}
          </Button>
        </form>
        <p className="-mt-2 text-[12px] text-ink-soft">{t("admin.solutions.linkHelp")}</p>

        <div>
          <div className="pb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-soft">
            {t("admin.solutions.accounts", { count: solution.accounts.length })}
          </div>
          {solution.accounts.length === 0 ? (
            <p className="text-[13px] text-ink-soft">{t("admin.solutions.noAccounts")}</p>
          ) : (
            <ul className="divide-y divide-rule-soft border-y border-rule-soft">
              {solution.accounts.map((a) => (
                <li key={a.user_id} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">
                      {a.email || a.user_id}
                      {a.user_id === user?.id && <span className="ml-2 text-ink-soft">{t("admin.solutions.you")}</span>}
                    </span>
                    <span className="block truncate text-[12px] text-ink-soft">
                      {t("admin.solutions.grantedAt", { when: formatDateTime(a.granted_at) })}
                      {a.granted_by_email ? ` · ${t("admin.solutions.grantedBy", { email: a.granted_by_email })}` : ""}
                      {a.note ? ` · ${a.note}` : ""}
                    </span>
                  </span>
                  {confirmUnlink === a.user_id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-[12.5px] text-ink-soft">{t("admin.solutions.confirmUnlink")}</span>
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => unlink(a.user_id, a.email)}>
                        {t("admin.solutions.unlink")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmUnlink(null)}>{t("am.cancel")}</Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmUnlink(a.user_id)}>
                      <Unlink /> {t("admin.solutions.unlink")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
