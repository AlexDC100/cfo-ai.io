// ReassuranceCard — the three "5,000+ / Official / Identical" tiles
// that anchor the Public-Companies showcase section. Pure presentational,
// no animation: they sit below the demo frame as a quiet trust-strip,
// so we want them visually calm — the action lives above them.
//
// Stat is the loud bit (24px info-coloured display). Label is the bold
// 14px line that says what the stat counts. Detail is the 12px grey
// supporting prose. Three of these in a row, equal columns; on mobile
// they stack vertically.

interface ReassuranceCardProps {
  /** Headline number / one-word adjective (e.g. "5,000+", "Official"). */
  stat: string;
  /** Bold caption directly below the stat. */
  label: string;
  /** One-line explanation of what the stat means. */
  detail: string;
  /** Optional accent override — default uses --info for the markets motif. */
  accent?: "info" | "brand";
  testid?: string;
}

export function ReassuranceCard({
  stat,
  label,
  detail,
  accent = "info",
  testid,
}: ReassuranceCardProps) {
  const statColor = accent === "brand" ? "text-brand" : "text-info";

  return (
    <div
      data-testid={testid}
      className="
        rounded-xl border border-rule/60 bg-surface/60
        p-5 sm:p-6
      "
    >
      <div className={`font-serif text-[26px] leading-none tabular-nums ${statColor} mb-2`}>
        {stat}
      </div>
      <div className="text-[13.5px] font-semibold text-ink mb-1">{label}</div>
      <div className="text-[12px] text-ink-soft leading-relaxed">{detail}</div>
    </div>
  );
}
