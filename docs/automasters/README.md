# AutoMasters on CFO AI

AutoMasters is the desktop app of the Ferrari dealership in Bucharest (Bitton FR
Holdings). It runs the dealership: sales, vehicle stock, service, workshop and
parts. Its **Finance** and **Management** screens are CFO AI's part. They live
in CFO AI as a *custom solution* at `/solutions/automasters`:

| Group | Screen | Route |
| --- | --- | --- |
| Management | Dealer performance | `/solutions/automasters/performance` |
| Management | Profit centres | `/solutions/automasters/profit-centres` |
| Management | Ask CFO AI | `/solutions/automasters/ask` |
| Finance | Payments reconciliation | `/solutions/automasters/payments` |
| Finance | SAGA & e-Factura | `/solutions/automasters/exports` |
| Finance | Month close | `/solutions/automasters/close` |

## Access

A custom solution is shown only to accounts an operator has linked to it. Link
them on the **Admin** page (`/admin`, in the sidebar for operators). An
operator is a user id in `PLATFORM_ADMIN_USER_IDS`; `PRICING_ADMIN_USER_IDS`
also counts. Both are set on the engine host. Linking is by e-mail, and the
person must already have a CFO AI account.

The data belongs to a CFO AI **workspace** (company). A linked account sees
the AutoMasters data of the workspace it has open, and only if it is a member
of that workspace. RLS requires both, through `am_can(org_id)`.

## Where the data comes from

The screens read the `am_*` tables in Supabase
(`supabase/schema_phase_custom_solutions.sql`). There are two ways to fill
them:

1. **The AutoMasters app writes them directly**, signed in to Supabase as a
   linked account that is a member of the dealership's workspace. Use upserts
   on the natural keys below, so resending is harmless.
2. **Import data** (button on every AutoMasters screen) takes a JSON export in
   the format below. `sample-import.json` is a complete example built from the
   prototype's figures.

| Table | Natural key (upsert `onConflict`) | Written by |
| --- | --- | --- |
| `am_bank_lines` | `org_id, external_ref` | AutoMasters app / import |
| `am_documents` | `org_id, doc_number` | AutoMasters app / import |
| `am_export_items` | `org_id, channel, ref` | AutoMasters app / import |
| `am_centre_figures` | `org_id, period, centre` | AutoMasters app / import |
| `am_funnel` | `org_id, period, stage` | AutoMasters app / import |
| `am_payment_matches` | one per bank line and per document | CFO AI (Payments) |
| `am_close_periods`, `am_close_checks` | `org_id, period[, check_key]` | CFO AI (Month close) |

**Export retries.** CFO AI never changes an export item's `status`; that belongs
to the AutoMasters app. "Reprocess" / "Correct and resend" calls
`am_request_export_retry(id)`. It sets `retry_requested_at` and appends a
`retry_requested` event. The AutoMasters app should pick up items where
`retry_requested_at` is set, resend them, and write back the new `status` and
`events`.

**Month close.** `am_close_period(org_id, period)` closes a month only when
every checklist item is done and no profit centre's `dms_amount` vs
`ledger_amount` differs by more than 0.5%. Otherwise it answers with the
reason. A closed month's checklist cannot change.

## Import format `automasters.cfo.v1`

```json
{
  "format": "automasters.cfo.v1",
  "currency": "EUR",
  "bank_lines": [
    { "ref": "b1", "booked_on": "2026-09-24", "payer": "Andrei Popescu",
      "reference": "rest plata SF90", "amount": 406019.2,
      "suggested_document": "FF-2026-0433" }
  ],
  "documents": [
    { "number": "FF-2026-0433", "customer": "Andrei Popescu",
      "kind": "final", "amount": 406019.2, "issued_on": "2026-09-20" }
  ],
  "exports": [
    { "channel": "saga", "ref": "EXP-2026-09-24-03", "description": "Storno",
      "counterparty": "warranty", "doc_count": 1, "amount": -12450,
      "status": "error", "error": "Account 4111 is not mapped …",
      "events": [{ "at": "2026-09-24T14:20:00Z", "text": "Batch generated" }] }
  ],
  "centres": [
    { "period": "2026-09", "centre": "Warranty", "revenue": 46200,
      "margin": 6000, "budget_margin": 6200,
      "dms_amount": 46200, "ledger_amount": 42780,
      "note": "Claims without a ledger entry (DD7).",
      "contributors": [{ "name": "Ferrari warranty", "value": 41200 }] }
  ],
  "funnel": [
    { "period": "2026-09", "stage": "Lead", "position": 0, "count": 72 }
  ]
}
```

- **Amounts.** EUR without VAT, unless `currency` says otherwise (it can also
  be set per row).
- **Dates.** `YYYY-MM-DD`. Periods are `YYYY-MM`.
- **`kind`.** One of `final`, `advance`, `service`, `deposit`, `other`.
- **`channel`.** `saga` or `efactura`.
- **`status`.** One of `pending`, `sent`, `accepted`, `error`, `rejected`,
  `reconciled`.
- **Centre names.** Any names work. Performance groups them by name into new
  cars / service / parts / other.

One invalid row refuses the whole file, and the dialog lists every reason.
Nothing is deleted on import.
