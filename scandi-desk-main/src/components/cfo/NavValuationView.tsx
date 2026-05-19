// EPRA NAV cascade renderer — PRIMARY VALUATION FOR CRE.
//
// Replaces DCF + EV/EBITDA as the headline for real-estate entities.
// Surfaces three EPRA layers (Book / Adjusted / NNNAV), the asset-
// adjustment ladder traceable to RO COA codes, a 3×3 sensitivity matrix,
// cross-method convergence, and the use-case mapping that tells the CFO
// which layer to cite for which conversation (refinancing, covenant,
// trade sale, family transfer).
//
// DCF and EV/Revenue are hidden for CRE via industry routing in the
// parent component — they remain available for SaaS / manufacturing.

import type { NavCascade, NavLayer } from "@/lib/navStructure";
import { formatRON, formatRONSigned, formatPercent } from "@/lib/formatRon";
import "./navValuationView.css";

interface Props {
  cascade: NavCascade;
  entity: string;
  period: string;
  currency: string;
}

function fmtShort(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}${(a / 1_000).toFixed(0)}K`;
  return `${sign}${a.toFixed(0)}`;
}

export function NavValuationView({ cascade, entity, period, currency }: Props) {
  const primary = cascade.layers.find((l) => l.layer === 3)!;
  const layer1 = cascade.layers.find((l) => l.layer === 1)!;
  const layer2 = cascade.layers.find((l) => l.layer === 2)!;
  const sensValues = cascade.sensitivityNnnav.map((s) => s.nnnav);
  const sensLow = Math.min(...sensValues);
  const sensHigh = Math.max(...sensValues);

  return (
    <div className="nav-valuation-view" data-testid="nav-valuation-view">
      {/* ── HERO: NNNAV central + range ─────────────────────────────── */}
      <header className="nav-hero">
        <div className="nav-hero-central">
          <div className="nav-hero-num">{fmtShort(primary.value)}M</div>
          <div className="nav-hero-unit">{currency} equity value · NNNAV</div>
          <div className="nav-hero-label">EPRA NNNAV — Primary</div>
        </div>
        <div className="nav-hero-text">
          <p>
            <strong>Indicative equity value: {fmtShort(sensLow)}M – {fmtShort(sensHigh)}M {currency}</strong>.
            Primary number is the EPRA NNNAV (Layer 3) of {formatRON(primary.value)} for{" "}
            {entity} as of {period}.
          </p>
          {cascade.crossMethods.convergenceConfidence === "high" && (
            <p className="nav-hero-convergence">
              ✓ Three asset-aware methods (NNNAV, cap rate, Graham) converge in{" "}
              {fmtShort(cascade.crossMethods.convergenceBand[0])}M –{" "}
              {fmtShort(cascade.crossMethods.convergenceBand[1])}M.
            </p>
          )}
        </div>
      </header>

      {/* ── METHODOLOGY EXPLAINER (collapsed by default) ────────────── */}
      <details className="nav-methodology" data-testid="nav-methodology">
        <summary><strong>Why NAV (not DCF or EV/EBITDA) for CRE?</strong></summary>
        <p>
          Single-asset commercial real estate values on <em>net asset value with
          property marked to market</em>, not on operating-earnings multiples or
          discounted cash flow. This is the IFRS-aligned standard used by EPRA-
          reporting real estate companies and Romanian banking covenants.
        </p>
        <ul>
          <li>
            <strong>EV/EBITDA</strong> systematically undervalues real estate by
            30–50% because it captures operating earnings but ignores the
            underlying property asset value. Shown below as secondary with
            explicit caveat — used as a negotiation floor, not as primary anchor.
          </li>
          <li>
            <strong>DCF</strong> treats real estate as a perpetual cash-flow
            stream rather than an appreciating asset, systematically
            understating value. Not rendered for CRE; available for SaaS /
            manufacturing entities via the industry router.
          </li>
          <li>
            <strong>NAV cascade</strong> (Book / Adjusted / NNNAV) is the
            EPRA-aligned standard. Each layer answers a different question; the
            "Which number for which use case" table at the bottom maps them to
            specific conversations (refinancing, covenant, trade sale).
          </li>
        </ul>
      </details>

      {/* ── LAYER CASCADE: Book / Adjusted / NNNAV ──────────────────── */}
      <section className="nav-layers" data-testid="nav-layers">
        <h3>The NAV cascade — three answers for three use cases</h3>
        <div className="nav-layer-grid">
          {cascade.layers.map((layer) => (
            <NavLayerCard
              key={layer.layer}
              layer={layer}
              isPrimary={layer.layer === 3}
              currency={currency}
            />
          ))}
        </div>
        <p className="nav-layer-caption">
          Layer 1 is the legal floor. Layer 2 is the upper bound (gross of tax).
          Layer 3 — NNNAV — is the defensible single number for a banker or
          counterparty conversation.
        </p>
      </section>

      {/* ── ASSET ADJUSTMENT LADDER ─────────────────────────────────── */}
      <section className="nav-adjustments" data-testid="nav-adjustments">
        <h3>Asset adjustment ladder — Book to Adjusted, account by account</h3>
        <div className="nav-table-wrap">
          <table className="nav-adjustment-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Account</th>
                <th className="num">Book value</th>
                <th>Method</th>
                <th className="num">Fair value</th>
                <th className="num">Uplift</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {cascade.assetAdjustments.map((adj) => (
                <tr key={adj.accountCode}>
                  <td className="code">{adj.accountCode}</td>
                  <td className="acct">{adj.accountName}</td>
                  <td className="num">{formatRON(adj.bookValue)}</td>
                  <td className="method">{adj.adjustmentMethod}</td>
                  <td className="num">{formatRON(adj.goingConcernFairValue)}</td>
                  <td
                    className={`num ${adj.goingConcernUplift > 0 ? "pos" : adj.goingConcernUplift < 0 ? "neg" : ""}`}
                  >
                    {adj.goingConcernUplift === 0
                      ? "—"
                      : adj.goingConcernUplift > 0
                        ? formatRONSigned(adj.goingConcernUplift, "positive")
                        : formatRONSigned(adj.goingConcernUplift, "negative")}
                  </td>
                  <td className="notes">{adj.notes}</td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={5}>
                  <strong>Total asset uplift (going concern)</strong>
                </td>
                <td className="num pos">
                  <strong>
                    {cascade.totalAssetUpliftGoingConcern >= 0
                      ? formatRONSigned(cascade.totalAssetUpliftGoingConcern, "positive")
                      : formatRONSigned(cascade.totalAssetUpliftGoingConcern, "negative")}
                  </strong>
                </td>
                <td>
                  Layer 1 Book ({formatRON(layer1.value)}) → Layer 2 Adjusted ({formatRON(layer2.value)})
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ── HIDDEN ITEMS (if any surfaced) ──────────────────────────── */}
      {cascade.hiddenItems.length > 0 && (
        <section className="nav-hidden-items" data-testid="nav-hidden-items">
          <h3>Hidden items surfaced</h3>
          <p>Items not on the balance sheet but material to fair value.</p>
          <ul>
            {cascade.hiddenItems.map((item, i) => (
              <li key={i} className={`nav-hidden-item nav-hidden-${item.type}`}>
                <strong>
                  {item.type === "asset" ? "+" : "−"} {formatRON(item.estimatedValue)}
                </strong>{" "}
                {item.description}{" "}
                <span className="nav-confidence">({item.confidence} confidence)</span>
                <div className="nav-evidence">{item.evidence}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── SENSITIVITY MATRIX: cap rate × affiliate yield ──────────── */}
      <section className="nav-sensitivity" data-testid="nav-sensitivity">
        <h3>NNNAV sensitivity — cap rate × affiliate yield</h3>
        <div className="nav-table-wrap">
          <table className="nav-sensitivity-table">
            <thead>
              <tr>
                <th></th>
                <th className="num">Affiliate yield 8%</th>
                <th className="num">Affiliate yield 10%</th>
                <th className="num">Affiliate yield 12%</th>
              </tr>
            </thead>
            <tbody>
              {[0.07, 0.08, 0.09].map((cr) => (
                <tr key={cr}>
                  <th>Cap rate {(cr * 100).toFixed(1)}%</th>
                  {[0.08, 0.10, 0.12].map((ay) => {
                    const cell = cascade.sensitivityNnnav.find(
                      (s) =>
                        Math.abs(s.capRate - cr) < 0.001 &&
                        Math.abs(s.affiliateYield - ay) < 0.001,
                    );
                    const isCentral =
                      Math.abs(cr - cascade.keyAssumptions.capRateCentral) < 0.001 &&
                      Math.abs(ay - cascade.keyAssumptions.affiliateYieldCentral) < 0.001;
                    return (
                      <td
                        key={ay}
                        className={`num ${isCentral ? "central" : ""}`}
                      >
                        {cell ? formatRON(cell.nnnav) : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="nav-caption">
          Central case ({(cascade.keyAssumptions.capRateCentral * 100).toFixed(1)}% cap rate,{" "}
          {(cascade.keyAssumptions.affiliateYieldCentral * 100).toFixed(0)}% affiliate yield)
          highlighted. Basis: {cascade.keyAssumptions.capRateBasis}.
        </p>
      </section>

      {/* ── CROSS-METHOD CONVERGENCE ────────────────────────────────── */}
      <section className="nav-convergence" data-testid="nav-convergence">
        <h3>Cross-method convergence</h3>
        <div className="nav-table-wrap">
          <table className="nav-convergence-table">
            <tbody>
              <tr className="primary-row">
                <td>
                  <strong>NNNAV (primary)</strong>
                </td>
                <td className="num">
                  <strong>{formatRON(primary.value)}</strong>
                </td>
              </tr>
              <tr>
                <td>Cap rate method</td>
                <td className="num">{formatRON(cascade.crossMethods.capRate)}</td>
              </tr>
              <tr>
                <td>Graham intrinsic value</td>
                <td className="num">{formatRON(cascade.crossMethods.graham)}</td>
              </tr>
              <tr className="secondary">
                <td>
                  EV/EBITDA <span className="nav-caveat-tag">caveat</span>
                </td>
                <td className="num">{formatRON(cascade.crossMethods.evEbitda)}</td>
              </tr>
              <tr className="convergence-row">
                <td>
                  <strong>Convergence band</strong>
                </td>
                <td className="num">
                  <strong>
                    {fmtShort(cascade.crossMethods.convergenceBand[0])}M –{" "}
                    {fmtShort(cascade.crossMethods.convergenceBand[1])}M
                  </strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="nav-caveat-text">
          The EV/EBITDA result of {fmtShort(cascade.crossMethods.evEbitda)}M sits below
          the convergence band — this is the expected pattern for asset-yielding
          businesses. It captures operating cash flow without crediting the
          property asset value.
        </p>
      </section>

      {/* ── USE-CASE MAPPING ────────────────────────────────────────── */}
      <section className="nav-use-cases" data-testid="nav-use-cases">
        <h3>Which number for which use case</h3>
        <div className="nav-table-wrap">
          <table className="nav-use-case-table">
            <thead>
              <tr>
                <th>Use case</th>
                <th>Layer</th>
                <th className="num">Value</th>
                <th>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {(
                Object.entries(cascade.useCaseMapping) as Array<
                  [keyof typeof cascade.useCaseMapping, { layer: 1 | 2 | 3 | 4; rationale: string }]
                >
              ).map(([key, mapping]) => {
                const layer = cascade.layers.find((l) => l.layer === mapping.layer);
                return (
                  <tr key={key}>
                    <td>{prettifyUseCase(key)}</td>
                    <td>
                      Layer {mapping.layer} — {layer?.name}
                    </td>
                    <td className="num">{formatRON(layer?.value ?? 0)}</td>
                    <td className="rationale">{mapping.rationale}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── KEY ASSUMPTIONS (audit-trail footer) ────────────────────── */}
      <section className="nav-assumptions" data-testid="nav-assumptions">
        <h3>Key assumptions</h3>
        <ul>
          <li>
            <strong>Cap rate (central):</strong> {formatPercent(cascade.keyAssumptions.capRateCentral)} ·{" "}
            range {formatPercent(cascade.keyAssumptions.capRateRange[0])}–
            {formatPercent(cascade.keyAssumptions.capRateRange[1])}
          </li>
          <li>
            <strong>Affiliate yield (central):</strong>{" "}
            {formatPercent(cascade.keyAssumptions.affiliateYieldCentral)} · range{" "}
            {formatPercent(cascade.keyAssumptions.affiliateYieldRange[0])}–
            {formatPercent(cascade.keyAssumptions.affiliateYieldRange[1])}
          </li>
          <li>
            <strong>Romanian CIT:</strong> {formatPercent(cascade.keyAssumptions.citRate)} — applied
            to revaluation uplift + existing 105 reserve for the Layer 2 → Layer 3 step
          </li>
          <li>
            <strong>Basis:</strong> {cascade.keyAssumptions.capRateBasis}
          </li>
        </ul>
      </section>
    </div>
  );
}

function NavLayerCard({
  layer,
  isPrimary,
  currency,
}: {
  layer: NavLayer;
  isPrimary: boolean;
  currency: string;
}) {
  return (
    <div
      className={`nav-layer-card${isPrimary ? " is-primary" : ""}`}
      data-testid={`nav-layer-${layer.layer}`}
    >
      {isPrimary && <span className="nav-primary-badge">PRIMARY</span>}
      <div className="nav-layer-label">Layer {layer.layer}</div>
      <div className="nav-layer-name">{layer.name}</div>
      <div className="nav-layer-value">
        {formatRON(layer.value)} <span className="nav-layer-ccy">{currency}</span>
      </div>
      <div className="nav-layer-description">{layer.description}</div>
      <div className="nav-layer-use-cases">
        <strong>Use for:</strong> {layer.useCases.join(" · ")}
      </div>
    </div>
  );
}

function prettifyUseCase(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .replace(/\bN N N A V\b/g, "NNNAV");
}
