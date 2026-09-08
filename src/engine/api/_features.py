"""Backend feature registry — single source of truth for "is this
product capability shipped, half-done, or roadmap?"

PURPOSE
=======
The frontend (Command Center, sidebar, Settings page) was drifting into
a state where rows would render with onClick handlers that produced
toasts saying "ships with the auth layer" or "available in a future
upgrade". From the user's perspective those rows look interactive but
do nothing.

This module fixes the drift at the source: every product capability has
exactly one row here with a status. The frontend reads the registry via
`GET /api/features/status` and renders accordingly:

  · `active`      — backend endpoint exists and works. Row is clickable.
  · `coming_soon` — surfaced in UI with a "Coming soon" badge, no
                    onClick. The user knows it's on the roadmap.
  · `hidden`      — registry entry exists for backend introspection but
                    the row never renders.

Adding a feature: add ONE entry below. Promote `coming_soon → active`
the moment the underlying endpoint lands. Never delete an entry —
removing capability from the product is itself a release-note event.

RELATIONSHIP TO `scandi-desk-main/src/config/features.ts`
========================================================
The TS flags (PUBLIC_RECORDS_ENABLED, DECISIONS_ALERTS_ENABLED) are
*build-time* toggles for two specific flows that aren't ready and need
to be hidden everywhere. They remain the source of truth for those two
features. The mirror entries below (`public_records`, `decisions`,
`alerts`) read `hidden` because we want them off until the build flag
flips. This duplication is intentional: the registry is the runtime
contract; the build flags are the lockout.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Literal

from fastapi import APIRouter


logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Types — kept inline so this file is grep-able as a single contract
# ──────────────────────────────────────────────────────────────────────

FeatureStatus = Literal["active", "coming_soon", "hidden"]


def _feature(
    status: FeatureStatus,
    *,
    label: str,
    description: str,
    endpoint: str | None = None,
    required_plan: str | None = None,
    required_data_depth: list[str] | None = None,
) -> Dict[str, Any]:
    """Compact constructor — keeps the registry readable.

    `endpoint` is the SINGLE canonical backend route for this feature
    (when applicable). It's surfaced so the frontend / smoke tests can
    cross-check "is this route actually registered?" without us
    maintaining a parallel mapping by hand.
    """
    row: Dict[str, Any] = {
        "status": status,
        "label": label,
        "description": description,
    }
    if endpoint:
        row["endpoint"] = endpoint
    if required_plan:
        row["required_plan"] = required_plan
    if required_data_depth:
        row["required_data_depth"] = required_data_depth
    return row


# ──────────────────────────────────────────────────────────────────────
# THE REGISTRY
# ──────────────────────────────────────────────────────────────────────
#
# Keys are stable strings — the frontend imports a typed union derived
# from this dict. Renames here are breaking changes to the FE; treat
# them as migrations.
#
# Status assignment criteria (be strict):
#   · `active` REQUIRES a working backend endpoint AND a frontend
#     surface that calls it.
#   · `coming_soon` means the feature is real on our roadmap and the
#     UI shows a placeholder row so users can see it's planned.
#   · `hidden` means: do not show, do not even render the row.

FEATURES: Dict[str, Dict[str, Any]] = {
    # ── Data ingest ────────────────────────────────────────────────
    "upload_trial_balance": _feature(
        "active",
        label="Upload trial balance",
        description="Drop a balanță de verificare; the pipeline parses it and produces P&L + BS + ratios.",
        endpoint="/api/pipeline/run",
    ),
    "upload_financial_statement": _feature(
        "active",
        label="Upload financial statement",
        description="Drop a PDF/Excel financial statement; extracted statements feed the dashboard.",
        endpoint="/api/financial-statements/parse",
    ),
    "upload_invoice": _feature(
        "coming_soon",
        label="Upload invoice file",
        description="Bulk invoice ingest for AR/AP analytics.",
    ),
    "upload_inventory": _feature(
        "coming_soon",
        label="Upload inventory file",
        description="SKU + stock-level import for inventory analytics.",
    ),

    # ── Processing / data hygiene ──────────────────────────────────
    "import_history": _feature(
        "coming_soon",
        label="Import history",
        description="Run log of every upload + reprocess event.",
    ),
    "data_quality": _feature(
        "coming_soon",
        label="Data quality checks",
        description="Reconciliation gaps, missing accounts, classification warnings.",
    ),
    "reprocess_latest": _feature(
        "coming_soon",
        label="Reprocess latest upload",
        description="Re-runs the pipeline on the most recent document without re-uploading.",
    ),

    # ── Integrations (placeholders for roadmap visibility) ─────────
    "erp_connector": _feature(
        "coming_soon",
        label="ERP connector",
        description="SAP, Microsoft Dynamics, NetSuite, Odoo. Connector framework.",
    ),
    "accounting_connector": _feature(
        "coming_soon",
        label="Accounting connector",
        description="SAGA, ContabilTM, Xero, QuickBooks. Periodic sync.",
    ),
    "public_registry_connector": _feature(
        "coming_soon",
        label="Public registry connector",
        description="ANAF / listafirme.ro / EU registries for peer financials.",
    ),

    # ── AI ─────────────────────────────────────────────────────────
    "ask_cfo_ai": _feature(
        "active",
        label="Ask CFO AI",
        description="Universal Q&A grounded in the active period's statements + metrics.",
        endpoint="/api/ask",
    ),
    "ask_about_current_company": _feature(
        "active",
        label="Ask about current company",
        description="Opens the AI panel pre-loaded with the active period's context.",
        endpoint="/api/ask",
    ),
    "generate_action_list": _feature(
        "active",
        label="Generate action list (CSV)",
        description="Exports the prioritized decision queue to CSV.",
        endpoint="/api/cfo/exports/action-list",
    ),
    "generate_board_summary": _feature(
        "active",
        label="Generate board summary",
        description="One-page executive memo synthesised from current statements.",
        endpoint="/api/cfo/exports/board-summary",
    ),
    "generate_bank_memo": _feature(
        "coming_soon",
        label="Generate bank memo",
        description="Lender-style credit memo with covenants, leverage, DSCR.",
    ),
    "generate_90_day_plan": _feature(
        "coming_soon",
        label="Generate 90-day plan",
        description="Sequenced action plan with owners and impact estimates.",
    ),
    "generate_public_report": _feature(
        "coming_soon",
        label="Generate public report",
        description="Sanitised, sharable report safe for external distribution.",
    ),
    "simulate_cost_of_capital": _feature(
        "coming_soon",
        label="Simulate cost of capital",
        description="WACC sensitivity scenarios applied to valuation + ROIC.",
    ),
    "simulate_debt_reduction": _feature(
        "coming_soon",
        label="Simulate debt reduction",
        description="Pay-down schedule scenarios with interest-coverage trajectory.",
    ),
    "simulate_margin_improvement": _feature(
        "coming_soon",
        label="Simulate margin improvement",
        description="Cost-structure improvement scenarios with EBITDA waterfall.",
    ),

    # ── Account / auth ─────────────────────────────────────────────
    "change_password": _feature(
        "active",
        label="Change password",
        description="Standard Supabase reset-password flow.",
    ),
    "two_factor_auth": _feature(
        "coming_soon",
        label="Two-factor authentication",
        description="TOTP / SMS second factor for sign-in.",
    ),
    "manage_profile": _feature(
        "active",
        label="Manage profile",
        description="Profile name, display name, language preference.",
    ),
    "annual_billing": _feature(
        "coming_soon",
        label="Annual billing",
        description="Yearly billing cycle at a discount. The /pricing toggle's Annual segment is disabled and labelled from THIS row — LR3 asserts the copy against this status, so promoting it here without wiring the cycle reds the gate.",
    ),
    "manage_billing": _feature(
        "active",
        label="Manage billing",
        description="Stripe-backed subscription, invoices, payment method.",
        endpoint="/api/billing/portal",
    ),
    "workspace_switcher": _feature(
        "coming_soon",
        label="Switch workspace",
        description="Multi-tenant org switching.",
    ),
    "user_invites": _feature(
        "coming_soon",
        label="Invite teammates",
        description="Org-scoped invites + role-based permissions.",
    ),

    # ── Workflow surfaces ──────────────────────────────────────────
    "dashboard": _feature(
        "active",
        label="Dashboard",
        description="Headline KPIs + statement tabs.",
        endpoint="/api/period/{period_id}",
    ),
    "benchmarks": _feature(
        "active",
        label="Benchmarks",
        description="Industry percentile comparison + peer panel.",
        endpoint="/api/benchmarks/report/{period_id}",
    ),
    "industry_classification": _feature(
        "active",
        label="Industry classification",
        description="Per-period industry assignment + audit trail.",
        endpoint="/api/industry/profiles",
    ),
    "reports": _feature(
        "active",
        label="Reports",
        description="Comprehensive analysis report (8 sections + industry tab).",
    ),

    # ── Hidden today, build-flag-locked. Mirror of src/config/features.ts ──
    # If you flip the build flag in the FE, ALSO flip this status. The
    # mirror is here so /api/features/status remains the single read for
    # the frontend (no second source of truth across language boundaries).
    "decisions": _feature(
        "hidden",
        label="Decisions",
        description="Decision queue. Hidden behind DECISIONS_ALERTS_ENABLED.",
    ),
    "alerts": _feature(
        "hidden",
        label="Alerts",
        description="Active alerts feed. Hidden behind DECISIONS_ALERTS_ENABLED.",
    ),
    "public_records": _feature(
        "hidden",
        label="Public records",
        description="Multi-year-history from listafirme.ro. Hidden behind PUBLIC_RECORDS_ENABLED.",
    ),

    # ── Folded into Inventory per app-shell-cleanup decision ───────
    # Products / SKU Explorer remains REACHABLE via the legacy route but
    # is no longer a primary nav item; it appears under Inventory.
    "inventory": _feature(
        # HIDDEN, not coming_soon, and the distinction is the owner's:
        # its value duplicates Products (SKU-level stock detail) and the
        # trial balance already carries the class-3 stock accounts, so
        # there is nothing here a user is waiting for. Anything genuinely
        # unique folds into Products post-launch. `hidden` keeps it off
        # the menu; the route still renders PendingState so a deep link
        # or an old bookmark explains itself instead of breaking.
        "hidden",
        label="Inventory",
        description="Superseded by Products (SKU-level stock detail) and the trial balance's own class-3 accounts. Anything unique folds into Products post-launch.",
    ),
    "invoices": _feature(
        # HIDDEN for launch, KEPT for post-launch. Unlike Inventory this
        # is not a duplicate: it is the one surface a trial balance
        # cannot produce. A balance gives the closing total on 4111 and
        # 401; it cannot give ageing buckets, counterparty
        # concentration, or which invoices are overdue and by how long —
        # those live in the analytic sub-accounts. e-Factura ingestion
        # through ANAF SPV is the roadmap item that fills it without the
        # user assembling anything by hand.
        "hidden",
        label="Receivables & Payables",
        description="Ageing buckets, counterparty concentration and overdue detail from the analytic 4111/401 accounts — what a trial balance total cannot give. e-Factura via ANAF SPV fills it automatically.",
    ),
    "products_legacy": _feature(
        "active",
        label="Products (legacy)",
        description="Existing SKU page — reachable via /products redirect, folded under Inventory in nav.",
        endpoint="/api/cfo/products",
    ),

    # ── LAUNCH CUT (2026-09-05) — built, verified NOT end-to-end, off ──
    # These rows are `hidden`, not `coming_soon`: the feature EXISTS and
    # the code ships; it is simply outside the eight surfaces the launch
    # supports, so both its nav item and its ROUTE are switched off (the
    # route renders <PendingState>, never the half-verified page).
    # Promote a row to `active` only after its screen has been walked
    # end-to-end at 1440 and 390 in both languages with zero console
    # errors. Flipping the status here is the whole re-enable.
    "scenarios": _feature(
        "active",
        label="Scenario planning",
        description="Price / volume / cost levers with profit, cash and covenant headroom.",
    ),
    # RENAMED 2026-09-08. It was "Budget vs actual vs last year", which named
    # the budget first and made the whole surface read as unavailable until
    # someone uploaded one. It is not: the comparison it always renders is
    # PERIOD vs PRIOR PERIOD vs LAST YEAR, built from the periods already
    # attached to the workspace. The budget is a FOURTH column that unlocks
    # on upload, and the page carries a persistent affordance for it.
    #
    # HIDDEN for the launch cut, per the owner. The route still renders
    # PendingState (the three-state nav law), so a deep link explains itself.
    "variance": _feature(
        "hidden",
        label="Comparison",
        description="Period against prior period and last year, line by line. A budget column unlocks on upload.",
    ),
    "public_companies": _feature(
        "active",
        label="Public companies",
        description="Listed-company filings, ratios and peer comparison. The in-app surface; the server-rendered /companii storefront serves independently of this flag.",
        endpoint="/api/public/markets",
    ),
    "comprehensive_report": _feature(
        "active",
        label="Comprehensive report",
        description="The full eight-section written analysis of a period as one document.",
    ),
    "peer_report": _feature(
        "active",
        label="Peer comparison report",
        description="P&L side by side with a named peer and the sector median.",
    ),
    "chat_page": _feature(
        "active",
        label="Ask CFO AI (full chat page)",
        description="The standalone /chat conversation surface. Distinct from `ask_cfo_ai`, which gates the in-context Capsule ask.",
    ),
    "roadmap": _feature(
        "active",
        label="Roadmap page",
        description="Public release roadmap at /roadmap.",
    ),
    "firm_cockpit": _feature(
        "hidden",
        label="Firm Cockpit",
        description="Multi-client accounting-firm surface. Backend is mounted ONLY when FIRM_COCKPIT_ENABLED is truthy (unset in production), so every /api/firm route is a 404 there by construction; this row is the frontend mirror.",
    ),
    "anomaly_radar": _feature(
        "hidden",
        label="Anomaly Radar",
        description="Cross-period anomaly detection over the ledger.",
    ),
}


# ──────────────────────────────────────────────────────────────────────
# FastAPI surface
# ──────────────────────────────────────────────────────────────────────

def build_router() -> APIRouter:
    """Build the /api/features router.

    Auth: NONE. Feature visibility is not sensitive. Adding auth here
    would require the frontend to wait on a session before deciding
    what to render, which hurts first-paint and serves no security
    purpose — the registry contains no secrets, only product copy and
    status enums.
    """
    router = APIRouter(tags=["features"])

    @router.get("/api/features/status")
    def features_status() -> Dict[str, Any]:
        """Return the entire feature registry in one payload.

        Frontend shape:
            { "features": { "<key>": { status, label, description, ... } } }

        The single-payload approach is intentional: the registry is
        small (~30 entries), changes rarely, and serving it once on
        app boot is cheaper than the per-row queries the alternative
        designs would imply.
        """
        return {"features": FEATURES}

    return router
