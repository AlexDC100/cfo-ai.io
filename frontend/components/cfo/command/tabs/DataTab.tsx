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

// Activity / Database / FileBarChart2 / History / RefreshCw /
// ShoppingBag / UploadCloud were the row icons for the removed
// Upload + Processing sections. Drop them here to keep the bundle
// honest; re-add when the rows come back.
import { Plug } from "lucide-react";

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
      {/* The Decision-rules trigger card that led this tab moved to the
          Command Center's Quick actions grid (2026-07-24). */}
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
