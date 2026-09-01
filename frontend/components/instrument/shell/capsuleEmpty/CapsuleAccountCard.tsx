// THE CAPSULE — ACCOUNT LOOKUP, the capability no generic launcher has.
//
// Type "461" and this period's intercompany-receivables line resolves:
// its engine label, its balance through the money path, its share of its
// own class, and the account codes behind it. Instantly, locally, for
// nothing.
//
// A generic command palette can find you a PAGE called 461. This finds
// you the BALANCE, because the fact index was built from the period the
// reader already has open. That difference is the reason the dropdown
// deserves the space it takes.
//
// ══ WHAT IT SAYS, AND WHAT IT REFUSES TO SAY ══════════════════════════
//
//   BALANCE        the served row's own amount, through `NarrativeText`
//                  with a `{{money:…}}` template — the same renderer as
//                  the prose, the tiles and the answer lane, so one
//                  number cannot get two spellings on one screen.
//   SHARE OF CLASS `classShareOf` — the row's amount over the ENGINE's
//                  own subtotal for its section, divided in the source
//                  currency so the result does not move when the display
//                  dial does. Rendered through `<Amount kind="percent">`.
//   ACCOUNTS       the codes the served row names, verbatim.
//
//   MOVEMENT — NOT RENDERED, and this is a measurement rather than an
//   omission. `CanonicalBsRow` declares `opening`, and across the three
//   REAL captured period fixtures this repo holds (carniprod FY2025,
//   retail FY2024, minor-drift), 0 of 90 rows carry a non-null one. A
//   movement line would therefore render on nothing, and its gate would
//   pass by examining no subject — TC-9 exactly. Build it the day a
//   fixture carries an opening balance; not before.
//
// ══ THE REFUSAL IS THE OTHER HALF OF THE FEATURE ══════════════════════
//
// "461" against a period with no canonical statement lines is a
// well-formed question this workspace cannot answer. Before this card,
// that query fell through to the ask fallback and pressing Enter spent a
// model call to discover the same emptiness. The refusal says so
// instantly and for free, and it says WHICH period it looked in — a
// refusal that does not name its subject is indistinguishable from a
// bug.

import { useTranslation } from "react-i18next";

import { Amount } from "@/components/instrument/Amount";
import { classShareOf, type FactRef } from "@/lib/capsuleFactIndex";
import type { Tier0Answer } from "@/lib/capsuleTier0";
import type { TraceableSource } from "@/lib/traceableSource";

import "./capsuleEmptyI18n";
import { FactTileValue, sourceForFactKey } from "./CapsuleFactTiles";

/** Two. A code that resolves to more rows than this is a PREFIX rather
 *  than an account, and a card is the wrong shape for a list. */
const MAX_ACCOUNT_ROWS = 2;

export interface CapsuleAccountCardProps {
  answer: Tier0Answer;
  /** Open the statement row. Omitted, no dot — never a dead one. */
  onJump?: (source: TraceableSource) => void;
  /** Open the full canvas on this lookup. */
  onOpen?: () => void;
}

function ShareOfClass({ fact }: { fact: FactRef }) {
  const { t } = useTranslation();
  const share = classShareOf(fact);
  // Absent section, absent subtotal, or a zero denominator: nothing
  // renders. There is no "—" and no "n/a" — the line is simply not
  // claimed.
  if (!share) return null;
  return (
    <span data-testid="capsule-account-share" className="inline-flex items-baseline gap-1">
      <Amount
        value={share.share * 100}
        kind="percent"
        className="text-[11.5px] text-ink-soft"
      />
      <span className="text-[11.5px] text-ink-soft">
        {t(`capsuleEmpty.account.section.${share.section}`, {
          defaultValue: t("capsuleEmpty.account.sectionGeneric"),
        })}
      </span>
    </span>
  );
}

export function CapsuleAccountCard({ answer, onJump, onOpen }: CapsuleAccountCardProps) {
  const { t } = useTranslation();
  if (answer.shape !== "account") return null;
  const code = answer.account ?? "";

  // ── the honest refusal ────────────────────────────────────────────
  if (answer.refused || answer.facts.length === 0) {
    const period = answer.noteParams?.period ?? "";
    return (
      <div
        data-testid="capsule-account-card"
        data-row-source="account-card"
        data-refused="true"
        className="border-b border-rule-soft px-4 py-2.5 text-[12px] leading-relaxed text-ink-soft"
      >
        {period
          ? t("capsuleEmpty.account.absent", { account: code, period })
          : t("capsuleEmpty.account.absentNoPeriod", { account: code })}
      </div>
    );
  }

  const rows = answer.facts.slice(0, MAX_ACCOUNT_ROWS);

  return (
    <div
      data-testid="capsule-account-card"
      data-row-source="account-card"
      data-account={code}
      className="border-b border-rule-soft px-4 py-2.5"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-soft">
          {t("capsuleEmpty.account.eyebrow", { account: code })}
        </span>
        {onOpen && (
          <button
            type="button"
            data-testid="capsule-account-open"
            onClick={onOpen}
            className="
              ml-auto shrink-0 rounded-sm text-[10.5px] uppercase tracking-[0.12em]
              text-ink-soft transition-colors duration-micro hover:text-ink
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
            "
          >
            {t("capsuleEmpty.account.open")}
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((fact) => {
          const source = sourceForFactKey(fact.factKey);
          return (
            <li
              key={`${fact.factKey}:${fact.periodId}`}
              data-testid="capsule-account-row"
              data-fact={fact.factKey}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-soft">
                {fact.label}
              </span>
              <FactTileValue fact={fact} className="text-[14px] leading-none text-ink" />
              {source && onJump && (
                <button
                  type="button"
                  onClick={() => onJump(source)}
                  aria-label={t("capsuleEmpty.tile.provenanceJump", { metric: fact.label })}
                  data-testid="capsule-provenance-dot"
                  data-traceable-source-statement={source.statement}
                  data-traceable-source-bucket={source.bucket}
                  className="
                    inline-flex h-4 w-4 shrink-0 items-center justify-center self-center
                    rounded-full text-ink-soft transition-colors duration-micro
                    hover:text-brand-d dark:hover:text-brand-l
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                  "
                >
                  <span className="block h-[5px] w-[5px] rounded-full bg-current" aria-hidden />
                </button>
              )}
              <span className="basis-full" />
              <ShareOfClass fact={fact} />
              {(fact.accountCodes?.length ?? 0) > 0 && (
                <span className="font-mono text-[10.5px] text-ink-soft">
                  {fact.accountCodes!.join(" · ")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
