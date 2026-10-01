// /sample — the public sample: a FICTIONAL company, read by the real engine.
//
// Public, outside the auth wall (App.tsx), in both languages. Linked from
// the landing page so anyone can inspect what the product does to a trial
// balance: the mapping of every account and every uncertainty label.
//
// THIS PAGE DECIDES NOTHING AND COMPUTES NOTHING. Every figure, verdict,
// label and mapping row is read from `frontend/data/publicSample.json`,
// which `scripts/build_public_sample.py` generates from the documents the
// engine served for the fictional book (each figure carries the pointer it
// was read from). The page only PRINTS — money through lib/money, ratios
// through lib/ratioTable's printer, both in the reader's language — and
// quotes the engine's own sentences verbatim. Gate: `public-sample`
// (frontend/pages/cfo/__tests__/publicSample.test.tsx and
// tests/engine/test_public_sample.py).
//
// The published files live under public/sample/, which is also why nginx
// carries an explicit location for this route (see nginx.conf): `/sample`
// is a directory on disk, and the SPA fallback's `$uri/` would otherwise
// answer it with a directory listing refusal instead of the app.

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { setLanguage } from "@/i18n";
import { Logo } from "@/components/cfo/Logo";
import { LegalFooter } from "@/components/cfo/LegalFooter";
import { proofRows, type ProofCheckId } from "@/lib/engineProof";
import { printDaysQ } from "@/lib/inventoryDays";
import { moneyLocaleFor } from "@/lib/money";
import {
  SAMPLE,
  SAMPLE_FILES_BASE,
  fileKeys,
  labelQuote,
  sampleBand,
  sampleMoney,
  sampleRatio,
  type SampleFigure,
  type SampleLabel,
  type SampleLang,
  type SampleMappingRow,
  type SampleRatio,
} from "@/lib/publicSample";
import { ratioLabelForKey } from "@/lib/ratioTable";

import { fill, sampleLangOf, sampleStringsFor } from "./sampleStrings";

function integer(value: number, lang: SampleLang): string {
  return value.toLocaleString(moneyLocaleFor(lang), { maximumFractionDigits: 0 });
}

function asOfDate(iso: string, lang: SampleLang): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(lang === "ro" ? "ro-RO" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ── small pieces ──────────────────────────────────────────────────────

function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={`sample-${id}`} aria-labelledby={`sample-${id}-h`} className="mt-12">
      <h2 id={`sample-${id}-h`} className="text-[20px] font-medium tracking-[-0.01em] text-ink">
        {title}
      </h2>
      {lede ? <p className="mt-1.5 max-w-[720px] text-[13.5px] leading-relaxed text-ink-soft">{lede}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Card({ testId, title, children }: { testId: string; title: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="rounded-lg border border-rule bg-surface p-4">
      <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-mute">{title}</h3>
      <div className="mt-2 space-y-1.5 text-[13.5px] leading-relaxed text-ink">{children}</div>
    </div>
  );
}

/** A sentence the ENGINE wrote, quoted verbatim in the language it was
 *  written in (`lang` on the element says which). */
function EngineQuote({ text, lang, testId }: { text: string; lang: SampleLang; testId?: string }) {
  return (
    <blockquote
      lang={lang}
      data-engine-words={lang}
      data-testid={testId}
      className="border-l-2 border-rule-strong pl-3 text-[13px] leading-relaxed text-ink-soft"
    >
      {text}
    </blockquote>
  );
}

/** A printed amount in a narrow table cell: the figure never breaks, and
 *  the currency code may drop to the next line (lib/money joins the two
 *  with a no-break space, which on a phone forced a break INSIDE the
 *  figure). The printed characters are lib/money's, unchanged. */
function MoneyCell({ printed }: { printed: string }) {
  const at = printed.lastIndexOf("\u00a0");
  if (at < 0) return <span className="whitespace-nowrap">{printed}</span>;
  return (
    <>
      <span className="whitespace-nowrap">{printed.slice(0, at)}</span>{" "}
      <span className="whitespace-nowrap">{printed.slice(at + 1)}</span>
    </>
  );
}

const MAPPING_PREVIEW = 14;

// ── the page ──────────────────────────────────────────────────────────

export default function PublicSample() {
  const { i18n: inst } = useTranslation();
  const lang = sampleLangOf(inst.language);
  const S = sampleStringsFor(lang);
  const data = SAMPLE;
  const other: SampleLang = lang === "ro" ? "en" : "ro";
  const [allAccounts, setAllAccounts] = useState(false);
  const { hash } = useLocation();

  // The landing's proof block links to /sample#checks: the router does not
  // scroll to a fragment by itself.
  useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(hash.slice(1));
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView();
  }, [hash]);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = S.metaTitle;
    const meta = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    const prevDescription = meta?.getAttribute("content") ?? null;
    meta?.setAttribute("content", S.metaDescription);
    return () => {
      document.title = prevTitle;
      if (meta && prevDescription !== null) meta.setAttribute("content", prevDescription);
    };
  }, [S.metaTitle, S.metaDescription]);

  const company = data.company;
  const current = data.periods.current;
  const prior = data.periods.prior;
  const v = data.verdicts;
  const figure = (period: typeof current, key: string): number =>
    (period.figures as SampleFigure[]).find((f) => f.key === key)!.value;
  const money = (value: number) => sampleMoney(value, lang);
  const ratios = data.ratios as SampleRatio[];
  const labels = data.labels as SampleLabel[];
  const mapping = data.mapping as SampleMappingRow[];
  const shownMapping = allAccounts ? mapping : mapping.slice(0, MAPPING_PREVIEW);
  // Where each figure was read from: the published served document and the
  // pointer inside it — shown as the figure's title.
  const cards = fileKeys(data);
  const servedFile = (key: "served_current" | "served_prior" | "served_comparatives") =>
    cards.find((c) => c.key === key)!.file.name;
  const origin = (file: string, pointer: string) => `${file} · ${pointer}`;

  // THE LANDING'S PROOF LIST, ON THIS BOOK. What each check is comes from
  // engineProof.json through lib/engineProof — the sentence the landing's
  // proof block prints, in the same order — and what it reads on the
  // fictional book comes from the served verdicts above. Nothing is decided
  // here: the gate `public-sample` (S4) holds the book to these checks.
  const ebitdaVariant = (key: string): number =>
    v.ebitda.variants.find((variant) => variant.key === key)!.engine;
  const checkReading: Record<ProofCheckId, string> = {
    rerun_identical: S.checks.rerun_identical,
    balance_sheet_closes: fill(S.checks.balance_sheet_closes, {
      status: (lang === "ro" ? v.balance.display_ro : v.balance.display_en) ?? v.balance.status,
      assets: money(v.balance.assets),
      liabilities: money(v.balance.equity_plus_liabilities),
      difference: money(v.balance.served_difference),
    }),
    net_income_equals_121: fill(S.checks.net_income_equals_121, {
      served: money(v.anchor.net_income_statutory),
      account121: money(v.anchor.account_121),
    }),
    turnover_equals_filing: fill(S.checks.turnover_equals_filing, {
      turnover: money(figure(current, "net_turnover")),
    }),
    ebitda_variants_agree: fill(S.checks.ebitda_variants_agree, {
      reported: money(ebitdaVariant("reported")),
      strict: money(ebitdaVariant("strict")),
      cash: money(ebitdaVariant("cash")),
      difference: money(v.ebitda.max_difference),
    }),
  };

  const labelTitle = (label: SampleLabel): string => {
    if (S.labelTitles[label.key]) return S.labelTitles[label.key];
    if (label.key.startsWith("ratio_refused_")) {
      const key = label.key.slice("ratio_refused_".length);
      return fill(S.labelRatioRefused, { ratio: ratioLabelForKey(key, lang) ?? key });
    }
    if (label.key.startsWith("insight_not_fired_")) {
      return fill(S.labelNotFiredFallback, { id: label.key.slice("insight_not_fired_".length) });
    }
    return label.key;
  };

  const lineOf = (row: SampleMappingRow): string => {
    if (row.status !== "mapped") return S.mappingStatus[row.status] ?? row.status;
    const statement = row.statement ? S.statements[row.statement] ?? row.statement : "";
    const bucket = row.engine_bucket ? S.buckets[row.engine_bucket] ?? row.engine_bucket : "";
    const section = row.balance_sheet_section
      ? S.sections[row.balance_sheet_section] ?? row.balance_sheet_section
      : "";
    return [statement, bucket, section].filter(Boolean).join(" · ");
  };

  return (
    <div className="flex min-h-screen flex-col bg-bg text-ink">
      <header className="mx-auto flex w-full max-w-[1040px] items-center justify-between gap-3 px-4 py-5 sm:px-8">
        <Link to="/" aria-label={S.home} className="flex items-center gap-3">
          <Logo size={26} compact />
        </Link>
        <div className="flex items-center gap-4">
          <Link to="/" className="text-[13px] text-ink-soft hover:text-ink">
            {S.home}
          </Link>
          <button
            type="button"
            data-testid="sample-lang-switch"
            onClick={() => setLanguage(other)}
            className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-soft hover:text-ink"
          >
            {S.otherLanguage}
          </button>
        </div>
      </header>

      <main
        data-testid="public-sample"
        data-sample-lang={lang}
        data-sample-as-of={data.as_of}
        className="mx-auto w-full max-w-[1040px] flex-1 px-4 pb-16 sm:px-8"
      >
        {/* ── what this is ─────────────────────────────────────────── */}
        <p className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.16em] text-brand-d">{S.eyebrow}</p>
        <h1 className="mt-3 max-w-[760px] text-[28px] font-medium leading-tight tracking-[-0.015em] text-ink sm:text-[36px]">
          {S.title}
        </h1>
        <p className="mt-4 max-w-[760px] text-[15px] leading-relaxed text-ink-soft">
          {fill(S.lede, { company: company.name })}
        </p>

        <div
          data-testid="sample-fictional-notice"
          className="mt-6 max-w-[760px] rounded-lg border border-caution bg-caution-tint p-4"
        >
          <p className="text-[13.5px] font-medium text-ink">{S.fictionalTitle}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
            {fill(S.fictionalBody, {
              fiscalCode: company.fiscal_code,
              tradeRegister: company.trade_register,
            })}
          </p>
        </div>

        <dl className="mt-6 grid max-w-[760px] grid-cols-1 gap-x-8 gap-y-3 text-[13px] sm:grid-cols-2">
          {[
            [S.facts.activity, `CAEN ${company.caen} · ${lang === "ro" ? company.caen_name_ro : company.caen_name_en}`],
            [S.facts.years, fill(S.yearsValue, { current: current.label, prior: prior.label })],
            [S.facts.accounts, fill(S.accountsValue, { n: integer(current.accounts, lang), period: current.label })],
            [S.facts.asOf, asOfDate(data.as_of, lang)],
          ].map(([term, value]) => (
            <div key={term} className="flex flex-col">
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">{term}</dt>
              <dd className="mt-0.5 text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        {/* ── the files ────────────────────────────────────────────── */}
        <Section id="downloads" title={S.downloadsTitle} lede={S.downloadsLede}>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map(({ key, file }) => {
              const opens = key === "report_html";
              return (
                <li key={key} className="flex flex-col rounded-lg border border-rule bg-surface p-4">
                  <span className="text-[14px] font-medium text-ink">{S.files[key].title}</span>
                  <span className="mt-1 flex-1 text-[12.5px] leading-relaxed text-ink-soft">{S.files[key].body}</span>
                  <span className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <a
                      data-testid={`sample-file-${key}`}
                      href={`${SAMPLE_FILES_BASE}${file.name}`}
                      {...(opens ? { target: "_blank", rel: "noopener" } : { download: file.name })}
                      className="rounded-md border border-rule-strong px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-hi"
                    >
                      {opens ? S.open : S.download}
                    </a>
                    <span className="break-all font-mono text-[10.5px] text-ink-mute">
                      {file.name}
                      {typeof file.bytes === "number"
                        ? ` · ${fill(S.sizeKb, { size: integer(Math.max(1, Math.round(file.bytes / 1024)), lang) })}`
                        : ""}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>

        {/* ── the figures ──────────────────────────────────────────── */}
        <Section id="figures" title={S.figuresTitle} lede={S.figuresLede}>
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full table-fixed border-collapse text-[13px]">
              <thead>
                <tr className="bg-surface text-left">
                  <th scope="col" className="w-[36%] px-3 py-2 font-medium text-ink-soft sm:w-[40%]">{S.figure}</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium text-ink-soft sm:px-3">{current.label}</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium text-ink-soft sm:px-3">{prior.label}</th>
                </tr>
              </thead>
              <tbody>
                {(current.figures as SampleFigure[]).map((f) => (
                  <tr key={f.key} data-testid={`sample-figure-${f.key}`} className="border-t border-rule-soft">
                    <th scope="row" className="px-3 py-2 text-left font-normal text-ink">
                      {S.figures[f.key] ?? f.key}
                    </th>
                    <td
                      data-period="current"
                      title={origin(servedFile("served_current"), f.pointer)}
                      className="px-2 py-2 text-right tabular-nums text-ink sm:px-3"
                    >
                      <MoneyCell printed={money(f.value)} />
                    </td>
                    <td
                      data-period="prior"
                      title={origin(servedFile("served_prior"), f.pointer)}
                      className="px-2 py-2 text-right tabular-nums text-ink-soft sm:px-3"
                    >
                      <MoneyCell printed={money(figure(prior, f.key))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mt-8 text-[15px] font-medium text-ink">{S.ratiosTitle}</h3>
          <p className="mt-1 max-w-[720px] text-[13px] leading-relaxed text-ink-soft">{S.ratiosLede}</p>
          <div className="mt-3 overflow-hidden rounded-lg border border-rule">
            <table className="w-full table-fixed border-collapse text-[13px]">
              <thead>
                <tr className="bg-surface text-left">
                  <th scope="col" className="w-[40%] px-3 py-2 font-medium text-ink-soft">{S.ratio}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium text-ink-soft">{current.label}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium text-ink-soft">{prior.label}</th>
                </tr>
              </thead>
              <tbody>
                {ratios.map((r) => (
                  <tr key={r.key} data-testid={`sample-ratio-${r.key}`} className="border-t border-rule-soft">
                    <th scope="row" className="px-3 py-2 text-left font-normal text-ink">
                      {ratioLabelForKey(r.key, lang) ?? r.key}
                    </th>
                    {(["current", "prior"] as const).map((which) => {
                      const side = r[which];
                      const band = sampleBand(side, lang);
                      return (
                        <td
                          key={which}
                          data-period={which}
                          title={origin(servedFile("served_comparatives"), `${r.pointer}/${which}`)}
                          className={`px-3 py-2 text-right tabular-nums ${which === "current" ? "text-ink" : "text-ink-soft"}`}
                        >
                          <span data-figure>{sampleRatio(side, r.display_unit, lang)}</span>
                          {band ? <span className="block text-[11px] text-ink-mute">{band}</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── the landing's proof list, on this book ───────────────── */}
        <div id="checks" className="scroll-mt-6">
          <Section id="checks" title={S.checksTitle} lede={S.checksLede}>
            <ol className="overflow-hidden rounded-lg border border-rule">
              {proofRows(lang).map((row, i) => (
                <li
                  key={row.id}
                  data-testid={`sample-check-${row.id}`}
                  data-proof-check={row.id}
                  className={`px-4 py-3 ${i > 0 ? "border-t border-rule-soft" : ""}`}
                >
                  <p data-proof-what className="text-[13.5px] font-medium leading-relaxed text-ink">
                    {row.what}
                  </p>
                  <p data-check-reading className="mt-1 text-[13px] leading-relaxed text-ink-soft">
                    {checkReading[row.id]}
                  </p>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-[12.5px]">
              <Link to="/" className="text-ink-soft underline underline-offset-2 hover:text-ink">
                {S.checksProofLink}
              </Link>
            </p>
          </Section>
        </div>

        {/* ── the verdicts ─────────────────────────────────────────── */}
        <Section id="verdicts" title={S.verdictsTitle} lede={S.verdictsLede}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Card testId="sample-verdict-balance" title={S.verdict.balanceTitle}>
              <p>
                {fill(S.verdict.balanceBody, {
                  status: (lang === "ro" ? v.balance.display_ro : v.balance.display_en) ?? v.balance.status,
                  assets: money(v.balance.assets),
                  liabilities: money(v.balance.equity_plus_liabilities),
                  difference: money(v.balance.served_difference),
                })}
              </p>
              <p className="text-ink-soft">
                {fill(S.verdict.balanceSource, { n: integer(v.balance.unmapped, lang) })}
              </p>
            </Card>

            <Card testId="sample-verdict-anchor" title={S.verdict.anchorTitle}>
              <p>{fill(S.verdict.anchorBody, { value: money(v.anchor.account_121) })}</p>
              <p className="text-ink-soft">
                {fill(S.verdict.anchorBridge, {
                  reconstructed: money(v.anchor.net_income_reconstructed),
                  variation: money(v.stock_variation.value),
                })}
              </p>
            </Card>

            <Card testId="sample-verdict-variation" title={S.verdict.variationTitle}>
              <p>{fill(S.verdict.variationBody, { value: money(v.stock_variation.value) })}</p>
              <EngineQuote
                lang={lang}
                text={lang === "ro" ? v.stock_variation.label_ro : v.stock_variation.label_en}
              />
            </Card>

            <Card testId="sample-verdict-ebitda" title={S.verdict.ebitdaTitle}>
              <p>{fill(S.verdict.ebitdaBody, { value: money(v.ebitda.value) })}</p>
              <p className="text-ink-soft">
                {fill(S.verdict.ebitdaVariants, { difference: money(v.ebitda.max_difference) })}
              </p>
              <ul className="text-[12.5px] text-ink-soft">
                {v.ebitda.variants.map((variant) => (
                  <li key={variant.key} data-testid={`sample-ebitda-${variant.key}`}>
                    {S.verdict.ebitdaVariantNames[variant.key] ?? variant.key}:{" "}
                    <span className="tabular-nums text-ink">{money(variant.engine)}</span>
                  </li>
                ))}
              </ul>
              <p className="break-all font-mono text-[11px] text-ink-mute">{v.ebitda.definition}</p>
            </Card>

            <Card testId="sample-verdict-credit" title={S.verdict.creditTitle}>
              <p>
                {fill(S.verdict.creditBody, {
                  letter: sampleRatio(ratios.find((r) => r.key === "letter_grade")!.current, "grade", lang),
                  composite: sampleRatio(ratios.find((r) => r.key === "credit_composite")!.current, "score", lang),
                  z: sampleRatio(ratios.find((r) => r.key === "altman_z")!.current, "z", lang),
                  zone: S.verdict.zones[v.credit.altman_zone] ?? v.credit.altman_zone,
                })}
              </p>
            </Card>

            <Card testId="sample-verdict-inventory" title={S.verdict.inventoryTitle}>
              <p>
                {fill(S.verdict.inventoryBody, {
                  days: printDaysQ(v.inventory_days.total_value_q, lang),
                  basis: lang === "ro" ? v.inventory_days.basis_label_ro : v.inventory_days.basis_label_en,
                })}
              </p>
              {v.inventory_days.seasonality_flagged ? (
                <p className="text-ink-soft">{S.verdict.inventorySeasonal}</p>
              ) : null}
            </Card>

            <Card testId="sample-verdict-cashflow" title={S.verdict.cashFlowTitle}>
              <p>{v.cash_flow.is_approximated ? S.verdict.cashFlowApproximated : S.verdict.cashFlowExact}</p>
            </Card>

            <Card testId="sample-verdict-findings" title={S.verdict.findingsTitle}>
              <p>{fill(S.verdict.findingsBody, { n: integer(v.insights.length, lang) })}</p>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-soft">
                {(v.insights_by_level as Array<{ level: string; count: number }>).map(({ level, count }) => (
                  <li key={level} data-testid={`sample-findings-${level}`}>
                    {S.verdict.levels[level] ?? level}: <span className="tabular-nums text-ink">{integer(count, lang)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <p className="mt-6 text-[12.5px] text-ink-mute">{S.verdict.findingsEnglish}</p>
          <ul className="mt-2 space-y-3">
            {v.insights.map((item) => (
              <li key={item.id} data-testid={`sample-finding-${item.id}`} className="rounded-lg border border-rule p-4">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
                  {S.verdict.levels[item.level] ?? item.level}
                </span>
                <p lang="en" data-engine-words="en" className="mt-1 text-[13.5px] font-medium text-ink">
                  {item.title}
                </p>
                <div className="mt-1.5">
                  <EngineQuote lang="en" text={item.claim} />
                </div>
              </li>
            ))}
          </ul>
        </Section>

        {/* ── the uncertainty labels ───────────────────────────────── */}
        <Section
          id="labels"
          title={S.labelsTitle}
          lede={fill(S.labelsLede, { n: integer(labels.length, lang) })}
        >
          <ul className="space-y-3">
            {labels.map((label) => {
              const { text, quotedIn } = labelQuote(label, lang);
              return (
                <li key={label.key} data-testid={`sample-label-${label.key}`} className="rounded-lg border border-rule p-4">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="rounded-sm border border-rule-strong px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-soft">
                      {S.kinds[label.kind] ?? label.kind}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                      {S.areas[label.area] ?? label.area}
                    </span>
                  </span>
                  <p className="mt-2 text-[13.5px] font-medium text-ink">{labelTitle(label)}</p>
                  <p className="mt-2 text-[11.5px] text-ink-mute">
                    {quotedIn === lang ? S.engineWords : S.engineWordsEnglishOnly}
                  </p>
                  <div className="mt-1">
                    <EngineQuote lang={quotedIn} text={text} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>

        {/* ── the mapping ──────────────────────────────────────────── */}
        <Section
          id="mapping"
          title={S.mappingTitle}
          lede={fill(S.mappingLede, { n: integer(mapping.length, lang) })}
        >
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full table-fixed border-collapse text-[12.5px]">
              <thead>
                <tr className="bg-surface text-left">
                  <th scope="col" className="w-[58px] px-3 py-2 font-medium text-ink-soft sm:w-[72px]">
                    {S.mappingColumns.account}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium text-ink-soft">{S.mappingColumns.name}</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium text-ink-soft md:table-cell">
                    {S.mappingColumns.line}
                  </th>
                  <th scope="col" className="w-[34%] px-2 py-2 text-right font-medium text-ink-soft sm:w-[26%] sm:px-3 md:w-[20%]">
                    {S.mappingColumns.amount}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shownMapping.map((row) => (
                  <tr key={row.account} data-testid={`sample-account-${row.account}`} className="border-t border-rule-soft align-top">
                    <td className="px-3 py-2 font-mono text-ink">{row.account}</td>
                    <td className="break-words px-3 py-2 text-ink">
                      {row.account_name}
                      <span data-mapping-line className="mt-0.5 block text-[11.5px] text-ink-mute md:hidden">
                        {lineOf(row)}
                      </span>
                      {row.note ? (
                        <span className="mt-0.5 block text-[11.5px] text-ink-mute">
                          {fill(S.mappingNoteDerived, { value: money(row.note.value) })}
                        </span>
                      ) : null}
                    </td>
                    <td data-mapping-line className="hidden break-words px-3 py-2 text-ink-soft md:table-cell">
                      {lineOf(row)}
                      {row.balance_sheet_row ? (
                        <span className="block break-all font-mono text-[10.5px] text-ink-mute">{row.balance_sheet_row}</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-ink sm:px-3">
                      {row.amount_ron === null ? "" : <MoneyCell printed={money(row.amount_ron)} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mapping.length > MAPPING_PREVIEW ? (
            <button
              type="button"
              data-testid="sample-mapping-toggle"
              aria-expanded={allAccounts}
              onClick={() => setAllAccounts((open) => !open)}
              className="mt-3 rounded-md border border-rule-strong px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-hi"
            >
              {allAccounts ? S.showFewer : fill(S.showAll, { n: integer(mapping.length, lang) })}
            </button>
          ) : null}
        </Section>

        {/* ── how it is made ───────────────────────────────────────── */}
        <Section id="how" title={S.howTitle}>
          <ol className="max-w-[760px] list-decimal space-y-2 pl-5 text-[13.5px] leading-relaxed text-ink-soft">
            {S.howSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-3 max-w-[760px] text-[13.5px] leading-relaxed text-ink-soft">{S.howGate}</p>

          <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
            <Card testId="sample-engine" title={S.engineTitle}>
              <dl className="space-y-1.5 text-[12.5px]">
                {Object.entries(S.engine).map(([key, term]) => (
                  <div key={key} className="flex flex-col">
                    <dt className="text-ink-mute">{term}</dt>
                    <dd className="break-all font-mono text-[11.5px] text-ink">
                      {String((data.engine as Record<string, unknown>)[key] ?? "")}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
            <Card testId="sample-not-included" title={S.notIncludedTitle}>
              <ul className="list-disc space-y-1.5 pl-4 text-[13px] text-ink-soft">
                {S.notIncluded.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Card>
          </div>
        </Section>

        {/* ── next ─────────────────────────────────────────────────── */}
        <section data-testid="sample-cta" className="mt-12 rounded-lg border border-rule bg-surface p-6">
          <h2 className="text-[18px] font-medium text-ink">{S.ctaTitle}</h2>
          <p className="mt-1 text-[13.5px] text-ink-soft">{S.ctaBody}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link to="/signup" className="rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-bg hover:bg-ink-2">
              {S.ctaPrimary}
            </Link>
            <Link to="/" className="rounded-md border border-rule-strong px-4 py-2 text-[13px] font-medium text-ink hover:bg-surface-hi">
              {S.ctaSecondary}
            </Link>
          </div>
        </section>
      </main>

      <LegalFooter />
    </div>
  );
}
