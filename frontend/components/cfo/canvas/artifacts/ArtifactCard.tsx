// THE ARTIFACTS — THE CARD. Every artifact wears this.
//
// Title · the artifact · a CITATION FOOTER · actions. The footer is the
// part that is not negotiable: an artifact without a period, a snapshot
// and a source is a picture of a number, and a picture of a number is
// exactly what this product exists not to produce. So the footer is
// rendered by the CARD, from the EVIDENCE, and no artifact body can
// suppress it or supply its own.
//
// The refine bar sits under the actions and is the loop that makes the
// surface feel alive: type "make it quarterly", the artifact regenerates
// in place, a version is pushed, and undo is one click away. A reshape
// never leaves the browser (see `artifactRefine`), so the common refines
// are instant and free.

import { ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  Pin,
  Wand2,
} from "lucide-react";

import { AmountGroup } from "@/components/instrument/Amount";

import "./artifactI18n";
import { artifactLabel } from "./artifactI18n";
import type { ArtifactKind, ArtifactSpec } from "./artifactSpec";
import {
  presentValues,
  type ArtifactCitation,
  type ResolvedArtifact,
  type ResolvedFigure,
} from "./artifactResolve";
import {
  applyRefine,
  canRedo,
  canUndo,
  currentVersion,
  planRefine,
  redo,
  undo,
  type ArtifactHistory,
  type RefinePlan,
} from "./artifactRefine";
import { ArtifactReveal } from "./ArtifactReveal";

// ══════════════════════════════════════════════════════════════════════
// CITATION FOOTER
// ══════════════════════════════════════════════════════════════════════

export function ArtifactCitationFooter({ citation }: { citation: ArtifactCitation }) {
  const { t } = useTranslation();
  const periodLabel =
    citation.periods.length === 1
      ? t("artifact.citation.period_one")
      : t("artifact.citation.period_other");
  const periods = citation.periods.map((p) => p.label).filter(Boolean);

  return (
    <footer
      data-testid="artifact-citation"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-mute"
    >
      {periods.length > 0 && (
        <span data-citation="period">
          <span className="text-ink-faint">{periodLabel}&nbsp;</span>
          <span className="tabular-nums text-ink-soft">{periods.join(" · ")}</span>
        </span>
      )}
      {citation.snapshots.length > 0 && (
        <span data-citation="snapshot">
          <span className="text-ink-faint">{t("artifact.citation.snapshot")}&nbsp;</span>
          <span className="tabular-nums text-ink-soft">{citation.snapshots.join(" · ")}</span>
        </span>
      )}
      <span data-citation="source">
        <span className="text-ink-faint">{t("artifact.citation.source")}&nbsp;</span>
        <span className="text-ink-soft">
          {citation.sources.length > 0
            ? citation.sources.join(" · ")
            : t("artifact.citation.noSource")}
        </span>
      </span>
      {citation.trust && (
        <span data-citation="trust">
          <span className="text-ink-faint">{t("artifact.citation.trust")}&nbsp;</span>
          <span className="text-ink-soft">{citation.trust}</span>
        </span>
      )}
      {citation.incomplete && (
        <span data-citation="incomplete" className="text-caution">
          {t("artifact.citation.incomplete")}
        </span>
      )}
    </footer>
  );
}

// ══════════════════════════════════════════════════════════════════════
// ACTIONS
// ══════════════════════════════════════════════════════════════════════

export interface ArtifactActions {
  /** Export handler; absent hides the button rather than showing a
   *  control that does nothing. */
  onExport?: () => void;
  onPin?: () => void;
  onCopy?: () => void;
  pinned?: boolean;
  exporting?: boolean;
}

function ActionButton({
  label,
  onClick,
  icon,
  active,
  disabled,
  testId,
}: {
  label: string;
  onClick?: () => void;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled || !onClick}
      aria-pressed={active === undefined ? undefined : active}
      className={`inline-flex items-center gap-1.5 rounded-sm border border-rule px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.06em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-brand/40 bg-brand-tint text-brand-d"
          : "bg-transparent text-ink-soft hover:border-rule-strong hover:text-ink"
      }`}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════════
// THE CARD
// ══════════════════════════════════════════════════════════════════════

export interface ArtifactCardProps {
  artifact: ResolvedArtifact;
  history?: ArtifactHistory;
  onHistoryChange?: (next: ArtifactHistory) => void;
  /** Called when a refine needs the facts gateway. The card has already
   *  pushed nothing — the caller owns the round trip and pushes the new
   *  version when the evidence lands. */
  onRetrieve?: (ask: string, plan: RefinePlan) => void;
  actions?: ArtifactActions;
  /** The evidence panel body, when the host has one to show. */
  evidence?: ReactNode;
  /** Every figure the body will render. Supplied by the artifact
   *  component (it holds the RESOLVED body; `ResolvedArtifact` carries
   *  only the spec and the citation) so the card can put one
   *  `<AmountGroup>` around the lot. */
  figures?: readonly ResolvedFigure[];
  children: ReactNode;
}

const KIND_KEY: Record<ArtifactKind, string> = {
  chart: "artifact.kind.chart",
  table: "artifact.kind.table",
  spreadsheet: "artifact.kind.spreadsheet",
  slide: "artifact.kind.slide",
  document: "artifact.kind.document",
  scenario: "artifact.kind.scenario",
  comparison: "artifact.kind.comparison",
  finding: "artifact.kind.finding",
};

export function ArtifactCard({
  artifact,
  history,
  onHistoryChange,
  onRetrieve,
  actions,
  evidence,
  figures,
  children,
}: ArtifactCardProps) {
  const { t } = useTranslation();
  const [refineText, setRefineText] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const spec: ArtifactSpec = history ? currentVersion(history).spec : artifact.spec;

  // ONE magnitude across the whole artifact. Without this a table can
  // print "15,1 M€" beside "41.944,6 €" and both are correct — which is
  // exactly the readability failure `AmountGroup` exists to remove.
  const groupValues = useMemo(() => presentValues(figures ?? []), [figures]);

  const submitRefine = useCallback(() => {
    const text = refineText.trim();
    if (!text || !history || !onHistoryChange) return;
    const cur = currentVersion(history);
    const plan = planRefine(cur.spec, cur.refine, text);
    if (plan.mode === "refused") {
      setRefusal(t(plan.reasonKey));
      return;
    }
    setRefusal(null);
    if (plan.mode === "retrieve") {
      onRetrieve?.(plan.ask, plan);
      setRefineText("");
      return;
    }
    onHistoryChange(applyRefine(history, plan, text));
    setRefineText("");
  }, [refineText, history, onHistoryChange, onRetrieve, t]);

  const doCopy = useCallback(() => {
    actions?.onCopy?.();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [actions]);

  const versionCount = history ? history.versions.length : 1;
  const versionIndex = history ? history.cursor + 1 : 1;

  return (
    <AmountGroup values={groupValues}>
      <section
        data-testid="artifact-card"
        data-artifact-kind={spec.kind}
        className="overflow-hidden rounded-md border border-rule bg-surface"
      >
        <ArtifactReveal index={0}>
          <header className="flex items-start justify-between gap-3 px-4 pb-2 pt-3">
            <div className="min-w-0">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
                {t(KIND_KEY[spec.kind])}
                {versionCount > 1 && (
                  <span data-testid="artifact-version" className="ml-2 text-ink-faint">
                    {t("artifact.refine.versionOf", { n: versionIndex, total: versionCount })}
                  </span>
                )}
              </div>
              <h3
                data-testid="artifact-title"
                className="truncate text-[15px] font-semibold leading-snug text-ink"
              >
                {artifactLabel(t, spec.title)}
              </h3>
            </div>
            {history && onHistoryChange && (
              <div className="flex shrink-0 items-center gap-1">
                <ActionButton
                  testId="artifact-undo"
                  label={t("artifact.action.undo")}
                  icon={<ChevronLeft size={12} />}
                  disabled={!canUndo(history)}
                  onClick={() => onHistoryChange(undo(history))}
                />
                <ActionButton
                  testId="artifact-redo"
                  label={t("artifact.action.redo")}
                  icon={<ChevronRight size={12} />}
                  disabled={!canRedo(history)}
                  onClick={() => onHistoryChange(redo(history))}
                />
              </div>
            )}
          </header>
        </ArtifactReveal>

        <ArtifactReveal index={1}>
          <div data-testid="artifact-body" className="px-4 pb-3">
            {children}
          </div>
        </ArtifactReveal>

        <ArtifactReveal index={2}>
          <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2">
            {history && onHistoryChange && (
              <ActionButton
                testId="artifact-refine"
                label={t("artifact.action.refine")}
                icon={<Wand2 size={12} />}
                onClick={() => inputRef.current?.focus()}
              />
            )}
            {actions?.onExport && (
              <ActionButton
                testId="artifact-export"
                label={actions.exporting ? t("artifact.export.building") : t("artifact.action.export")}
                icon={<Download size={12} />}
                disabled={actions.exporting}
                onClick={actions.onExport}
              />
            )}
            {actions?.onPin && (
              <ActionButton
                testId="artifact-pin"
                label={actions.pinned ? t("artifact.action.pinned") : t("artifact.action.pin")}
                icon={<Pin size={12} />}
                active={actions.pinned}
                onClick={actions.onPin}
              />
            )}
            {actions?.onCopy && (
              <ActionButton
                testId="artifact-copy"
                label={copied ? t("artifact.action.copied") : t("artifact.action.copy")}
                icon={<Copy size={12} />}
                onClick={doCopy}
              />
            )}
            {evidence && (
              <ActionButton
                testId="artifact-evidence"
                label={showEvidence ? t("artifact.action.hideEvidence") : t("artifact.action.evidence")}
                icon={showEvidence ? <EyeOff size={12} /> : <Eye size={12} />}
                active={showEvidence}
                onClick={() => setShowEvidence((v) => !v)}
              />
            )}
          </div>
        </ArtifactReveal>

        {showEvidence && evidence && (
          <div
            data-testid="artifact-evidence-panel"
            className="border-t border-rule bg-bg-2 px-4 py-3"
          >
            {evidence}
          </div>
        )}

        {history && onHistoryChange && (
          <div className="border-t border-rule px-4 py-2">
            <input
              ref={inputRef}
              data-testid="artifact-refine-input"
              value={refineText}
              onChange={(e) => {
                setRefineText(e.target.value);
                if (refusal) setRefusal(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitRefine();
                }
              }}
              placeholder={t("artifact.refine.placeholder")}
              aria-label={t("artifact.action.refine")}
              className="w-full bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint"
            />
            {refusal && (
              <p data-testid="artifact-refine-refusal" className="pt-1 text-[11px] text-caution">
                {refusal}
              </p>
            )}
          </div>
        )}

        <ArtifactCitationFooter citation={artifact.citation} />
      </section>
    </AmountGroup>
  );
}
