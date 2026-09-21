// How the cockpit PAINTS one served money value. A formatter, never a model:
// it receives ONE value — already converted from minor units at the gateway
// edge by `projectedDisplay`, inside <ProjectedAmount> — and returns a string.
// It never sees two values, so it cannot combine them.
//
// THE PROJECTION IS FORMATTED IN THE BOOK'S OWN CURRENCY. The display-currency
// toggle converts served ACTUALS at a stated rate on a stated date; pricing a
// five-year projection through it would be an exchange-rate assumption nobody
// declared, riding beside sliders whose whole point is that every assumption
// is written down.
//
// A value under one unit keeps its cents (gate F5: a served 0.01 printed
// "RON 0" is a zero painted where a real value exists).

export type MoneyFormat = (value: number) => string;

/** Whole units (cents under one unit). For the collapsed statements, the
 *  present-mode assumptions and the bank export. */
export function fullMoney(currency: string, locale: string): MoneyFormat {
  const whole = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency || "RON",
    maximumFractionDigits: 0,
  });
  const cents = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency || "RON",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (value) => (Math.abs(value) >= 1 ? whole : cents).format(value);
}

/** Compact ("54,4 mil. RON" / "RON 54.4M") for the four numbers and the chart,
 *  where a reader takes in magnitudes. The full figure is the statements'. */
export function compactMoney(currency: string, locale: string): MoneyFormat {
  const compact = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency || "RON",
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const cents = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency || "RON",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (value) => (Math.abs(value) >= 1 ? compact : cents).format(value);
}

/** A served plan-year label for a reader: "FY2030" reads "2030". */
export function yearLabel(period: string): string {
  return period.replace(/^FY/, "");
}

/** A served month label ("2027-04") in the reader's language ("aprilie 2027");
 *  anything else (an annual label) as a year. */
export function monthLabel(period: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return yearLabel(period);
  // Noon UTC on the first of the month, formatted in UTC: a month label can
  // never slip into the neighbouring month in a UTC-negative timezone.
  const date = new Date(`${m[1]}-${m[2]}-01T12:00:00Z`);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

/** A slider's own position (ticks at the lever's served scale) in the lever's
 *  unit, while the reader drags it — the ENGINE's display replaces it once it
 *  answers. A lever value, never money: "5.2%" / "45 days". */
export function leverText(
  lever: { readonly unit: "pct" | "days"; readonly scale: number },
  ticks: number,
  locale: string,
  daysWord: string,
): string {
  const unitValue = ticks / lever.scale;
  if (lever.unit === "days") {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(unitValue)} ${daysWord}`;
  }
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(unitValue);
}
