// CoverageTable — what CFO AI can read today, in-app.
//
// The SAME data as the table beside the upload step on the landing page:
// frontend/data/coverage.json through lib/coverage. Three groups — Tested /
// AI-interpreted / Not supported yet — each row with what it was tested on
// (real trial balances, counted, or "constructed test files only"), the
// evidence, and the date. This component lays the rows out; it writes no
// coverage wording of its own (gate public-claims).
//
// Two exports:
//   · <CoverageTable />      the table itself (the non-Romanian refusal
//                            dialog shows it inline);
//   · <CoverageDisclosure /> a text button that opens the table in a
//                            dialog — mounted in the upload zone's header.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { coverageView, type CoverageCategory } from "@/lib/coverage";

const TONE: Record<CoverageCategory, string> = {
  tested: "text-success",
  ai_interpreted: "text-ink-soft",
  not_supported: "text-alert",
};

const DOT: Record<CoverageCategory, string> = {
  tested: "bg-success",
  ai_interpreted: "bg-ink-soft",
  not_supported: "bg-alert",
};

export function CoverageTable({ showHeading = false }: { showHeading?: boolean }) {
  const { i18n, t } = useTranslation();
  const v = coverageView(i18n.language);
  return (
    <div data-testid="coverage-table" data-coverage-source="frontend/data/coverage.json">
      {showHeading && (
        <>
          <h3 className="text-[15px] font-semibold text-ink">{v.title}</h3>
          <p className="mt-1 text-[12.5px] text-ink-soft leading-relaxed">{v.lede}</p>
        </>
      )}
      <div className={`${showHeading ? "mt-4 " : ""}space-y-4`}>
        {v.groups.map((g) => (
          <section key={g.category} data-coverage-category={g.category}>
            <div className={`flex items-center gap-2 text-[10.5px] uppercase tracking-[0.12em] font-semibold ${TONE[g.category]}`}>
              <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[g.category]}`} />
              {g.heading}
            </div>
            <p className="mt-1 text-[11.5px] text-ink-mute">{g.note}</p>
            <ul className="mt-2 space-y-2">
              {g.rows.map((r) => (
                <li
                  key={r.id}
                  data-coverage-row={r.id}
                  className="rounded-lg border border-rule bg-bg-2/40 px-3 py-2.5"
                >
                  <div className="text-[12.5px] text-ink leading-snug">{r.label}</div>
                  {r.availability && (
                    <span
                      data-coverage-availability
                      className="mt-1.5 inline-flex rounded-full border border-alert/50 px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] font-semibold text-alert"
                    >
                      {r.availability}
                    </span>
                  )}
                  <div className="mt-1 text-[11.5px] text-ink-soft leading-relaxed">{r.note}</div>
                  <div className="mt-1.5 font-mono text-[10.5px] text-ink-mute leading-relaxed">
                    <span data-coverage-tested-on>{r.testedOn}</span>
                    {" · "}
                    {v.words.evidence}: <span data-coverage-evidence>{r.evidence}</span>
                    {" · "}
                    <time dateTime={r.asOfIso}>{v.words.asOf} {r.asOf}</time>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-ink-mute leading-relaxed">{v.untestedNote}</p>
      <p className="mt-2 text-[12px]">
        <Link
          to="/sample"
          data-testid="coverage-sample-link"
          className="font-medium text-brand-d hover:text-brand underline-offset-2 hover:underline"
        >
          {t("coverage.sampleLink")} →
        </Link>
      </p>
    </div>
  );
}

/** A text button that opens the coverage table in a dialog. Safe inside a
 *  paragraph: the dialog is portalled. */
export function CoverageDisclosure() {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const v = coverageView(i18n.language);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="coverage-open"
        className="font-medium text-brand-d hover:text-brand underline underline-offset-2"
      >
        {t("coverage.open")}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-testid="coverage-dialog"
          className="max-w-[760px] max-h-[86vh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle className="text-[16px] font-semibold text-ink">{v.title}</DialogTitle>
            <DialogDescription className="text-[13px] text-ink-soft leading-relaxed pt-1">
              {v.lede}
            </DialogDescription>
          </DialogHeader>
          <CoverageTable />
        </DialogContent>
      </Dialog>
    </>
  );
}
