// Reference-format Balance Sheet renderer.
//
// Layout (4-column grid):
//   [label + account code] [opening 01.01] [closing 31.12] [Δ delta]
//
// Same visual language as PLStatementView: monospace + tabular-nums for
// digit alignment, uppercase tracked section headers, double-line borders
// around TOTAL ASSETS and TOTAL EQUITY & LIABILITIES, contra-asset rows
// (accumulated depreciation) in parens.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BSStatement, BSSection, BSLine } from "@/lib/bsStructure";
import { canonicalMetaFromBs, type BSCanonicalMeta } from "@/lib/buildBsStatement";
import { cfoApi, extractCanonicalBsFromReconcile } from "@/lib/cfoApi";
import { queryClient } from "@/lib/queryClient";
import { periodQueryKey } from "@/lib/activePeriod";
import "./bsCanonicalStatusI18n";
import { useAmountFormatter, useDisplayCurrency } from "@/stores/currency";
import { TRACEABLE_TARGET_ATTR } from "@/lib/traceableSource";
import { useHighlightFromUrl } from "./useHighlightFromUrl";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { LearnableRowLabel } from "@/components/learning/LearnableRowLabel";
import { bucketToConcept } from "@/lib/learning/bucketToConcept";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { BalanceSheetMap } from "@/components/learning/BalanceSheetMap";
import { BALANCE_SHEET_GUIDE } from "@/components/learning/balanceSheetGuide";
import { AccountChip, splitAccountParen, StatementCurrencyChip } from "./AccountChip";
import "./bsStatementView.css";

interface Props {
  /** View-model from buildBSStatement — `canonical` present iff the period
   *  carried canonical_bs (engine pass-through; drives the status strip). */
  statement: BSStatement & { canonical?: BSCanonicalMeta };
  /** Hide the inline "Guide me" button (dashboard consolidates guides). */
  hideGuide?: boolean;
  /** Active period id — required for the undo POST on the canonical
   *  status strip. Falls back to the `?period=` URL param when absent
   *  (the app threads the active period through the URL). */
  periodId?: string | null;
}

export function BSStatementView({ statement, hideGuide = false, periodId }: Props) {
  useHighlightFromUrl();
  const { t } = useTranslation();
  // 2026-05-24 — currency-aware formatting. `fmt(value)` converts the
  // value from statement.currency to the user's current display currency
  // and formats in the appropriate locale (no symbol — header chip
  // already shows it). `display` is the active display currency code
  // for the header.
  const fmt = useAmountFormatter(statement.currency);
  const display = useDisplayCurrency();

  return (
    <div className={statement.note ? "lg:grid lg:grid-cols-[minmax(0,820px)_minmax(340px,440px)] lg:gap-5 lg:items-start lg:justify-center" : ""}>
      <div className="bs-statement" data-testid="bs-statement">
      <div className="bs-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>{t("statements.bs.title")} — {statement.entity} ({display})</span>
          <StatementCurrencyChip currency={statement.currency} />
        </span>
        {!hideGuide && (
          <GuideMeButton
            pageId="balance-sheet"
            title="Balance Sheet"
            steps={BALANCE_SHEET_GUIDE}
          />
        )}
      </div>

      {/* F5.0 Wave 3 — Balance Sheet Map: compact learning rail above the table. */}
      <BalanceSheetMap />

      {/* canonical_bs v2 — engine balance status strip. Rendered verbatim
          from the object's status/difference/diagnosis; the FE derives only
          the % readout (difference / totals.assets — the one computation the
          contract sanctions for display). */}
      {statement.canonical && (
        <BsCanonicalStatusStrip
          meta={statement.canonical}
          currency={statement.currency}
          periodId={periodId}
        />
      )}

      {/* Column header row */}
      <div className="bs-col-header">
        <span />
        <span>{statement.comparativeDate}</span>
        <span>{statement.asOf}</span>
        <span>Δ</span>
      </div>

      {/* ASSETS */}
      <div className="bs-section-title" data-guide="bs-assets">{t("statements.bs.assets")}</div>
      {statement.assetSections.map((section, i) => (
        <BSSectionView key={`a-${i}`} section={section} currency={statement.currency} />
      ))}
      <div
        className="bs-total-row"
        data-guide="bs-total-assets"
        data-learnable-row="true"
        {...{ [TRACEABLE_TARGET_ATTR]: "totalAssets" }}
      >
        <span className="bs-total-label">
          <LearnableRowLabel
            conceptKey="total_assets"
            value={statement.totalAssets.closing}
            data-testid="bs-total-assets-label"
          >
            {t("statements.bs.totalAssets")}
          </LearnableRowLabel>
        </span>
        <LearnableNumber conceptKey="total_assets" value={statement.totalAssets.opening} className="bs-amount" block>
          {fmt(statement.totalAssets.opening)}
        </LearnableNumber>
        <LearnableNumber conceptKey="total_assets" value={statement.totalAssets.closing} className="bs-amount" block>
          {fmt(statement.totalAssets.closing)}
        </LearnableNumber>
        <span className="bs-delta">{formatDelta(statement.totalAssets.delta, fmt)}</span>
      </div>

      {/* EQUITY & LIABILITIES */}
      <div className="bs-section-title" data-guide="bs-equity">{t("statements.bs.equityLiab")}</div>
      <div data-guide="bs-liabilities" />
      {statement.equityLiabSections.map((section, i) => (
        <BSSectionView key={`el-${i}`} section={section} currency={statement.currency} />
      ))}
      <div
        className="bs-total-row"
        data-learnable-row="true"
        {...{ [TRACEABLE_TARGET_ATTR]: "totalLiabilitiesAndEquity" }}
      >
        <span className="bs-total-label">
          <LearnableRowLabel
            conceptKey="total_equity_liab"
            value={statement.totalEquityLiab.closing}
            data-testid="bs-total-equity-liab-label"
          >
            {t("statements.bs.totalEquityLiab")}
          </LearnableRowLabel>
        </span>
        <LearnableNumber conceptKey="total_equity_liab" value={statement.totalEquityLiab.opening} className="bs-amount" block>
          {fmt(statement.totalEquityLiab.opening)}
        </LearnableNumber>
        <LearnableNumber conceptKey="total_equity_liab" value={statement.totalEquityLiab.closing} className="bs-amount" block>
          {fmt(statement.totalEquityLiab.closing)}
        </LearnableNumber>
        <span className="bs-delta">{formatDelta(statement.totalEquityLiab.delta, fmt)}</span>
      </div>

      {/* Balance check — legacy path only. On canonical periods the engine
          status strip above is the single verdict; the local >1 RON
          heuristic must not second-guess the engine's tolerance bands. */}
      {!statement.canonical && Math.abs(statement.balanceCheck) > 1 && (
        <div className="bs-imbalance-warning">
          ⚠ {t("statements.bs.drift")}: {display} {fmt(statement.balanceCheck)}.
        </div>
      )}
      </div>
      {/* Note — moved OUTSIDE the .bs-statement bordered card (2026-07-25), to
          its right (a sibling in the grid). */}
      {statement.note && (
        <aside className="mt-4 lg:mt-0">
          <section className="rounded-2xl border border-rule bg-surface p-4" data-testid="bs-note">
            <p className="text-[12px] text-ink-soft leading-relaxed">
              <strong className="text-ink">{t("statements.bs.note")}.</strong> {statement.note}
            </p>
          </section>
        </aside>
      )}
    </div>
  );
}

function BSSectionView({ section, currency }: { section: BSSection; currency: string }) {
  // Hook BEFORE the empty-section bail-out (2026-07-26): this used to sit
  // under it, so a re-render in which a section lost its lines ran one fewer
  // hook than the previous render and React threw "Rendered fewer hooks than
  // expected" — which is what crashed the dashboard on switching to a period
  // with no trial balance behind it.
  const fmt = useAmountFormatter(currency);
  if (section.lines.length === 0 && !section.subtotalLabel) return null;
  const subtotalAttrs = section.subtotalBucket
    ? { [TRACEABLE_TARGET_ATTR]: section.subtotalBucket }
    : {};
  const subtotalConceptKey = bucketToConcept(section.subtotalBucket);
  return (
    <div className="bs-section">
      {section.header && <div className="bs-section-header">{section.header}</div>}
      {section.lines.map((line, i) => (
        <BSLineView key={i} line={line} currency={currency} />
      ))}
      {section.subtotalLabel && (
        <>
          <div className="bs-subtotal-rule" />
          <div
            className="bs-row bs-subtotal"
            {...subtotalAttrs}
            {...(subtotalConceptKey ? { "data-learnable-row": "true" } : {})}
          >
            <span className="bs-label">
              {subtotalConceptKey ? (
                <LearnableRowLabel
                  conceptKey={subtotalConceptKey}
                  value={section.subtotalClosing ?? 0}
                  data-testid={`bs-subtotal-label-${subtotalConceptKey}`}
                >
                  {section.subtotalLabel}
                </LearnableRowLabel>
              ) : (
                section.subtotalLabel
              )}
            </span>
            {subtotalConceptKey ? (
              <>
                <LearnableNumber
                  conceptKey={subtotalConceptKey}
                  value={section.subtotalOpening ?? 0}
                  className="bs-amount"
                  block
                >
                  {fmt(section.subtotalOpening)}
                </LearnableNumber>
                <LearnableNumber
                  conceptKey={subtotalConceptKey}
                  value={section.subtotalClosing ?? 0}
                  className="bs-amount"
                  block
                >
                  {fmt(section.subtotalClosing)}
                </LearnableNumber>
              </>
            ) : (
              <>
                <span className="bs-amount">{fmt(section.subtotalOpening)}</span>
                <span className="bs-amount">{fmt(section.subtotalClosing)}</span>
              </>
            )}
            <span className="bs-delta">{formatDelta(section.subtotalDelta ?? 0, fmt)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function BSLineView({ line, currency }: { line: BSLine; currency: string }) {
  const fmt = useAmountFormatter(currency);
  const { t } = useTranslation();
  const lineAttrs = line.bucket ? { [TRACEABLE_TARGET_ATTR]: line.bucket } : {};
  const conceptKey = bucketToConcept(line.bucket);

  if (line.style === "subtotal") {
    return (
      <>
        <div className="bs-subtotal-rule" />
        <div
          className="bs-row bs-subtotal"
          {...lineAttrs}
          {...(conceptKey ? { "data-learnable-row": "true" } : {})}
        >
          <span className="bs-label">
            {conceptKey ? (
              <LearnableRowLabel
                conceptKey={conceptKey}
                value={line.closing ?? 0}
                data-testid={`bs-subtotal-line-${conceptKey}`}
              >
                {line.label}
              </LearnableRowLabel>
            ) : (
              line.label
            )}
          </span>
          {conceptKey ? (
            <>
              <LearnableNumber
                conceptKey={conceptKey}
                value={line.opening ?? 0}
                className="bs-amount"
                block
              >
                {fmt(line.opening)}
              </LearnableNumber>
              <LearnableNumber
                conceptKey={conceptKey}
                value={line.closing ?? 0}
                className="bs-amount"
                block
              >
                {fmt(line.closing)}
              </LearnableNumber>
            </>
          ) : (
            <>
              <span className="bs-amount">{fmt(line.opening)}</span>
              <span className="bs-amount">{fmt(line.closing)}</span>
            </>
          )}
          <span className="bs-delta">
            {formatDelta((line.closing ?? 0) - (line.opening ?? 0), fmt)}
          </span>
        </div>
      </>
    );
  }

  // Account code renders AFTER the label as a muted chip. Labels that carry
  // a pure code list baked in by the builder are split; prose parens stay.
  // Chip suppressed when it would just repeat the label verbatim.
  const split = line.accountCode ? null : splitAccountParen(line.label);
  const labelText = split?.code ? split.text : line.label;
  const rawChip = line.accountCode ?? split?.code;
  const chipCode = rawChip && rawChip !== labelText.trim() ? rawChip : undefined;

  // Contra-asset rows (accumulated depreciation, etc.) render in parens.
  // Use the formatter's `paren` opt for negatives; for absolute values
  // wrap manually since the source data may carry the negative pre-applied.
  const openingFmt = line.isContra
    ? `(${fmt(Math.abs(line.opening ?? 0))})`
    : fmt(line.opening);
  const closingFmt = line.isContra
    ? `(${fmt(Math.abs(line.closing ?? 0))})`
    : fmt(line.closing);
  const deltaValue = line.delta ?? (line.closing ?? 0) - (line.opening ?? 0);

  return (
    <div
      className={`bs-row bs-row-item ${line.isContra ? "bs-contra" : ""}`}
      {...lineAttrs}
      {...(conceptKey ? { "data-learnable-row": "true" } : {})}
    >
      <span className="bs-label">
        {conceptKey ? (
          <LearnableRowLabel
            conceptKey={conceptKey}
            value={line.closing ?? 0}
            data-testid={`bs-row-label-${conceptKey}`}
          >
            {labelText}
          </LearnableRowLabel>
        ) : (
          labelText
        )}
        <AccountChip code={chipCode} />
        {/* RECONCILIATION FLOW — the synthetic "Diferențe de reconciliere"
            row carries a visible marker + tooltip (rationale · origin ·
            timestamp) so the adjusting entry can never pass as a source
            figure. */}
        {line.synthetic && (
          <span
            className="ml-1 inline-block align-middle text-amber-600 dark:text-amber-400"
            style={{ fontSize: "9px", lineHeight: 1 }}
            data-testid="bs-synthetic-marker"
            title={line.syntheticNote}
            role="img"
            aria-label={t("bsCanonical.reconcile.syntheticRowAria")}
          >
            ●
          </span>
        )}
      </span>
      {conceptKey ? (
        <>
          <LearnableNumber
            conceptKey={conceptKey}
            value={line.opening ?? 0}
            className="bs-amount"
            block
          >
            {openingFmt}
          </LearnableNumber>
          <LearnableNumber
            conceptKey={conceptKey}
            value={line.closing ?? 0}
            className="bs-amount"
            block
          >
            {closingFmt}
          </LearnableNumber>
        </>
      ) : (
        <>
          <span className="bs-amount">{openingFmt}</span>
          <span className="bs-amount">{closingFmt}</span>
        </>
      )}
      <span className="bs-delta">{formatDelta(deltaValue, fmt)}</span>
    </div>
  );
}

// ─── AUTO-RECONCILE (canonical status strip) ─────────────────────────────
// Contract: docs/CANONICAL_BS_V2_CONTRACT.md §"RECONCILIATION FLOW" +
// revised operator spec (2026-08-19): reconciliation is a fully automatic
// server-side stage — the client is never sent an intermediate unreconciled
// sub-threshold state and there is NO manual Reconcile action. The UI only
// renders the engine's verdict (RECONCILED is machine-distinct from
// BALANCED) and offers the reversible Undo.

/** canonical_bs v2 status strip. Engine states rendered verbatim:
 *  BALANCED (quiet confirmation), RECONCILED (calm green Balanced-family
 *  chip + "auto-adjusted" micro-caption; tap reveals a one-line receipt +
 *  Undo), MINOR_DRIFT with `needs_review` (calm amber "Needs manual
 *  mapping" panel — the auto stage rejected the fix), MINOR_DRIFT plain
 *  (amber, exact signed difference), MATERIAL_IMBALANCE (blocking red
 *  alert with the D0–D8 diagnosis list — never reads as "all good").
 *  Exported for tests. */
export function BsCanonicalStatusStrip({
  meta,
  currency,
  periodId,
}: {
  meta: BSCanonicalMeta;
  currency: string;
  periodId?: string | null;
}) {
  const { t } = useTranslation();
  const fmt = useAmountFormatter(currency);
  const display = useDisplayCurrency();

  // Resolve the active period: explicit prop first, `?period=` URL param
  // as the app-wide fallback (the URL is the source of truth for the
  // active period across pages).
  const pid =
    periodId ??
    (typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("period")
      : null);

  // Local override of the server meta after the undo POST — the response's
  // canonical_bs replaces the strip's state instantly (the honest raw
  // imbalance) while resetQueries refetches the full period (rows without
  // the synthetic entry). Cleared whenever the server meta itself changes.
  const [live, setLive] = useState<BSCanonicalMeta | null>(null);
  // Tap-receipt visibility on the RECONCILED chip. The toggle is an
  // instant conditional render (no staged animation), so it satisfies
  // prefers-reduced-motion by construction.
  const [receiptOpen, setReceiptOpen] = useState(false);
  const metaKey = `${meta.status}|${meta.difference}|${meta.needsReview}|${
    meta.reconciliation?.applied_at ?? ""
  }`;
  useEffect(() => {
    setLive(null);
    setReceiptOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaKey]);
  const m = live ?? meta;

  const [undoBusy, setUndoBusy] = useState(false);
  const [errorNote, setErrorNote] = useState<string | null>(null);

  async function onUndo() {
    if (!pid || undoBusy) return;
    setErrorNote(null);
    setUndoBusy(true);
    try {
      const resp = await cfoApi.undoReconcilePeriod(pid);
      const next = extractCanonicalBsFromReconcile(resp);
      // Response carries the raw pre-reconciliation state — the TRUE
      // source imbalance, rendered honestly (the server suppresses
      // re-auto-reconcile for this content_hash+versions after an
      // explicit undo). Without a parsable body, fall back to the
      // server meta + refetch.
      setLive(next ? canonicalMetaFromBs(next) : null);
      void queryClient.resetQueries({ queryKey: periodQueryKey(pid) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : null;
      setErrorNote(
        `${t("bsCanonical.reconcile.undoFailed")}${msg ? ` ${msg}` : ""}`,
      );
    } finally {
      setUndoBusy(false);
    }
  }

  const pct =
    m.totalAssets !== 0 ? (Math.abs(m.difference) / Math.abs(m.totalAssets)) * 100 : 0;

  // RECONCILED — calm green Balanced-family chip + subtle "auto-adjusted"
  // micro-caption. Tapping the chip toggles the one-line receipt + Undo.
  if (m.status === "RECONCILED") {
    const rec = m.reconciliation;
    const moved = Math.abs(rec?.applied_delta ?? rec?.original_difference ?? 0);
    const movedStr = `${display} ${fmt(moved)}`;
    const placementLabel = t(
      rec?.placement === "pnl"
        ? "bsCanonical.reconcile.placementPnl"
        : "bsCanonical.reconcile.placementBs",
    );
    const originLabel = t(
      rec?.origin === "llm_proposed"
        ? "bsCanonical.reconcile.originLlm"
        : "bsCanonical.reconcile.originDeterministic",
    );
    return (
      <div
        className="mb-3 rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-3 py-2 text-[12px]"
        data-testid="bs-status-reconciled"
      >
        <button
          type="button"
          data-testid="bs-reconciled-chip"
          onClick={() => setReceiptOpen((o) => !o)}
          aria-expanded={receiptOpen}
          aria-label={t("bsCanonical.reconcile.receiptToggleAria")}
          className="flex w-full flex-wrap items-baseline gap-x-2 text-left"
        >
          <span className="inline-flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400"
            />
            ✓ {t("bsCanonical.balanced")}
          </span>
          <span
            className="text-[11px] text-ink-mute"
            data-testid="bs-auto-adjusted-caption"
          >
            {t("bsCanonical.reconcile.autoAdjusted", { amount: movedStr })}
          </span>
        </button>
        {receiptOpen && (
          <div className="mt-1 text-ink-soft" data-testid="bs-reconcile-receipt">
            {t("bsCanonical.reconcile.receipt", {
              amount: movedStr,
              placement: placementLabel,
              origin: originLabel,
            })}
            {" · "}
            <button
              type="button"
              data-testid="bs-reconcile-undo"
              onClick={onUndo}
              disabled={undoBusy || !pid}
              aria-busy={undoBusy}
              className="underline underline-offset-2 hover:text-ink disabled:opacity-50"
            >
              {t("bsCanonical.reconcile.undo")}
            </button>
          </div>
        )}
        {errorNote && (
          <p className="mt-1.5 text-[12px] text-ink-soft" data-testid="bs-reconcile-error">
            {errorNote}
          </p>
        )}
      </div>
    );
  }

  // needs_review — the automatic stage ran and was rejected (validator
  // refused a non-exact close / diagnosis inconclusive): honest imbalance
  // plus a calm amber "Needs manual mapping" panel with the diagnosis
  // line. No button, no modal — mapping is the fix, not a retry.
  if (m.status === "MINOR_DRIFT" && m.needsReview) {
    const diagLine = m.diagnosis
      .map((d) => [d.code, d.detail].filter(Boolean).join(" — "))
      .join("; ");
    return (
      <div
        className="mb-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[12px]"
        data-testid="bs-status-needs-review"
      >
        <span className="font-medium text-amber-700 dark:text-amber-400">
          {t("bsCanonical.reconcile.needsReview")}
        </span>
        <p className="mt-0.5 text-ink-soft">
          {t("bsCanonical.difference")}: {display} {fmt(m.difference)} (
          {pct.toFixed(2)}%){diagLine ? ` · ${diagLine}` : ""}
        </p>
        <p className="mt-0.5 text-ink-soft">
          {t("bsCanonical.reconcile.needsReviewBody")}
        </p>
      </div>
    );
  }

  if (m.status === "BALANCED") {
    return (
      <div
        className="mb-3 rounded-lg border border-rule bg-surface px-3 py-2 text-[12px] text-ink-soft"
        data-testid="bs-status-balanced"
      >
        ✓ {t("bsCanonical.balanced")}
      </div>
    );
  }

  // MINOR_DRIFT without a reconcile offer — unchanged rendering.
  if (m.status === "MINOR_DRIFT") {
    return (
      <div
        className="mb-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400"
        data-testid="bs-status-minor-drift"
      >
        {t("bsCanonical.minorDrift")} — {t("bsCanonical.difference")}: {display}{" "}
        {fmt(m.difference)} ({pct.toFixed(2)}%)
      </div>
    );
  }

  // MATERIAL_IMBALANCE — visually blocking: red, role="alert", diagnosis
  // list. Non-dismissible by construction (no dismiss affordance exists).
  return (
    <div
      className="mb-3 rounded-xl border-2 border-red-600 bg-red-600/10 p-4 text-[13px] text-red-700 dark:text-red-400"
      role="alert"
      data-testid="bs-status-material-imbalance"
    >
      <strong className="block text-[14px]">⚠ {t("bsCanonical.material")}</strong>
      <p className="mt-1">{t("bsCanonical.materialBody")}</p>
      <p className="mt-1 font-mono tabular-nums">
        {t("bsCanonical.difference")}: {display} {fmt(m.difference)} ({pct.toFixed(2)}%)
      </p>
      {m.diagnosis.length > 0 && (
        <div className="mt-2">
          <span className="font-semibold">{t("bsCanonical.diagnosis")}:</span>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">
            {m.diagnosis.map((d, i) => (
              <li key={`${d.code}-${i}`}>
                <span className="font-mono text-[12px]">{d.code}</span> — {d.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Delta column formatter. Δ shows the change in display currency, no
 *  decimals (deltas are coarse-grained). Uses the same fmt() to ensure
 *  the converted value uses the user's display currency. */
function formatDelta(value: number, fmt: (v: number | null | undefined, o?: { signed?: boolean; sign?: "positive" | "negative"; paren?: boolean }) => string): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.5) return "0";
  // Use signed mode to force +/−, the formatter handles currency conversion
  return fmt(value, { sign: value > 0 ? "positive" : "negative" });
}
