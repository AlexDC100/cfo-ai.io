// ALL CHECKS — where a demoted finding lives, and why silence is a claim.
//
// Two jobs, one surface:
//
//   1. A DEMOTED FINDING IS NEVER A RECOMMENDATION. It appears here, with
//      its rule, its parameter, its limit, its observed value and the
//      contract element it was missing — and with no prose. That is the
//      whole disposition: the numbers were real, the sentence was not
//      earned. Putting it in the recommendation list "because it fired"
//      is the failure this rebuild exists to remove.
//
//   2. THE COUNT IS THE STATEMENT. "23 rules ran, 7 surfaced, 16 are
//      here" is a sentence a reader can audit. `_finding_rank`'s own
//      `RankedReport.statement()` is printed verbatim when present
//      rather than re-derived, so the screen cannot disagree with the
//      engine about what it is showing.
//
// Rows are grouped by DISPOSITION, not by severity: "fired but demoted",
// "below the materiality floor", "ranked below the cap" and "ran, did
// not fire" are four different things to know, and flattening them into
// one list is how the baseline's 59 rows became unreadable.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

import type { Currency } from "@/lib/rates";
import type { CheckRow, FindingsReport } from "@/lib/findings";

import { ABSENT, ElementLabel, FigureValue, asCurrency } from "./parts";
import { comparatorWord } from "./ThresholdMeter";
import "./findingsI18n";

interface Group {
  id: string;
  title: string;
  note?: string;
  rows: CheckRow[];
}

/** The key a check row and a finding agree on: the THRESHOLD's rule id
 *  plus its parameter, which is how `_finding.check_record` builds the
 *  row in the first place. */
function checkKey(ruleId: string, parameter: string): string {
  return `${ruleId}|${parameter}`;
}

function keysOf(findings: readonly { elements: { threshold: { rule_id: string; parameter: string } | null }; ruleKey: string }[]): Set<string> {
  const out = new Set<string>();
  for (const f of findings) {
    const t = f.elements.threshold;
    out.add(checkKey(t ? t.rule_id : f.ruleKey, t ? t.parameter : ""));
  }
  return out;
}

/**
 * Group the checks by DISPOSITION — cross-referenced against the report,
 * never guessed from the row alone.
 *
 * The first version bucketed every fired check with no floor/cap note as
 * "fired, but demoted", which put the SURFACED findings' own check rows
 * in the demoted group: the panel told the reader that the three
 * recommendations above it had been demoted. Every fired check has a
 * finding somewhere in the report, so the honest classification is a
 * lookup, and the "shown above" group exists precisely so a surfaced
 * finding's row is never mistaken for a suppressed one.
 */
function classify(report: FindingsReport): Group[] {
  const surfacedKeys = keysOf(report.surfaced);
  const infoKeys = keysOf(report.info);
  const demotedKeys = keysOf(report.demoted);

  const shown: CheckRow[] = [];
  const demoted: CheckRow[] = [];
  const immaterial: CheckRow[] = [];
  const held: CheckRow[] = [];
  const quiet: CheckRow[] = [];

  for (const c of report.checks) {
    const note = (c.note || "").toLowerCase();
    const key = checkKey(c.rule_id, c.parameter);
    if (!c.fired) {
      quiet.push(c);
      continue;
    }
    if (surfacedKeys.has(key)) {
      shown.push(c);
      continue;
    }
    if (
      infoKeys.has(key) ||
      (c.materiality && c.materiality.tier === "immaterial") ||
      note.includes("below the materiality floor")
    ) {
      immaterial.push(c);
      continue;
    }
    if (note.includes("below the cap")) {
      held.push(c);
      continue;
    }
    if (demotedKeys.has(key) || note.includes("demoted")) {
      demoted.push(c);
      continue;
    }
    // Fired, and the report does not account for it. Say so rather than
    // filing it under a disposition it was never given.
    held.push(c);
  }
  return [
    { id: "demoted", rows: demoted, title: "groupDemoted", note: "groupDemotedNote" },
    { id: "immaterial", rows: immaterial, title: "groupImmaterial" },
    { id: "held", rows: held, title: "groupHeld" },
    { id: "shown", rows: shown, title: "groupShown" },
    { id: "quiet", rows: quiet, title: "groupQuiet" },
  ].filter((g) => g.rows.length > 0) as Group[];
}

/**
 * Collapse byte-identical `; `-separated segments in an engine note.
 *
 * `rank_findings._check_from` concatenates a check record's note — which
 * already embeds "demoted: <reasons>" — with `ranked.demotion_reason`,
 * which is the same reasons again, so a demoted row arrives reading
 * "demoted: action: no action supplied; action: no action supplied".
 * This drops only EXACT repeats, so every distinct claim survives and
 * the surviving text is a subsequence of what the engine sent. The
 * duplication itself is engine-side and is reported as such; this keeps
 * it from reading as a broken renderer in the meantime.
 */
export function dedupeNoteSegments(note: string): string {
  if (!note) return note;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of note.split(";")) {
    const seg = raw.trim();
    if (!seg) continue;
    const key = seg.replace(/^demoted:\s*/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seg);
  }
  return out.join("; ");
}

function CheckTable({ rows, currency }: { rows: CheckRow[]; currency: Currency }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-rule text-left">
            <th className="py-1.5 pr-3 font-mono text-[9.5px] uppercase tracking-[0.14em] font-normal text-ink-mute">
              {t("fnd.checks.colRule")}
            </th>
            <th className="py-1.5 pr-3 font-mono text-[9.5px] uppercase tracking-[0.14em] font-normal text-ink-mute">
              {t("fnd.checks.colParameter")}
            </th>
            <th className="py-1.5 pr-3 text-right font-mono text-[9.5px] uppercase tracking-[0.14em] font-normal text-ink-mute">
              {t("fnd.checks.colLimit")}
            </th>
            <th className="py-1.5 pr-3 text-right font-mono text-[9.5px] uppercase tracking-[0.14em] font-normal text-ink-mute">
              {t("fnd.checks.colObserved")}
            </th>
            <th className="py-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] font-normal text-ink-mute">
              {t("fnd.checks.colNote")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr
              key={`${c.rule_id}-${c.parameter}-${i}`}
              className="border-b border-rule/50 align-top last:border-0"
              data-testid={`fnd-check-${c.rule_id}`}
            >
              <td className="py-1.5 pr-3 font-mono text-[11px] text-ink">{c.rule_id}</td>
              <td className="py-1.5 pr-3 text-ink-soft">{c.parameter || ABSENT}</td>
              {/* The printed value follows `_finding._format_value`, which
                  rounds by unit — so the exact number the rule judged is
                  carried on the title attribute rather than lost. An
                  auditable table must not round away the thing being
                  audited. */}
              <td
                className="py-1.5 pr-3 text-right text-ink-soft"
                title={c.limit === null ? undefined : String(c.limit)}
              >
                {c.comparator ? (
                  <span className="mr-1 text-ink-mute">
                    {comparatorWord(c.comparator, t)}
                  </span>
                ) : null}
                <FigureValue value={c.limit} unit={c.unit} currency={currency} />
              </td>
              <td
                className="py-1.5 pr-3 text-right text-ink"
                data-observed-exact={c.observed === null ? undefined : String(c.observed)}
                title={c.observed === null ? undefined : String(c.observed)}
              >
                <FigureValue value={c.observed} unit={c.unit} currency={currency} />
              </td>
              {/* The group heading already says whether these fired, so
                  a per-row "Did not fire" is a column of the same word.
                  Only a real note earns the space. */}
              <td className="py-1.5 text-ink-mute">{dedupeNoteSegments(c.note)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AllChecksList({
  report,
  currency,
  defaultOpen = false,
}: {
  report: FindingsReport;
  currency?: string;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const groups = useMemo(() => classify(report), [report]);
  const cur = asCurrency(currency ?? report.surfaced[0]?.sourceCurrency ?? "RON");
  const total = report.checks.length;

  if (total === 0 && report.demoted.length === 0) {
    return (
      <p className="text-[12.5px] text-ink-mute" data-testid="fnd-checks-empty">
        {t("fnd.checks.empty")}
      </p>
    );
  }

  return (
    <section
      className="rounded-md border border-rule bg-surface"
      data-testid="fnd-all-checks"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        data-testid="fnd-checks-toggle"
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-ink">
            {t("fnd.checks.title")}
          </span>
          <span className="mt-0.5 block text-[12px] text-ink-soft">
            {report.statement ?? t("fnd.checks.subtitle", { count: total })}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[11px] tabular-nums text-ink-mute">{total}</span>
          <ChevronDown
            size={14}
            strokeWidth={2}
            className={`text-ink-mute transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open ? (
        <div className="space-y-5 border-t border-rule px-4 py-4">
          {groups.map((g) => (
            <div key={g.id} data-testid={`fnd-checks-group-${g.id}`}>
              <ElementLabel>
                {t(`fnd.checks.${g.title}`)} · {g.rows.length}
              </ElementLabel>
              {g.note ? (
                <p className="mt-1 max-w-[70ch] text-[12px] leading-relaxed text-ink-soft">
                  {t(`fnd.checks.${g.note}`)}
                </p>
              ) : null}
              <div className="mt-2">
                <CheckTable rows={g.rows} currency={cur} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
