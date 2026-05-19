// DataTab.tsx — Data tab of the Command Center.
//
// CONTENT (per the cleanup spec, §8)
//   Upload
//     · Upload trial balance        — active
//     · Upload financial statement  — active
//     · Upload invoice file         — coming_soon
//     · Upload inventory file       — coming_soon
//   Processing
//     · Import history              — coming_soon
//     · Data quality checks         — coming_soon
//     · Reprocess latest upload     — coming_soon
//   Integrations
//     · ERP connector               — coming_soon
//     · Accounting connector        — coming_soon
//     · Public registry connector   — coming_soon
//
// HOW STATUS IS RESOLVED
//   Each row passes a `featureKey`; the Row component reads the live
//   registry status via `useFeatureStatus`. When the backend flips a
//   feature from `coming_soon → active`, this tab updates without a
//   redeploy.
//
// WHAT MOVED OUT OF HERE
//   The legacy DataTab had a "Sync history" row that toasted "no
//   imports yet" — that's a fake interactive surface. Replaced with
//   the registry-driven `import_history` row (coming_soon badge,
//   not clickable).

import { useState } from "react";
// Activity / Database / FileBarChart2 / History / RefreshCw /
// ShoppingBag / UploadCloud were the row icons for the removed
// Upload + Processing sections. Drop them here to keep the bundle
// honest; re-add when the rows come back.
import {
  ChevronDown,
  Plug,
  Settings2,
} from "lucide-react";

import { DataRulesCard } from "@/components/cfo/settings/DataRulesCard";

import { Row } from "../Row";
import { Section } from "../Section";

interface Props {
  /** Close the Command Center after launching an action. */
  onClose: () => void;
  /** Open the upload flow. */
  onOpenUpload: () => void;
}

export function DataTab({ onClose: _onClose, onOpenUpload: _onOpenUpload }: Props) {
  // Upload + Processing sections were removed per the operator's
  // directive. Upload remains discoverable in two places that are
  // already part of the natural workflow:
  //   · Dashboard empty-state zone (the primary first-upload surface)
  //   · Dashboard "Replace dataset" dropdown (re-upload on an existing
  //     period)
  // Surfacing the four upload rows + the three coming_soon processing
  // rows here was a duplicate that pushed the only actionable Data-tab
  // content (Integrations + Decision rules) down the page. `_onClose`
  // and `_onOpenUpload` are still received from CommandCenter for
  // API stability; the underscore prefix marks them as intentionally
  // unused so a future re-introduction of Upload here doesn't require
  // a prop-shape change.

  return (
    <>
      {/* Decision rules promoted above Integrations per the operator's
          directive — it's the only actionable Data-tab content today
          (Integrations are all coming_soon), so it earns the top slot
          where the eye lands first. Collapsed by default so the tab
          stays scannable; one click expands the full threshold panel. */}
      <RulesDisclosure />

      <Section label="Integrations">
        <Row
          icon={Plug}
          title="ERP connector"
          hint="SAP · Dynamics · NetSuite · Odoo"
          featureKey="erp_connector"
          testId="cmd-data-erp"
        />
        <Row
          icon={Plug}
          title="Accounting connector"
          hint="SAGA · ContabilTM · Xero · QuickBooks"
          featureKey="accounting_connector"
          testId="cmd-data-accounting"
        />
        <Row
          icon={Plug}
          title="Public registry connector"
          hint="ANAF · listafirme.ro · EU registries"
          featureKey="public_registry_connector"
          testId="cmd-data-public-registry"
        />
      </Section>
    </>
  );
}

function RulesDisclosure() {
  const [open, setOpen] = useState(false);
  return (
    <section className="mb-5" data-testid="cmd-data-rules-disclosure">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="
          w-full flex items-center gap-3 rounded-xl border border-rule
          bg-bg-2 px-4 py-3 hover:bg-bg-2/70 transition-colors
        "
      >
        <span className="w-7 h-7 rounded-md grid place-items-center bg-surface border border-rule text-ink-soft shrink-0">
          <Settings2 size={14} strokeWidth={1.75} />
        </span>
        <div className="flex-1 text-left min-w-0">
          <div className="text-[13.5px] text-ink leading-tight">
            Decision rules
          </div>
          <div className="text-[11.5px] text-ink-soft mt-0.5 leading-tight">
            Bucket thresholds (Protect / Watch / Liquidate). Local to this browser.
          </div>
        </div>
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          className={`text-ink-mute shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="mt-3">
          <DataRulesCard />
        </div>
      )}
    </section>
  );
}
