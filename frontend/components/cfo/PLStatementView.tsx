// Reference-format P&L renderer.
//
// Produces the visible P&L for the financial-statements tab: labels with
// their account chips, amounts right-aligned with tabular-nums, EBITDA as a
// block total, financial items with explicit ± signs, key margins below.
//
// THE ONE EBITDA (owner ruling 2026-09-26). The statement it is handed is
// built on the engine's SERVED figures (lib/buildPlStatement.ts). This view
// prints them and computes nothing: "Variația stocurilor de produse" (711)
// sits right after the cost block, signed, with the engine's provenance
// sentence under it; own work capitalised (72x) is an operating line
// outside turnover; the engine's reconciliation line stands under EBITDA;
// and a figure the engine refused prints its typed reason — never a zero,
// never a bare dash. The Romanian names stay in the English UI, with the
// engine's English gloss beside them (CLAUDE.md §11).
//
// All visual conventions live in the .pl-* classes — see plStatementView.css.

import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PLStatement, PLSection, PLSectionRole, PLLine, RoName } from "@/lib/plStructure";
import { pickLang, type ServedOneEbitda, type ServedRefusal } from "@/lib/servedOneEbitda";
import { formatPercent } from "@/lib/formatRon";
import { useAmountFormatter, useDisplayCurrency } from "@/stores/currency";
// THE DIAL — Simple mode opens statements totals-first: item rows hide
// behind "Show all lines", labels with a glossary match get the <Term>
// plain-language affordance. Pro renders exactly what exists today
// (every branch below is gated on useIsSimple; values never change).
import { useIsSimple } from "@/lib/viewMode";
import { Term } from "@/components/instrument/Term";
import { ShowAllLinesToggle } from "@/components/cfo/simple/ShowAllLines";
import { SimpleTermLabel } from "@/components/cfo/simple/SimpleTermLabel";
import { termForRow } from "@/components/cfo/simple/termForRow";
import { TRACEABLE_TARGET_ATTR } from "@/lib/traceableSource";
import { useHighlightFromUrl } from "./useHighlightFromUrl";
import {
  CmpCells,
  CmpColumnHeader,
  ComparativeDefinitionProvider,
  SHARE_ONLY_COLUMNS,
  activeColumnCount,
  cmpColumnTemplate,
  useComparativeContext,
  useShareOnlyContext,
} from "./ComparativeCells";
import { sourceDocumentLine } from "@/lib/comparatives";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { bucketToConcept } from "@/lib/learning/bucketToConcept";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { PL_GUIDE } from "@/components/learning/pageGuides";
import { AccountChip, splitAccountParen, StatementCurrencyChip } from "./AccountChip";
import "./plStatementView.css";

/**
 * THE REFERENCE LAYOUT'S SECTIONS, BY ROLE.
 *
 * Both RO builders insert an OTHER OPERATING INCOME section after net
 * turnover whenever the book carries one — most books — and, where the
 * period carries them, the own-work-capitalised (72x) and stock-variation
 * (711) sections around the cost block. This
 * view used to read the sections by INDEX, `[revenue, opex, d&a,
 * financial, closing]`, so on such a book the 758 section took the
 * operating-expenses slot, the EBITDA box landed between it and the
 * operating expenses, and the sixth section — profit before tax, income
 * tax, net profit — was never rendered at all. Sections that name their
 * `role` are now placed by it. A statement that names none keeps the old
 * positional reading, unchanged: that is the public-company adapter, whose
 * SIX sections (revenue, cost of revenue, operating expenses, EBIT,
 * financial items, net profit) this reading mis-places the same way — its
 * NET PROFIT section is not rendered either. That page is a separate fix:
 * its operating expenses include D&A, so the EBITDA box has no place in
 * its structure that this layout could choose for it.
 */
function plLayout(sections: readonly PLSection[]): {
  operatingRevenue?: PLSection;
  otherOperatingIncome?: PLSection;
  capitalizedOwnWork?: PLSection;
  operatingExpenses?: PLSection;
  stockVariation?: PLSection;
  depreciationSection?: PLSection;
  financialItems?: PLSection;
  closingSection?: PLSection;
} {
  if (sections.some((s) => s.role)) {
    const by = (role: PLSectionRole) => sections.find((s) => s.role === role);
    return {
      operatingRevenue: by("operatingRevenue"),
      otherOperatingIncome: by("otherOperatingIncome"),
      capitalizedOwnWork: by("capitalizedOwnWork"),
      operatingExpenses: by("operatingExpenses"),
      stockVariation: by("stockVariation"),
      depreciationSection: by("depreciation"),
      financialItems: by("financialItems"),
      closingSection: by("closing"),
    };
  }
  const [operatingRevenue, operatingExpenses, depreciationSection, financialItems, closingSection] = sections;
  return { operatingRevenue, operatingExpenses, depreciationSection, financialItems, closingSection };
}

interface Props {
  statement: PLStatement;
  /** Hide the inline "Guide me" button — the dashboard consolidates all tab
   *  guides into a single button in the tab bar. */
  hideGuide?: boolean;
}

export function PLStatementView({ statement, hideGuide = false }: Props) {
  useHighlightFromUrl();
  const { t, i18n } = useTranslation();
  const fmt = useAmountFormatter(statement.currency);
  const display = useDisplayCurrency();
  // COMPARATIVES — present only when the dashboard wrapped this view in a
  // <ComparativeProvider> with an engine document. The grid widens by the
  // columns the reader switched on; every cell is painted by <CmpCells>,
  // which refuses any row whose figure is not the engine's own line.
  // With NO document the grid carries ONE extra column, the period's own
  // share of net turnover (`statements.common_size`) — the share is not a
  // comparison column (owner ruling 2026-10-04).
  const cmp = useComparativeContext();
  const shareOnly = useShareOnlyContext();
  const cmpColumns = cmp ? cmp.columns : shareOnly ? SHARE_ONLY_COLUMNS : null;
  const cmpCount = cmpColumns ? activeColumnCount(cmpColumns) : 0;
  const cmpStyle = cmpColumns && cmpCount > 0
    ? ({ "--cmp-cols": cmpColumnTemplate(cmpColumns) } as React.CSSProperties)
    : undefined;
  // THE DIAL — Simple opens totals-first; "Show all lines" expands to the
  // untouched full table. keyOnly hides only `style: "item"` rows —
  // subtotal/total/boxed rows (the builder-marked headline rows) always
  // render, so every figure that remains is one the builder computed.
  const isSimple = useIsSimple();
  const [showAll, setShowAll] = useState(false);
  const keyOnly = isSimple && !showAll;

  const {
    operatingRevenue,
    otherOperatingIncome,
    capitalizedOwnWork,
    operatingExpenses,
    stockVariation,
    depreciationSection,
    financialItems,
    closingSection,
  } = plLayout(statement.sections);
  const lang = i18n.language;

  return (
    <div
      className={`pl-statement${cmpCount > 0 ? " pl-cmp" : ""}`}
      data-testid="pl-statement"
      data-comparative={cmp ? cmp.doc.prior.period_id : undefined}
      data-share-only={!cmp && shareOnly ? "true" : undefined}
      style={cmpStyle}
    >
      <div className="pl-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2>
            {t("statements.pl.title")} — {statement.entity} — {statement.period} ({display})
          </h2>
          <StatementCurrencyChip currency={statement.currency} />
        </div>
        {!hideGuide && <GuideMeButton pageId="pnl" title="P&L" steps={PL_GUIDE} />}
      </div>

      {/* THE DIAL — Simple-only disclosure toggle. Pro never renders it. */}
      {isSimple && (
        <ShowAllLinesToggle
          open={showAll}
          onToggle={() => setShowAll((v) => !v)}
          testid="pl-show-all"
        />
      )}

      {cmp && cmpCount > 0 && (
        <CmpColumnHeader
          currentLabel={cmp.doc.current.label}
          priorLabel={cmp.doc.prior.label}
          currentTitle={sourceDocumentLine(cmp.doc.current)}
          priorTitle={sourceDocumentLine(cmp.doc.prior)}
          shareLabel={t("statements.cmp.colShare")}
          columns={cmp.columns}
        />
      )}
      {!cmp && shareOnly && (
        <CmpColumnHeader
          currentLabel={statement.period}
          priorLabel=""
          shareLabel={t("statements.cmp.colShare")}
          columns={SHARE_ONLY_COLUMNS}
        />
      )}
      {/* Every row on the one EBITDA is held to a prior served on the same
          EBITDA definition as this statement (lib/comparatives.ts). */}
      <ComparativeDefinitionProvider definition={statement.served?.definition}>
      <EbitdaRefusalCtx.Provider value={statement.ebitdaRefusal?.code ?? null}>
      <div className="pl-body">
        {/* NET TURNOVER — cifra de afaceri netă */}
        <div data-guide="pl-revenue">
          {operatingRevenue && (
            <PLSectionView section={operatingRevenue} currency={statement.currency} keyOnly={keyOnly} />
          )}
        </div>

        {/* OTHER OPERATING INCOME — present only when the book carries it */}
        {otherOperatingIncome && (
          <PLSectionView section={otherOperatingIncome} currency={statement.currency} keyOnly={keyOnly} />
        )}

        {/* OWN WORK CAPITALISED (72x) — operating, outside turnover. Shown
            in Simple mode too: EBITDA below includes it. */}
        {capitalizedOwnWork && (
          <PLSectionView section={capitalizedOwnWork} currency={statement.currency} keyOnly={false} />
        )}

        {/* OPERATING EXPENSES */}
        {operatingExpenses && (
          <PLSectionView section={operatingExpenses} currency={statement.currency} keyOnly={keyOnly} />
        )}

        {/* VARIAȚIA STOCURILOR DE PRODUSE (711) — beside the cost block,
            signed as its effect on the result. Always shown, in Simple
            mode too: EBITDA below includes it. */}
        {stockVariation && (
          <PLSectionView section={stockVariation} currency={statement.currency} keyOnly={false} />
        )}

        {/* EBITDA — the engine's figure, or its refusal. */}
        <div
          className="pl-ebitda-box"
          data-guide="pl-ebitda"
          data-testid="pl-ebitda"
          {...{ [TRACEABLE_TARGET_ATTR]: "ebitda" }}
        >
          <div className="pl-row pl-total">
            <span className="pl-label">
              <SimpleTermLabel termId="ebitda">{t("statements.pl.ebitda")}</SimpleTermLabel>
            </span>
            {statement.ebitda === null ? (
              <RefusedAmount refusal={statement.ebitdaRefusal ?? null} testid="pl-ebitda-refused" />
            ) : (
              <LearnableNumber conceptKey="ebitda" value={statement.ebitda} className="pl-amount" block>
                {fmt(statement.ebitda)}
              </LearnableNumber>
            )}
            <CmpCells rowKey="ebitda" amount={statement.ebitda} />
          </div>
          {statement.ebitda === null && statement.ebitdaRefusal && (
            <RefusalNote refusal={statement.ebitdaRefusal} lang={lang} root />
          )}
          {statement.served && (
            <EbitdaBridgeLine served={statement.served} currency={statement.currency} lang={lang} />
          )}
        </div>

        {/* D&A → EBIT */}
        {depreciationSection && (
          <PLSectionView section={depreciationSection} currency={statement.currency} keyOnly={keyOnly} />
        )}

        {/* FINANCIAL ITEMS */}
        {financialItems && (
          <PLSectionView section={financialItems} currency={statement.currency} keyOnly={keyOnly} />
        )}

        {/* PBT → NET RESULT → ACCOUNT 121 */}
        <div data-guide="pl-net-profit">
          {closingSection && (
            <PLSectionView section={closingSection} currency={statement.currency} keyOnly={keyOnly} />
          )}
        </div>
      </div>
      </EbitdaRefusalCtx.Provider>
      </ComparativeDefinitionProvider>

      {/* KEY MARGINS */}
      <div className="pl-key-margins">
        <h3>{t("statements.pl.keyMargins")}</h3>
        <ul>
          {statement.keyMargins.map((m, i) => (
            <li key={i}>
              <span>{m.label}:</span>
              {m.refusal ? (
                // The engine's refusal (engine.ratios.margin_meaning), in the
                // reader's language: a margin over a negligible turnover is
                // stated as not meaningful, never printed as a percent.
                <span className="pl-margin-value" data-testid="pl-margin-refused">
                  {i18n.language?.startsWith("ro") ? m.refusal.ro : m.refusal.en}
                </span>
              ) : (
                <span className="pl-margin-value">{formatPercent(m.value)}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

    </div>
  );
}

/** A name the engine serves in Romanian: the Romanian UI prints it; the
 *  English UI prints it WITH the engine's English gloss beside it — the
 *  Romanian account name is never replaced (CLAUDE.md §11). */
function RoLabel({ roName, lang }: { roName: RoName; lang: string | undefined }) {
  const isRo = (lang ?? "").toLowerCase().startsWith("ro");
  return (
    <>
      {roName.ro}
      {!isRo && roName.glossEn ? <span className="pl-gloss"> — {roName.glossEn}</span> : null}
    </>
  );
}

/** The amount cell of a figure the engine REFUSED: a word, never a number
 *  and never a bare dash — the reason is printed under the row. */
function RefusedAmount({ refusal, testid }: { refusal: ServedRefusal | null; testid?: string }) {
  const { t, i18n } = useTranslation();
  return (
    <span
      className="pl-amount pl-refused"
      data-testid={testid ?? "pl-refused-amount"}
      data-refusal-code={refusal?.code}
      title={refusal ? pickLang(refusal.text, i18n.language) : undefined}
    >
      {t("statements.pl.refused")}
    </span>
  );
}

/** The code of the refusal EBITDA carries on this statement. Every figure
 *  built on EBITDA (EBIT, profit before tax, the net result) is refused for
 *  the same reason: the sentence is printed ONCE, where it starts — the
 *  stock-variation row and the EBITDA line — and the rows below say they
 *  are refused with EBITDA ("caveats short and once"). */
const EbitdaRefusalCtx = createContext<string | null>(null);

/** The engine's reason for a refused figure, in the reader's language —
 *  or, on a row refused only because EBITDA is, the short pointer to it. */
function RefusalNote({
  refusal,
  lang,
  root = false,
}: {
  refusal: ServedRefusal;
  lang: string | undefined;
  /** The row where the refusal STARTS (711, EBITDA): the full sentence. */
  root?: boolean;
}) {
  const { t } = useTranslation();
  const ebitdaCode = useContext(EbitdaRefusalCtx);
  const derived = !root && ebitdaCode !== null && refusal.code === ebitdaCode;
  return (
    <div
      className="pl-row-note pl-refusal-note"
      data-testid={derived ? "pl-refusal-derived" : "pl-refusal"}
      data-refusal-code={refusal.code}
    >
      {derived ? t("statements.pl.refusedWithEbitda") : pickLang(refusal.text, lang)}
    </div>
  );
}

function PLSectionView({
  section,
  currency,
  keyOnly = false,
}: {
  section: PLSection;
  currency: string;
  /** THE DIAL — Simple collapsed state: render only builder-marked
   *  headline rows (subtotal/total/boxed); `item` lines hide. */
  keyOnly?: boolean;
}) {
  // Hook BEFORE the empty-section bail-out — see the same note in
  // BSStatementView. A section that loses its lines between renders must not
  // change this component's hook count.
  const fmt = useAmountFormatter(currency);
  const { i18n } = useTranslation();
  if (section.lines.length === 0 && !section.subtotalLabel) return null;
  const visibleLines = keyOnly
    ? section.lines.filter((l) => l.style !== "item")
    : section.lines;
  if (keyOnly && visibleLines.length === 0 && !section.subtotalLabel) return null;
  const subtotalAttrs = section.subtotalBucket
    ? { [TRACEABLE_TARGET_ATTR]: section.subtotalBucket }
    : {};
  const subtotalConceptKey = bucketToConcept(section.subtotalBucket);
  const subtotalRefused = section.subtotalAmount === undefined && section.subtotalRefusal;
  return (
    <div className="pl-section" data-pl-section={section.role}>
      {section.header && <div className="pl-section-header">{section.header}</div>}

      {visibleLines.map((line, i) => (
        <PLLineView key={`${line.accountCode ?? "x"}-${i}`} line={line} currency={currency} />
      ))}

      {section.subtotalLabel && (
        <>
          <div className="pl-subtotal-rule" />
          <div className="pl-row pl-subtotal" {...subtotalAttrs}>
            <span className="pl-label">
              <SimpleTermLabel termId={termForRow(section.subtotalBucket)}>
                {section.subtotalRoName
                  ? <RoLabel roName={section.subtotalRoName} lang={i18n.language} />
                  : section.subtotalLabel}
              </SimpleTermLabel>
            </span>
            {subtotalRefused ? (
              <RefusedAmount refusal={section.subtotalRefusal ?? null} />
            ) : subtotalConceptKey && section.subtotalAmount !== undefined ? (
              <LearnableNumber
                conceptKey={subtotalConceptKey}
                value={section.subtotalAmount}
                className="pl-amount"
                block
              >
                {fmt(section.subtotalAmount)}
              </LearnableNumber>
            ) : (
              <span className="pl-amount">{fmt(section.subtotalAmount)}</span>
            )}
            <CmpCells rowKey={section.subtotalBucket} amount={section.subtotalAmount} />
          </div>
          {subtotalRefused && section.subtotalRefusal && (
            <RefusalNote refusal={section.subtotalRefusal} lang={i18n.language} />
          )}
        </>
      )}
    </div>
  );
}

function PLLineView({ line, currency }: { line: PLLine; currency: string }) {
  const fmt = useAmountFormatter(currency);
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const lineAttrs = line.bucket ? { [TRACEABLE_TARGET_ATTR]: line.bucket } : {};
  const conceptKey = bucketToConcept(line.bucket);
  const refused = line.amount === undefined && line.refusal;
  const notes = (
    <>
      {refused && line.refusal && (
        <RefusalNote refusal={line.refusal} lang={lang} root={line.bucket === "inventoryVariation"} />
      )}
      {line.provenance?.label && (
        <div
          className="pl-row-note pl-provenance"
          data-testid="pl-provenance"
          data-provenance={line.provenance.key}
        >
          {pickLang(line.provenance.label, lang)}
        </div>
      )}
    </>
  );

  if (line.style === "subtotal" && !line.accountCode) {
    return (
      <>
        <div className="pl-row pl-subtotal" {...lineAttrs}>
          <span className="pl-label">
            <SimpleTermLabel termId={termForRow(line.bucket)}>
              {line.roName ? <RoLabel roName={line.roName} lang={lang} /> : line.label}
            </SimpleTermLabel>
          </span>
          {refused ? (
            <RefusedAmount refusal={line.refusal ?? null} />
          ) : conceptKey && line.amount !== undefined ? (
            <LearnableNumber
              conceptKey={conceptKey}
              value={line.amount}
              className="pl-amount"
              block
            >
              {fmt(line.amount)}
            </LearnableNumber>
          ) : (
            <span className="pl-amount">{fmt(line.amount)}</span>
          )}
          <CmpCells rowKey={line.bucket} amount={line.amount} />
        </div>
        {notes}
      </>
    );
  }

  // Two vocabularies that never quite met: `LineSign` has three members
  // ("positive" | "negative" | "neutral") while the money formatter's
  // `sign` option has two. Passing "neutral" fell through the formatter's
  // sign branches to "render with the value's own sign" — which IS what
  // neutral means, so nothing was visibly wrong, but the mismatch was
  // load-bearing by accident: it was the formatter's DEFAULT that saved
  // it, not any decision here. Making the mapping explicit keeps the
  // rendered string byte-identical and stops a future fourth member (or a
  // reordered branch in `formatAmountFrom`) from changing a money sign
  // silently.
  const explicitSign =
    line.sign === "positive" || line.sign === "negative" ? line.sign : undefined;
  const amount = explicitSign
    ? fmt(line.amount ?? 0, { sign: explicitSign })
    : fmt(line.amount);
  const amountClass =
    line.sign === "negative" ? "pl-neg" : line.sign === "positive" ? "pl-pos" : "";

  // Account code renders AFTER the label as a muted chip. When the builder
  // baked a pure code list into the label text ("… (601/602/607)"), peel it
  // into the chip; prose parentheses stay in the label. When the label IS
  // the bare code (unlabeled accounts in synthetic files), skip the chip —
  // "607 [607]" reads as a bug.
  const split = line.accountCode ? null : splitAccountParen(line.label);
  const labelText = split?.code ? split.text : line.label;
  // The chip in the reader's language where the engine words it apart
  // ("68x fără 6812, 6814" / "68x excl. 6812, 6814") — a code string, never
  // a figure. `line.accountCode` stays the key the term map reads.
  const romanianUi = (lang ?? "").toLowerCase().startsWith("ro");
  const rawChip = (romanianUi ? line.accountCodeRo : undefined) ?? line.accountCode ?? split?.code;
  const chipCode = rawChip && rawChip !== labelText.trim() ? rawChip : undefined;

  return (
    <>
      <div className={`pl-row pl-row-item ${line.style}`} {...lineAttrs}>
        <span className="pl-label">
          <SimpleTermLabel termId={termForRow(line.bucket, line.accountCode)}>
            {line.roName ? <RoLabel roName={line.roName} lang={lang} /> : labelText}
          </SimpleTermLabel>
          <AccountChip code={chipCode} />
          {line.stockDirection && (
            <span
              className={`pl-direction ${line.stockDirection === "increase" ? "pl-pos" : "pl-neg"}`}
              data-testid="pl-stock-direction"
              data-direction={line.stockDirection}
            >
              {t(`statements.pl.stock.${line.stockDirection}`)}
            </span>
          )}
        </span>
        {refused ? (
          <RefusedAmount refusal={line.refusal ?? null} />
        ) : conceptKey ? (
          <LearnableNumber
            conceptKey={conceptKey}
            value={line.amount ?? 0}
            className={`pl-amount ${amountClass}`}
            block
          >
            {amount}
          </LearnableNumber>
        ) : (
          <span className={`pl-amount ${amountClass}`}>{amount}</span>
        )}
        <CmpCells rowKey={line.bucket} amount={line.amount} />
      </div>
      {notes}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// THE RECONCILIATION LINE under EBITDA (design A5) — the engine's own:
//
//   EBITDA înainte de variația stocurilor și producția imobilizată X
//   · Variația stocurilor de produse ±Y · Producția imobilizată Z
//   = EBITDA W · Provizioane și ajustări nete (6812 + 6814 − 7812 − 7814)
//   — în afara EBITDA P
//
// every label and every value as served (`ebitda_reconciliation.bridge`),
// the two components signed as their effect on the result, net provisions
// printed as the row below prints it (the served charge, a level — see
// `afterParts`), a zero printed
// as a zero (the reader must see the definition includes the line even
// when this period did not post to it), and a refused part as the word.
// Under it the engine's notes: on a closed book the 711 line is DERIVED
// from account 121, so the chain closes by construction — said, not
// implied; and the 711 / 72x split assumption where both moved.
// NOTHING IS COMPUTED HERE.
// ────────────────────────────────────────────────────────────────────────

function EbitdaBridgeLine({
  served,
  currency,
  lang,
}: {
  served: ServedOneEbitda;
  currency: string;
  lang: string | undefined;
}) {
  const { t } = useTranslation();
  const fmt = useAmountFormatter(currency);
  const recon = served.reconciliation;
  if (!recon || recon.bridge.parts.length === 0) return null;
  // Signed as their effect on the result: the two components inside EBITDA.
  const signedPart = (key: string) =>
    key === "inventory_variation" || key === "capitalized_own_work";
  const value = (key: string, v: number | null): string => {
    if (v === null) return t("statements.pl.refused");
    if (Math.abs(v) < 0.005) return "0";
    return signedPart(key) ? fmt(v, { sign: v > 0 ? "positive" : "negative" }) : fmt(v);
  };
  // NET PROVISIONS AFTER EBITDA — on the page's ONE convention (review
  // 2026-10-01). The engine serves the bridge's part signed as its effect on
  // the result (a net charge negative); the net-provisions ROW a few lines
  // below prints the served `assembled_pl.net_provisions.value` as D&A
  // prints its own — a charge as a level, "6812 + 6814 − 7812 − 7814", as
  // both labels say. Two figures under one label with opposite signs is the
  // defect, so the bridge prints THE ROW'S served figure, through the same
  // printer, unsigned and uncoloured: one figure, one convention. A block
  // without a readable net-provisions figure (not one the engine writes
  // under R2) prints no after-part rather than a second convention.
  const afterParts = recon.bridge.afterEbitda.flatMap((p) => {
    if (p.key !== "net_provisions") return [p];
    const np = served.netProvisions;
    return np ? [{ ...p, value: np.value }] : [];
  });
  return (
    <div className="pl-ebitda-bridge" data-testid="pl-ebitda-bridge" data-definition={recon.definition ?? undefined}>
      <div className="pl-bridge-parts">
        {recon.bridge.parts.map((p, i) => (
          <span key={p.key} className="pl-bridge-part" data-bridge-part={p.key}>
            {i > 0 && <span className="pl-bridge-sep">{p.key === "ebitda" ? " = " : " · "}</span>}
            <span className="pl-bridge-label">{pickLang(p.label, lang)}</span>{" "}
            <span className="pl-bridge-value" data-bridge-value={p.value === null ? "refused" : String(p.value)}>
              {value(p.key, p.value)}
            </span>
          </span>
        ))}
        {/* After EBITDA and outside it — the engine's label says so. */}
        {afterParts.map((p) => (
          <span key={p.key} className="pl-bridge-part" data-bridge-after={p.key}>
            <span className="pl-bridge-sep">{" · "}</span>
            <span className="pl-bridge-label">{pickLang(p.label, lang)}</span>{" "}
            <span className="pl-bridge-value" data-bridge-value={p.value === null ? "refused" : String(p.value)}>
              {value(p.key, p.value)}
            </span>
          </span>
        ))}
      </div>
      {recon.identityNote && (
        <div className="pl-bridge-note" data-testid="pl-identity-note">
          {pickLang(recon.identityNote, lang)}
        </div>
      )}
      {recon.splitAssumption && (
        <div className="pl-bridge-note" data-testid="pl-split-assumption">
          {pickLang(recon.splitAssumption, lang)}
        </div>
      )}
    </div>
  );
}
