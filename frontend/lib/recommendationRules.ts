// recommendationRules.ts — deterministic detection over PeriodFacts.
//
// Each rule examines the canonical facts and (when triggered) returns a
// structured Condition with severity + factsCited. The narrative
// (rationale + actions + what-not-to-do) is generated separately — by
// the Opus 4.7 backend pipeline call, or by static labels for offline
// rendering. Same facts always produce the same set of conditions.
//
// CRITICAL: every numeric trigger reads STATUTORY values explicitly. The
// "true_*" rules (true_negative_ebitda, true_debt_service_distress,
// true_distress_altman) only fire when the underlying condition is real
// on statutory inputs — they would have stayed silent on EEI because
// statutory EBITDA is +RON 2.13M, DSCR is 1.43×, Altman Z" is ~3.15
// (safe zone). The old rules fired on operational EBITDA / Altman Z'
// and produced the "engage restructuring advisor / waive covenant"
// recommendations that would have damaged the Patria relationship.
//
// Industry-aware: each rule can declare `industries: [...]` to scope.
// CRE-only rules (tenant_concentration_renewal) won't fire for SaaS
// companies; generic-business rules (intercompany_receivable_recall)
// fire across industries when the condition is met.

import type { PeriodFacts } from "./periodFacts";

export type Severity = "info" | "attention" | "critical";

export interface DetectedCondition {
  ruleKey: string;
  severity: Severity;
  title: string;
  factsCited: Record<string, number>;
  /** Static rationale — used when Opus narrative isn't available. */
  rationaleFallback: string;
  /** Static action list — used when Opus narrative isn't available. */
  actionsFallback: string[];
  /** Static "what not to do" warning. */
  whatNotToDoFallback?: string;
}

// ─── Rule registry ──────────────────────────────────────────────────────

interface Rule {
  key: string;
  /** When set, the rule only fires for these industries. Omit = all. */
  industries?: string[];
  detect: (facts: PeriodFacts) => DetectedCondition | null;
}

const RON = (n: number) => `RON ${Math.round(n).toLocaleString()}`;

const RULES: Rule[] = [
  // ══════════════════════════════════════════════════════════════════
  // ACTIONABLE OPPORTUNITIES — fire when conditions are favorable
  // ══════════════════════════════════════════════════════════════════

  // R1. Refinance opportunity (info)
  // Fires when DSCR is healthy AND adjusted leverage is bankable —
  // signals there's room to negotiate better terms with the lender.
  {
    key: "refinance_opportunity",
    detect: (f) => {
      const dscr = f.ratios.dscr;
      const dteAdj = f.ratios.debt_to_ebitda_adjusted;
      if (
        dscr <= 1.35 ||
        dteAdj <= 0 ||
        dteAdj >= 6.0 ||
        f.bs.bank_debt_total < 1_000_000
      ) {
        return null;
      }
      const currentRate = f.pl.interest_expense / Math.max(f.bs.bank_debt_total, 1);
      const savings50bps = f.bs.bank_debt_total * 0.005;
      return {
        ruleKey: "refinance_opportunity",
        severity: "info",
        title: `Refinance window: DSCR ${dscr.toFixed(2)}× and adjusted Debt/EBITDA ${dteAdj.toFixed(2)}× are bankable`,
        factsCited: {
          dscr,
          debt_to_ebitda_adjusted: dteAdj,
          bank_debt_total: f.bs.bank_debt_total,
          interest_expense: f.pl.interest_expense,
          current_rate: currentRate,
          potential_savings_per_50bps: savings50bps,
        },
        rationaleFallback:
          `DSCR ${dscr.toFixed(2)}× and adjusted Debt/EBITDA ${dteAdj.toFixed(2)}× ` +
          `(including ${RON(f.pl.dividend_income)} dividend income from participations) ` +
          `put the company in bankable territory. Current rate ~${(currentRate * 100).toFixed(2)}% ` +
          `(${RON(f.pl.interest_expense)} interest on ${RON(f.bs.bank_debt_total)} debt) ` +
          `is worth testing against competing offers — every 50bps saved is ${RON(savings50bps)}/year.`,
        actionsFallback: [
          "Request indicative term sheets from 2–3 alternative lenders (BCR, ING Romania, Banca Transilvania) for refinancing 30-50% of the current balance.",
          "Frame as syndication, not full replacement, to keep the existing lender relationship intact.",
          "Time the refinance to before the next major capex drawdown so the new lender prices the post-capex cash flow profile.",
          "Negotiate the covenant package: target DSCR floor 1.25×, LTV ceiling 75%, no MAC clauses tied to single-tenant risk.",
        ],
        whatNotToDoFallback:
          "Don't ask the incumbent lender for a rate cut without alternatives in hand — without competing offers, there's no leverage.",
      };
    },
  },

  // R2. Lender concentration (medium)
  // Fires when 95%+ of bank debt sits with one lender — structural risk
  // that caps the credit rating regardless of operating performance.
  {
    key: "lender_concentration",
    detect: (f) => {
      const conc = f.bs.lender_concentration_pct;
      if (conc === undefined || conc < 0.95 || f.bs.bank_debt_total < 3_000_000) {
        return null;
      }
      const splitMin = f.bs.bank_debt_total * 0.3;
      const splitMax = f.bs.bank_debt_total * 0.5;
      return {
        ruleKey: "lender_concentration",
        severity: "attention",
        title: `Single-lender concentration: ${(conc * 100).toFixed(0)}% of ${RON(f.bs.bank_debt_total)} debt with one bank`,
        factsCited: {
          bank_debt_total: f.bs.bank_debt_total,
          lender_concentration_pct: conc,
          suggested_split_min: splitMin,
          suggested_split_max: splitMax,
        },
        rationaleFallback:
          `${(conc * 100).toFixed(0)}% of the company's ${RON(f.bs.bank_debt_total)} bank debt sits with a single lender. ` +
          `A single-lender concentration creates rating sensitivity (any covenant issue becomes existential) ` +
          `and limits negotiating leverage on rate / amortization terms. Splitting 30-50% to a second lender ` +
          `removes the single-counterparty rating cap without changing P&L.`,
        actionsFallback: [
          `Identify ${RON(splitMin)}–${RON(splitMax)} of total debt to refinance with a second lender.`,
          "Maintain the existing lender relationship for the rest — the goal is diversification, not replacement.",
          "Use the syndication conversation (see Refinance window card) as the mechanism.",
          "Time the split with the next covenant reset window so the new facility prices fresh.",
        ],
      };
    },
  },

  // R3. Tenant concentration (medium/high) — CRE only
  // Fires when one tenant >70% of rental revenue. Lease renewal becomes
  // the single most important capital-structure decision.
  {
    key: "tenant_concentration_renewal",
    industries: ["real_estate_commercial", "real_estate_residential"],
    detect: (f) => {
      const conc = f.bs.tenant_concentration_pct;
      if (conc === undefined || conc < 0.7) return null;
      const revAtRisk = f.pl.rental_revenue * conc;
      return {
        ruleKey: "tenant_concentration_renewal",
        severity: conc > 0.9 ? "critical" : "attention",
        title: `Tenant concentration: top tenant = ${(conc * 100).toFixed(0)}% of ${RON(f.pl.rental_revenue)} rental revenue`,
        factsCited: {
          top_tenant_pct: conc,
          rental_revenue: f.pl.rental_revenue,
          revenue_at_risk: revAtRisk,
        },
        rationaleFallback:
          `The top tenant represents ${(conc * 100).toFixed(0)}% of rental revenue ` +
          `(${RON(revAtRisk)} of ${RON(f.pl.rental_revenue)}). Losing this tenant without a 12-month replacement ` +
          `would compress EBITDA materially and likely breach the 1.25× DSCR covenant. ` +
          `Securing the next lease term is the most important capital-structure decision this year.`,
        actionsFallback: [
          "Open the renewal conversation 12-18 months before current term expiry.",
          "Push for a 5-7 year term with CPI indexation (caps FX risk on EUR-denominated rent).",
          "Include early-termination penalty clauses sized to the cost of replacement marketing + downtime.",
          "Identify 2-3 backup tenants for the same property type so the renewal negotiation has a real BATNA.",
        ],
        whatNotToDoFallback:
          "Don't wait for the tenant to initiate the renewal — the side that opens the conversation sets the anchor on rent and term.",
      };
    },
  },

  // R4. Intercompany receivable recall (medium/high)
  // Material RON sitting in related-party receivables while interest is
  // paid on senior debt. Recall + prepay = pure capital-structure win.
  {
    key: "intercompany_receivable_recall",
    detect: (f) => {
      const ic = f.bs.intercompany_loans;
      const pct = ic / Math.max(f.bs.total_assets, 1);
      if (ic <= 500_000 || pct <= 0.05) return null;
      const currentRate = f.pl.interest_expense / Math.max(f.bs.bank_debt_total, 1);
      const interestSavings = ic * currentRate;
      const newDte =
        f.pl.ebitda > 0 ? (f.bs.bank_debt_total - ic) / f.pl.ebitda : 0;
      return {
        ruleKey: "intercompany_receivable_recall",
        severity: pct > 0.15 ? "critical" : "attention",
        title: `Recall ${RON(ic)} intercompany receivable to prepay senior debt`,
        factsCited: {
          intercompany_loans: ic,
          total_assets: f.bs.total_assets,
          pct_of_assets: pct,
          bank_debt_total: f.bs.bank_debt_total,
          current_rate: currentRate,
          interest_savings_if_repaid: interestSavings,
          new_debt_to_ebitda: newDte,
        },
        rationaleFallback:
          `Account 461 (Sundry debtors) holds ${RON(ic)} in intercompany receivables — ` +
          `${(pct * 100).toFixed(1)}% of total assets sitting unproductively while the company pays ` +
          `~${(currentRate * 100).toFixed(2)}% interest on senior bank debt. Recalling the receivable ` +
          `and using it to prepay would reduce annual interest by ${RON(interestSavings)} and drop ` +
          `Debt/EBITDA from ${f.ratios.debt_to_ebitda.toFixed(2)}× to ${newDte.toFixed(2)}× (more bankable territory).`,
        actionsFallback: [
          `Confirm with the related party that the ${RON(ic)} receivable is recoverable in cash within 90 days.`,
          "Structure the recall as a formal repayment (debt-vs-debt offset, not a fresh loan) to avoid tax / AGM complications.",
          "Apply proceeds to senior principal; request the lender update the amortization schedule.",
          "Document the transaction for the audit trail — related-party movements draw scrutiny from RO tax authorities.",
        ],
        whatNotToDoFallback:
          "Don't paper over the receivable with another loan refresh — that just rolls the problem forward.",
      };
    },
  },

  // R5a. Covenant documentation audit (critical)
  // Fires for any company with > RON 3M of bank debt and 100% lender
  // concentration — the loan agreements' actual covenant package needs
  // to be known before any other capital-structure recommendation can be
  // sized. Zero cash cost; pure information gain.
  {
    key: "covenant_documentation_audit",
    detect: (f) => {
      const conc = f.bs.lender_concentration_pct;
      if (
        f.bs.bank_debt_total < 3_000_000 ||
        conc === undefined ||
        conc < 0.95
      ) {
        return null;
      }
      return {
        ruleKey: "covenant_documentation_audit",
        severity: "critical",
        title: `Pull the loan agreements — full covenant audit before any other capital-structure move`,
        factsCited: {
          bank_debt_total: f.bs.bank_debt_total,
          lender_concentration_pct: conc,
          interest_expense: f.pl.interest_expense,
        },
        rationaleFallback:
          `${(conc * 100).toFixed(0)}% of debt sits with one lender on terms not yet documented in this analysis. ` +
          `Without the actual loan agreements, the covenant headroom estimates (DSCR ${f.ratios.dscr.toFixed(2)}× vs typical 1.25×, ` +
          `equity ratio ${(f.ratios.equity_ratio * 100).toFixed(1)}% vs typical 30% floor) are estimates — ` +
          `the exact triggers depend on the contract package.`,
        actionsFallback: [
          "Within 1 week, obtain complete loan documentation: interest rate structure (fixed vs EURIBOR + margin), prepayment penalties and cure provisions, full covenant package (DSCR / LTV / Debt-EBITDA / equity-ratio thresholds + measurement frequency), cross-default provisions between contracts, MAC clauses.",
          "Catalogue covenant test dates so the monitoring dashboard (see related card) aligns with the compliance cycle.",
          "Identify cure mechanics — equity injection, partial prepayment, asset sale — for each covenant so a remediation plan exists before any trigger.",
        ],
        whatNotToDoFallback:
          "Don't approach the lender for any modification (rate, term, syndication) before having the current terms in hand — without the baseline, there's no leverage.",
      };
    },
  },

  // R5b. Property tax reassessment provision (medium) — CRE only
  // Bucharest authorities periodically revalue commercial property. A
  // 50% reassessment spike on a multi-million property book can take
  // DSCR from comfortable to tight without warning.
  {
    key: "property_tax_reassessment_provision",
    industries: ["real_estate_commercial", "real_estate_residential"],
    detect: (f) => {
      const propBook = f.bs.investment_property_net;
      if (propBook < 5_000_000) return null;
      // Estimate downside: 50% reassessment on 1% effective rate = 0.5% of book
      const downsideImpact = propBook * 0.005 * 0.5;
      const provisionTarget = Math.max(downsideImpact * 1.2, 50_000);
      return {
        ruleKey: "property_tax_reassessment_provision",
        severity: "attention",
        title: `Build a ${RON(provisionTarget)} provision for property tax reassessment`,
        factsCited: {
          investment_property_net: propBook,
          downside_impact_estimate: downsideImpact,
          provision_target: provisionTarget,
          dscr_current: f.ratios.dscr,
        },
        rationaleFallback:
          `Investment property carries ${RON(propBook)} at book; Romanian municipalities periodically revalue commercial property. ` +
          `A 50% reassessment spike on a property of this size would add roughly ${RON(downsideImpact)} of annual property tax — ` +
          `survivable, but it would tighten DSCR from ${f.ratios.dscr.toFixed(2)}× toward the covenant floor unnecessarily.`,
        actionsFallback: [
          "Pre-engage a property tax advisor to model the reassessment scenario and prepare a defense package (comparable transactions, building condition, lease terms).",
          `Build a ${RON(provisionTarget)} balance-sheet provision against the contingency.`,
          "Time the provision build with the lender review cycle so the protection is visible at the next covenant test.",
        ],
      };
    },
  },

  // R5c. Covenant monitoring dashboard (medium)
  // Fires for any company with > RON 3M bank debt — annual visibility on
  // DSCR / D-EBITDA / equity ratio is too coarse to catch silent breaches.
  {
    key: "covenant_monitoring_dashboard",
    detect: (f) => {
      if (f.bs.bank_debt_total < 3_000_000) return null;
      return {
        ruleKey: "covenant_monitoring_dashboard",
        severity: "attention",
        title: `Stand up monthly DSCR / Debt-EBITDA monitoring dashboard`,
        factsCited: {
          dscr_current: f.ratios.dscr,
          debt_to_ebitda_current: f.ratios.debt_to_ebitda,
          bank_debt_total: f.bs.bank_debt_total,
        },
        rationaleFallback:
          `Annual covenant testing leaves blind spots between reviews — a single bad quarter (vacancy, FX, unplanned capex) ` +
          `can push DSCR below the floor without anyone noticing until the formal test. Current DSCR ${f.ratios.dscr.toFixed(2)}× and ` +
          `Debt/EBITDA ${f.ratios.debt_to_ebitda.toFixed(2)}× have meaningful headroom — the time to install monitoring is now, not after the first warning.`,
        actionsFallback: [
          "Implement three-tier monthly tracking: GREEN (DSCR > 1.50× / D-EBITDA < 5.5×), AMBER (1.30-1.50× / 5.5-6.5×), RED (< 1.30× / > 6.5×).",
          "AMBER triggers management review; RED triggers proactive lender engagement before the formal covenant test.",
          "Wire the dashboard to the monthly close; ~2 hours of bookkeeping per month to maintain.",
        ],
      };
    },
  },

  // R5d. CIP project resolution (medium) — fires when CIP capex is
  // material and the company has a clear cash drag from the build-out.
  {
    key: "cip_project_resolution",
    detect: (f) => {
      const cipCapex = f.pl.capitalized_own_work_memo; // 722 proxy for CIP additions
      const fcf = f.cf.cash_from_operating + f.cf.cash_used_in_investing;
      if (cipCapex < 500_000 || fcf >= 0) return null;
      return {
        ruleKey: "cip_project_resolution",
        severity: "attention",
        title: `Resolve CIP project — define completion timeline and expected rental uplift`,
        factsCited: {
          cip_additions: cipCapex,
          cfo: f.cf.cash_from_operating,
          capex: f.cf.cash_used_in_investing,
          fcf,
          cash_balance: f.bs.cash,
        },
        rationaleFallback:
          `Account 231 (Construction in progress) grew by ${RON(cipCapex)} this period — the largest single cash drain ` +
          `of the year. The work is not yet generating return; FCF before financing was ${RON(fcf)} specifically because of this build-out. ` +
          `Until completion, every month of delay extends the cash-runway pressure.`,
        actionsFallback: [
          "Define a hard completion timeline with monthly milestones; assign accountability per milestone.",
          "Model the expected rental uplift (if the work expands lettable area or upgrades the asset) and the payback period.",
          "If the project does not generate clear post-completion rental income, defer remaining non-essential capex until cash position recovers.",
          "Communicate the timeline to the lender — they price the post-CIP cash flow profile, not the current shadow.",
        ],
      };
    },
  },

  // R5e. Dividend payment timing (low) — fires when 457 has material
  // balance, signalling declared-but-unpaid distribution awaiting cash.
  {
    key: "dividends_payment_timing",
    detect: (f) => {
      const divPayable = f.bs.dividends_payable;
      if (divPayable < 100_000) return null;
      return {
        ruleKey: "dividends_payment_timing",
        severity: "info",
        title: `Resolve ${RON(divPayable)} dividend payment timing`,
        factsCited: {
          dividends_payable: divPayable,
          cash_balance: f.bs.cash,
          dscr_current: f.ratios.dscr,
        },
        rationaleFallback:
          `Account 457 (Dividends payable) holds ${RON(divPayable)} declared but unpaid. Either AGM authorization is pending, ` +
          `or distribution is being deferred to preserve liquidity. Either way, the obligation exists and the cash will eventually ` +
          `need to be available.`,
        actionsFallback: [
          "Confirm intent with the shareholders — pay this year, defer to the next AGM, or convert to a different form of distribution.",
          "If deferred, document the timing decision so it doesn't drift into the next fiscal year unintentionally.",
          "Sequencing: do not pay dividends if covenant ratios are tight or if a planned intercompany recall hasn't closed.",
          "Confirm tax compliance — declared-but-unpaid dividends can still trigger Romanian withholding tax depending on the structure.",
        ],
      };
    },
  },

  // R5. Capitalized own-work disclosure (info)
  // Earnings-quality observation when 722 is material vs rental revenue.
  {
    key: "capitalized_own_work_disclosure",
    detect: (f) => {
      const cow = f.pl.capitalized_own_work_memo;
      const pctRev = cow / Math.max(f.pl.rental_revenue, 1);
      if (cow <= 100_000 || pctRev <= 0.5) return null;
      return {
        ruleKey: "capitalized_own_work_disclosure",
        severity: "info",
        title: `Capitalized own-work ${RON(cow)} (account 722) = ${(pctRev * 100).toFixed(0)}% of rental revenue — disclose dual view`,
        factsCited: {
          capitalized_own_work: cow,
          pct_of_rental_revenue: pctRev,
          ebitda_statutory: f.pl.ebitda,
          ebitda_operational: f.pl.ebitda_excl_capitalized,
        },
        rationaleFallback:
          `The company capitalizes labor and overhead into CIP (account 231) via 722. The offsetting cost ` +
          `sits in 628 (Other third-party services) — net P&L effect is approximately zero. However, ` +
          `statutory EBITDA ${RON(f.pl.ebitda)} (with 722) versus operational view ` +
          `${RON(f.pl.ebitda_excl_capitalized)} (without) produces a material presentation gap. ` +
          `Bank covenants typically use the statutory view; investors and analysts may compute the operational view.`,
        actionsFallback: [
          "Maintain clear documentation showing the 722/628 wash so an auditor or lender can reconcile both views.",
          `When speaking to the lender, cite statutory EBITDA (${RON(f.pl.ebitda)}).`,
          "When speaking to a potential equity investor, present both views with the explanation.",
          "Once CIP delivers (account 231 → 215), the 722 entry stops and the two views converge — frame the convergence as a milestone.",
        ],
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════
  // TRUE DISTRESS RULES — only fire when the condition is GENUINELY
  // present on statutory inputs. The previous platform misapplied
  // Altman Z' (manufacturing) to CRE and read operational EBITDA, so
  // these rules fired falsely for EEI and produced damaging
  // recommendations (waive covenant, engage restructuring advisor,
  // exit SKUs/customers). They now stay silent unless the underlying
  // statutory condition is real.
  // ══════════════════════════════════════════════════════════════════

  // R6. True debt-service distress — fires when statutory DSCR < 1.0
  {
    key: "true_debt_service_distress",
    detect: (f) => {
      const dscr = f.ratios.dscr;
      if (dscr <= 0 || dscr >= 1.0) return null;
      return {
        ruleKey: "true_debt_service_distress",
        severity: "critical",
        title: `DSCR ${dscr.toFixed(2)}× below 1.0 — operating income does not cover debt service`,
        factsCited: {
          dscr,
          ebitda_statutory: f.pl.ebitda,
          interest_expense: f.pl.interest_expense,
        },
        rationaleFallback:
          `Statutory EBITDA ${RON(f.pl.ebitda)} against interest + principal exceeds the covenant floor. ` +
          `Genuine covenant pressure — engage the lender proactively before the next compliance certificate.`,
        actionsFallback: [
          "Open the conversation with the lender now — surfacing the issue before they detect it preserves goodwill.",
          "Build a 13-week cash forecast under three scenarios (base / -10% revenue / -20% revenue).",
          "Identify non-core assets that can be liquidated to de-lever inside 90 days.",
          "Prepare a covenant amendment proposal that includes a step-down schedule with measurable milestones.",
        ],
      };
    },
  },

  // R7. True Altman distress — fires only on industry-appropriate variant
  // in distress zone. (The FE financialValuation.ts now uses Z" for CRE
  // and exposes the score; this rule reads that result via the ratios
  // facade rather than re-computing Altman locally.)
  {
    key: "true_distress_altman",
    detect: (f) => {
      // The score isn't currently surfaced on PeriodFacts.ratios; the
      // FE computes Altman in financialValuation.ts on the Risks tab.
      // Until period_facts.credit_facts lands, infer distress from the
      // composite of: NI < 0 AND total_equity < 0 (the actual bankruptcy
      // signature). The "true_distress_altman" rule then fires only on
      // genuine sign-correct distress, not on misapplied variants.
      const niLoss = f.pl.net_profit < 0;
      const negativeEquity = f.bs.total_equity < 0;
      if (!niLoss || !negativeEquity) return null;
      return {
        ruleKey: "true_distress_altman",
        severity: "critical",
        title: `Negative equity ${RON(f.bs.total_equity)} with operating loss — Romanian Company Law action required`,
        factsCited: {
          net_profit: f.pl.net_profit,
          total_equity: f.bs.total_equity,
          cash: f.bs.cash,
        },
        rationaleFallback:
          `Negative book equity combined with an operating loss triggers Art. 153^24 of Romanian Company Law: ` +
          `the administrator must convene the general meeting to decide on recapitalization or dissolution.`,
        actionsFallback: [
          "Engage a restructuring advisor — this is genuine distress.",
          "Build a 13-week cash forecast and a 12-month recapitalization plan.",
          "Open a confidential conversation with the bank ahead of the next compliance test.",
          "Identify which assets can be sold inside 90 days to fund the equity cure.",
        ],
      };
    },
  },

  // R8. True negative-EBITDA — fires only when STATUTORY EBITDA < 0
  {
    key: "true_negative_ebitda",
    detect: (f) => {
      if (f.pl.ebitda >= 0) return null;
      return {
        ruleKey: "true_negative_ebitda",
        severity: "critical",
        title: `Statutory EBITDA ${RON(f.pl.ebitda)} negative — operating model is not generating cash`,
        factsCited: {
          ebitda_statutory: f.pl.ebitda,
          rental_revenue: f.pl.rental_revenue,
        },
        rationaleFallback:
          `Statutory EBITDA is negative. Earnings-based valuation methods (EV/EBITDA, EV/Revenue) ` +
          `produce meaningless values; the company is consuming cash from operations.`,
        actionsFallback: [
          "Build a path-to-positive-EBITDA plan with month-by-month milestones over the next 12 months.",
          "Identify discretionary cost lines that can be cut without impairing the revenue base.",
          "Prepare a bridge-financing conversation with the lender now, ahead of the cash runway tightening.",
        ],
      };
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────────────

export function detectConditions(facts: PeriodFacts): DetectedCondition[] {
  const industry = (facts.industry ?? "").toLowerCase();
  const candidates: DetectedCondition[] = [];
  for (const rule of RULES) {
    // Industry filter — when a rule scopes itself, skip non-matching industries.
    if (rule.industries && industry && !rule.industries.includes(industry)) continue;
    try {
      const c = rule.detect(facts);
      if (c) candidates.push(c);
    } catch (err) {
      console.error(`[recommendationRules] Rule ${rule.key} crashed:`, err);
    }
  }
  // Structural dedup by ruleKey (defensive — the rule registry doesn't
  // have duplicates by construction, but a future authoring mistake
  // would surface here instead of as a UI repetition).
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.ruleKey)) return false;
    seen.add(c.ruleKey);
    return true;
  });
}

/** Severity rank for sorting — critical first. */
export function severityRank(s: Severity): number {
  return { critical: 0, attention: 1, info: 2 }[s];
}
