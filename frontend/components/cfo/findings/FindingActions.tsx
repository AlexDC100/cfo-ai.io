// What a reader can DO with a finding, and the two of those actions that
// carry a rule with them.
//
// DISMISSAL IS NOT DELETION. The form below refuses to submit without a
// reason, states the scope the dismissal will apply to (rule + subject,
// never rule alone — a rule-only dismissal silences the same test on a
// different account in a different company), and says out loud that a
// CRITICAL finding stays on the list flagged as dismissed. That is
// `_finding_rank.Dismissal`'s own contract, made visible instead of
// implied. The payload handed to `onDismiss` is built by
// `buildDismissal`, so the client cannot invent a shape the engine will
// not accept.
//
// COMPARE PERIODS shows what the engine actually knows about history —
// `persistence` and `persistence_label`, computed by the multi-period
// lane — rather than navigating to a page that would have to recompute
// it. When a host supplies `onComparePeriods` it wins; otherwise the
// affordance reveals the persistence strip in place. An affordance that
// promises more than the data behind it is the generic-findings failure
// in button form.

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  Calculator,
  History,
  MessageSquare,
  Package,
  RotateCcw,
  X,
} from "lucide-react";

import {
  HIGHLIGHT_PARAM,
  STATEMENT_TAB,
  TAB_PARAM,
  type TraceableSource,
} from "@/lib/traceableSource";
import {
  buildDismissal,
  chatPromptFor,
  primaryTrace,
  scopeKeyOf,
  toggleExportPack,
  useExportPack,
  type Finding,
  type FindingDismissal,
} from "@/lib/findings";

import "./findingsI18n";

const BTN =
  "inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-2.5 py-1.5 " +
  "text-[12px] text-ink-soft transition-colors hover:border-rule-strong hover:text-ink " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50";

const BTN_ON =
  "inline-flex items-center gap-1.5 rounded-md border border-brand-l/60 bg-brand-tint px-2.5 py-1.5 " +
  "text-[12px] text-brand-d transition-colors focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-brand/50";

export interface FindingActionsProps {
  finding: Finding;
  /** Simple mode: the four moves that act on THIS finding. Compare and
   *  export-pack are analyst work and ride with the full check. */
  minimal?: boolean;
  recomputed: boolean;
  onToggleRecompute: () => void;
  showHistory: boolean;
  onToggleHistory: () => void;
  /** Persisted by the host when it has somewhere to persist to. */
  onDismiss?: (dismissal: FindingDismissal) => void;
  onComparePeriods?: (finding: Finding) => void;
}

function labelForStatement(s: TraceableSource["statement"]): string {
  return s === "bs" ? "Balance Sheet" : s === "pl" ? "P&L" : "Cash Flow";
}

export function FindingActions({
  finding,
  minimal = false,
  recomputed,
  onToggleRecompute,
  showHistory,
  onToggleHistory,
  onDismiss,
  onComparePeriods,
}: FindingActionsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [dismissing, setDismissing] = useState(false);
  const pack = useExportPack();

  const trace = primaryTrace(finding);
  const inPack = pack.includes(finding.key);
  const hasImpact = finding.elements.impact !== null;
  const hasHistory = finding.persistence > 1;

  const viewEvidence = useCallback(() => {
    if (!trace) return;
    const next = new URLSearchParams(params);
    next.set(TAB_PARAM, STATEMENT_TAB[trace.statement]);
    next.set(HIGHLIGHT_PARAM, trace.bucket);
    navigate({ pathname: location.pathname, search: `?${next.toString()}` });
  }, [trace, params, navigate, location.pathname]);

  const ask = useCallback(() => {
    try {
      sessionStorage.setItem(
        "cfo-chat-preload",
        JSON.stringify({ prompt: chatPromptFor(finding) }),
      );
    } catch {
      /* storage unavailable — the chat still opens, without the prefill */
    }
    const next = new URLSearchParams(params);
    navigate({ pathname: "/chat", search: `?${next.toString()}` });
  }, [finding, params, navigate]);

  if (dismissing) {
    return (
      <DismissForm
        finding={finding}
        onCancel={() => setDismissing(false)}
        onConfirm={(d) => {
          setDismissing(false);
          onDismiss?.(d);
        }}
      />
    );
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 pt-1"
      data-testid="fnd-actions"
    >
      {trace ? (
        <button
          type="button"
          className={BTN}
          onClick={viewEvidence}
          title={t("fnd.act.viewEvidenceHint", { where: labelForStatement(trace.statement) })}
          data-testid="fnd-act-evidence"
        >
          <ArrowUpRight size={13} strokeWidth={1.8} />
          {t("fnd.act.viewEvidence")}
        </button>
      ) : null}

      {hasImpact ? (
        <button
          type="button"
          className={recomputed ? BTN_ON : BTN}
          onClick={onToggleRecompute}
          aria-pressed={recomputed}
          data-testid="fnd-act-recompute"
        >
          <Calculator size={13} strokeWidth={1.8} />
          {recomputed ? t("fnd.act.recomputeOff") : t("fnd.act.recompute")}
        </button>
      ) : null}

      {hasHistory && !minimal ? (
        <button
          type="button"
          className={showHistory ? BTN_ON : BTN}
          aria-pressed={showHistory}
          onClick={() =>
            onComparePeriods ? onComparePeriods(finding) : onToggleHistory()
          }
          title={t("fnd.act.compareHint", { count: finding.persistence })}
          data-testid="fnd-act-compare"
        >
          <History size={13} strokeWidth={1.8} />
          {t("fnd.act.compare")}
        </button>
      ) : null}

      <button type="button" className={BTN} onClick={ask} data-testid="fnd-act-ask">
        <MessageSquare size={13} strokeWidth={1.8} />
        {t("fnd.act.ask")}
      </button>

      {minimal ? null : (
        <button
          type="button"
          className={inPack ? BTN_ON : BTN}
          aria-pressed={inPack}
          onClick={() => toggleExportPack(finding.key)}
          data-testid="fnd-act-pack"
        >
          <Package size={13} strokeWidth={1.8} />
          {inPack ? t("fnd.act.inPack") : t("fnd.act.addPack")}
        </button>
      )}

      <button
        type="button"
        className={`${BTN} ml-auto`}
        onClick={() => setDismissing(true)}
        data-testid="fnd-act-dismiss"
      >
        <X size={13} strokeWidth={1.8} />
        {t("fnd.act.dismiss")}
      </button>
    </div>
  );
}

// ── the dismissal form ──────────────────────────────────────────────────

function DismissForm({
  finding,
  onCancel,
  onConfirm,
}: {
  finding: Finding;
  onCancel: () => void;
  onConfirm: (d: FindingDismissal) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const isCritical = finding.effectiveSeverity === "critical";
  const ready = reason.trim().length > 0;

  return (
    <form
      className="rounded-md border border-rule bg-bg-2 p-3"
      data-testid="fnd-dismiss-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onConfirm(buildDismissal(finding, reason.trim()));
      }}
    >
      <p className="text-[12.5px] font-medium text-ink">{t("fnd.dismiss.title")}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
        {t("fnd.dismiss.lead")}
      </p>
      {isCritical ? (
        <p className="mt-2 rounded border-l-2 border-alert bg-alert-tint px-2.5 py-2 text-[12px] leading-relaxed text-ink">
          {t("fnd.dismiss.criticalNote")}
        </p>
      ) : null}
      <label
        className="mt-3 block font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute"
        htmlFor={`fnd-reason-${finding.key}`}
      >
        {t("fnd.dismiss.reasonLabel")}
      </label>
      <textarea
        id={`fnd-reason-${finding.key}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder={t("fnd.dismiss.reasonPlaceholder")}
        className="mt-1 w-full resize-y rounded-md border border-rule bg-surface px-2.5 py-2 text-[12.5px] text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
      />
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-ink-mute">
        {t("fnd.dismiss.scope", { rule: finding.ruleKey, scope: scopeKeyOf(finding) })}
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="submit"
          disabled={!ready}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-[12px] font-medium text-paper transition-colors hover:bg-brand-d disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="fnd-dismiss-confirm"
        >
          {t("fnd.dismiss.confirm")}
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          <RotateCcw size={13} strokeWidth={1.8} />
          {t("fnd.dismiss.cancel")}
        </button>
      </div>
    </form>
  );
}
