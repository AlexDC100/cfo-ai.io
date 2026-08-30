// ACTION — the element 80% of the measured baseline was missing.
//
// `_finding._check_action` already guarantees the shape: every step
// leads with a verb from the imperative lexicon (never "review",
// "monitor", "consider"), names an ARTEFACT to obtain and a PROVIDER who
// typically has it. This renders that structure instead of flattening it
// into a sentence, because the artefact and the provider are what make a
// step doable — "Pull the 461 sub-ledger" is only actionable next to
// "from the group financial controller".
//
// The checkboxes are a reader's scratchpad, device-local and unpersisted
// on purpose: a tick here is not a state the engine or another user
// should read. Marking work done belongs to the decisions surface, which
// has an owner and an audit trail.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { FindingAction, FindingActionStep } from "@/lib/findings";

import { ElementLabel } from "./parts";
import "./findingsI18n";

function StepRow({
  step,
  index,
  checked,
  onToggle,
}: {
  step: FindingActionStep;
  index: number;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex items-start gap-2.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={onToggle}
        className={`mt-[3px] h-[15px] w-[15px] shrink-0 rounded-[4px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
          checked ? "border-brand bg-brand" : "border-rule-strong bg-surface hover:border-brand-l"
        }`}
      >
        {checked ? (
          <svg viewBox="0 0 12 12" className="h-full w-full text-paper" aria-hidden="true">
            <path
              d="M2.5 6.2 4.8 8.5 9.5 3.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </button>
      <div className="min-w-0 flex-1">
        <p
          className={`text-[13px] leading-snug ${checked ? "text-ink-mute line-through decoration-ink-faint" : "text-ink"}`}
        >
          <span className="font-mono text-[10.5px] text-ink-mute">{index + 1}.</span>{" "}
          <span className="font-medium">{step.imperative}</span>
        </p>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">
          <span className="text-ink-mute">{t("fnd.actionArtefact")}: </span>
          {step.artefact}
          <span className="text-ink-mute"> · {t("fnd.actionProvider")} </span>
          {step.provider}
          {step.horizon ? (
            <>
              <span className="text-ink-mute"> · {t("fnd.actionHorizon")} </span>
              {step.horizon}
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}

export function ActionChecklist({
  action,
  limit,
}: {
  action: FindingAction;
  /** Render only the first N steps (Simple mode shows exactly one). */
  limit?: number;
}) {
  const { t } = useTranslation();
  const [done, setDone] = useState<Record<number, boolean>>({});
  const steps = typeof limit === "number" ? action.steps.slice(0, limit) : action.steps;

  return (
    <section data-testid="fnd-action">
      <ElementLabel>{limit === 1 ? t("fnd.simple.oneAction") : t("fnd.action")}</ElementLabel>
      <ul className="mt-2 space-y-2.5">
        {steps.map((s, i) => (
          <StepRow
            key={`${s.imperative}-${i}`}
            step={s}
            index={i}
            checked={done[i] === true}
            onToggle={() => setDone((d) => ({ ...d, [i]: !d[i] }))}
          />
        ))}
      </ul>
    </section>
  );
}
