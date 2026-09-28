// INVENTORY DAYS — THE SPLIT ON SCREEN (owner spec 2026-09-26 P1, design B4)
//
// "Show all four, each with its accounts." The Ratios tile prints the
// served total (the ratio table's `dio` row, which reads the ONE block);
// this component prints what the total is made of, under it: materials,
// finished goods + WIP, merchandise — each with its accounts and its days —
// and "alte stocuri", inside the total with no days of its own; then the
// basis the block states ("media soldurilor la 1 ianuarie și 31 decembrie"
// or "stoc la 31 decembrie — o singură zi") and the seasonality flag.
//
// Every string comes from `printInventoryDays` (lib/inventoryDays.ts), the
// same printed form the CFO report and the bank export use. Nothing here
// divides: a refused leg prints the engine's reason.

import { useTranslation } from "react-i18next";

import {
  printInventoryDays,
  readInventoryDaysSplit,
  type InventoryDaysPrintedRow,
} from "@/lib/inventoryDays";

interface Props {
  statements: { inventory_days?: unknown } | null | undefined;
  /** `compact` sits inside a Ratios tile; `full` is the drawer's section. */
  variant: "compact" | "full";
}

export function InventoryDaysSplit({ statements, variant }: Props) {
  const { t, i18n } = useTranslation();
  const split = readInventoryDaysSplit(statements);
  if (!split) return null;
  const p = printInventoryDays(split, i18n.language);
  const rows: InventoryDaysPrintedRow[] = [...p.legs, ...(p.other ? [p.other] : [])];

  if (variant === "compact") {
    return (
      <div
        className="mt-2 border-t border-rule/70 pt-2 text-[11px] leading-snug"
        data-testid="inventory-days-split"
        data-variant="compact"
        data-basis={split.basis ?? ""}
      >
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li key={r.key} className="flex items-baseline justify-between gap-2" data-inventory-leg={r.key}>
              <span className="min-w-0 text-ink-soft">
                {r.label}
                <span className="ml-1 text-ink-mute text-[10px]" data-col="accounts">{r.accounts}</span>
              </span>
              <span
                className={r.refused || r.key === "other_stock" ? "shrink-0 text-[10px] text-ink-mute text-right max-w-[55%]" : "shrink-0 font-mono tabular-nums text-ink"}
                data-col="days"
                data-refused={r.refused ? "1" : undefined}
              >
                {r.days}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-1 text-[10.5px] text-ink-mute" data-testid="inventory-days-basis">{p.basis}</div>
        {split.seasonalNote ? (
          <span
            className="mt-1 inline-flex items-center rounded-full border border-amber-500/40 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-ink"
            data-testid="inventory-days-seasonal"
            title={split.seasonalNote[p.lang]}
          >
            {t("inventoryDays.seasonalFlag")}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="inventory-days-split" data-variant="full" data-basis={split.basis ?? ""}>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.08em] text-ink-mute">
            <th className="text-left font-semibold pb-1">{p.headings.type}</th>
            <th className="text-right font-semibold pb-1">{p.headings.days}</th>
          </tr>
        </thead>
        <tbody>
          {[...rows, p.total].map((r) => (
            <tr key={r.key} className={`border-t border-rule/60 align-top ${r.key === "total" ? "font-semibold text-ink" : ""}`} data-inventory-leg={r.key}>
              <td className="py-1.5 pr-3">
                <div className="text-ink">{r.label}</div>
                {r.accounts ? <div className="text-[10.5px] text-ink-mute" data-col="accounts">{r.accounts}</div> : null}
                {r.flow ? <div className="text-[10.5px] text-ink-mute" data-col="flow">{r.flow}</div> : null}
              </td>
              <td
                className={`py-1.5 text-right ${r.refused || r.key === "other_stock" ? "text-[11px] text-ink-mute" : "font-mono tabular-nums text-ink"}`}
                data-col="days"
                data-refused={r.refused ? "1" : undefined}
              >
                {r.days}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 space-y-1 text-[11.5px] text-ink-soft">
        <p data-testid="inventory-days-basis">{p.basis}</p>
        {p.closing ? <p data-testid="inventory-days-closing">{p.closing}</p> : null}
        {p.notes.map((n) => (
          <p key={n} className="text-ink-mute" data-testid="inventory-days-note">{n}</p>
        ))}
      </div>
    </div>
  );
}
