// Jurisdiction (country accounting pack) selector — AI lane, 2026-08-19.
//
// Two mounts, one component:
//   · PeriodConfirmDialog (pre-scan decision point) — includeAuto, default
//     "auto"; the chosen value rides the upload as `jurisdiction_hint`
//     (threaded through uploadDocument exactly the way periodEndHint is).
//   · BS jurisdiction badge (post-scan override) — includeAuto=false; a
//     change arms the re-extraction confirm flow (BSStatementView).
//
// The option set mirrors the engine's country-pack codes: RO (RomaniaPack),
// HU (HungaryPack skeleton), INTL (no pack — generic international). "auto"
// means "send no hint; the engine's detection decides".

import { useState } from "react";
import { useTranslation } from "react-i18next";
import "./bsCanonicalStatusI18n";

/** Dropdown value — "auto" is UI-only (it maps to a null hint). */
export type JurisdictionSelection = "auto" | "RO" | "HU" | "INTL";

export const JURISDICTION_OPTIONS: readonly JurisdictionSelection[] = [
  "RO",
  "HU",
  "INTL",
];

/** The wire value for the upload: "auto" sends NO hint (engine detects). */
export function jurisdictionHintFromSelection(
  value: JurisdictionSelection | string,
): string | null {
  return value === "auto" ? null : value;
}

/** Display label for a pack code (unknown codes render verbatim so a
 *  future pack never renders blank). */
export function jurisdictionLabel(
  code: string,
  t: (key: string) => string,
): string {
  switch (code) {
    case "auto":
      return t("bsCanonical.jurisdiction.auto");
    case "RO":
      return t("bsCanonical.jurisdiction.ro");
    case "HU":
      return t("bsCanonical.jurisdiction.hu");
    case "INTL":
      return t("bsCanonical.jurisdiction.intl");
    default:
      return code;
  }
}

interface Props {
  /** Controlled value; omit for uncontrolled (starts at `defaultValue`). */
  value?: string;
  /** Uncontrolled starting value — "auto" by default. */
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Offer the Auto-detect option (pre-scan). Post-scan override drops it —
   *  a served result always HAS a resolved jurisdiction. */
  includeAuto?: boolean;
  id?: string;
  disabled?: boolean;
  "data-testid"?: string;
  className?: string;
  "aria-label"?: string;
}

export function JurisdictionSelect({
  value,
  defaultValue = "auto",
  onChange,
  includeAuto = true,
  id,
  disabled,
  className,
  ...rest
}: Props) {
  const { t } = useTranslation();
  const [inner, setInner] = useState<string>(defaultValue);
  const current = value ?? inner;

  // A served value outside the known set (future pack) still renders as a
  // selectable option instead of snapping the select to a wrong entry.
  const known: string[] = [
    ...(includeAuto ? ["auto"] : []),
    ...JURISDICTION_OPTIONS,
  ];
  const options = known.includes(current) ? known : [...known, current];

  return (
    <select
      id={id}
      disabled={disabled}
      data-testid={rest["data-testid"] ?? "jurisdiction-select"}
      aria-label={rest["aria-label"] ?? t("bsCanonical.jurisdiction.selectAria")}
      value={current}
      onChange={(e) => {
        if (value === undefined) setInner(e.target.value);
        onChange?.(e.target.value);
      }}
      className={
        className ??
        "h-8 rounded-lg border border-rule bg-surface px-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
      }
    >
      {options.map((code) => (
        <option key={code} value={code}>
          {jurisdictionLabel(code, t)}
        </option>
      ))}
    </select>
  );
}
