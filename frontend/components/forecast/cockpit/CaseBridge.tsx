// THE BRIDGE FROM BASE (gate F9) — how this case's cash differs from Bază's,
// step by step: revenue → costs → EBITDA → working capital → capex → interest
// and tax → dividends → debt → closing cash.
//
// Every step is a served amount; the ENGINE refuses to serve a bridge whose
// steps do not sum exactly to the difference in closing cash (BridgeError), and
// says `sums_exactly` on the one it serves. The page adds nothing up: a bridge
// whose total a browser computed would be a second model answering the one
// question a bridge exists to answer. Two windows, both served: plan year one
// and the whole horizon.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { pick, type CockpitBridge } from "@/lib/forecastCockpit";
import { CockpitAmountView } from "./CockpitAmountView";
import { yearLabel, type MoneyFormat } from "./format";

export function CaseBridge({
  yearOne,
  horizon,
  fromLabel,
  lang,
  format,
  projectedLabel,
}: {
  yearOne: CockpitBridge | null;
  horizon: CockpitBridge | null;
  fromLabel: string;
  lang: string;
  format: MoneyFormat;
  projectedLabel: string;
}) {
  const { t } = useTranslation();
  const [window, setWindow] = useState<"horizon" | "year_one">("horizon");
  const bridge = (window === "horizon" ? horizon : yearOne) ?? horizon ?? yearOne;
  if (!bridge) return null;
  const tab = (id: "horizon" | "year_one", label: string, b: CockpitBridge | null) =>
    b ? (
      <button
        type="button"
        data-testid={`cockpit-bridge-window-${id}`}
        aria-pressed={window === id}
        onClick={() => setWindow(id)}
        className={`rounded px-2 py-0.5 text-[11.5px] ${
          window === id ? "bg-bg-2 font-medium text-ink" : "text-ink-mute hover:text-ink"
        }`}
      >
        {label}
      </button>
    ) : null;
  return (
    <section
      data-testid="cockpit-bridge"
      data-window={bridge.window}
      data-sums-exactly={bridge.sumsExactly ? "true" : "false"}
      className="rounded-xl border border-rule bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
          {t("forecast.cockpit.bridge.title", "Bridge from {{from}}", { from: fromLabel })}
        </h2>
        <div className="flex items-center gap-1">
          {tab("year_one", t("forecast.cockpit.bridge.yearOne", "Year one"), yearOne)}
          {tab("horizon", t("forecast.cockpit.bridge.horizon", "To {{year}}", { year: yearLabel(horizon?.period ?? "") }), horizon)}
        </div>
      </div>
      <ol className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {bridge.steps.map((s) => (
          <li
            key={s.id}
            data-testid={`cockpit-bridge-${s.id}`}
            data-subtotal={s.subtotal ? "true" : "false"}
            data-total={s.total ? "true" : "false"}
            className={`min-w-0 ${s.total ? "border-t border-rule pt-1" : ""}`}
          >
            <div className={`truncate text-[11.5px] ${s.subtotal || s.total ? "font-medium text-ink-soft" : "text-ink-mute"}`}>
              {pick(s.label, lang)}
            </div>
            <div className={`truncate text-[14px] tabular-nums text-ink ${s.subtotal || s.total ? "font-semibold" : "font-medium"}`}>
              <CockpitAmountView amount={s.amount} format={format} projectedLabel={projectedLabel} lang={lang} />
            </div>
          </li>
        ))}
      </ol>
      {!bridge.sumsExactly ? (
        <p data-testid="cockpit-bridge-open" className="mt-2 text-[12px] text-alert">
          {t(
            "forecast.cockpit.bridge.open",
            "The engine reports that these steps do not close on the cash difference; the bridge is shown as served.",
          )}
        </p>
      ) : null}
    </section>
  );
}
