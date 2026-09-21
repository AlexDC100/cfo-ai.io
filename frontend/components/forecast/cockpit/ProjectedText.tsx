// A PROJECTED FIGURE THE ENGINE SERVED ALREADY FORMATTED — the four numbers
// ("54,4 mil. lei"), the final-year margin, the DSCR ("2,10×") — painted with
// the same ◇ mark <CockpitAmountView> and <ProjectedAmount> put on a projected
// amount, and the same DOM attributes a gate reads (`data-projected="true"`,
// `data-projected-value`, `data-projected-mark`).
//
// The text is the ENGINE's (`numbers.*.display[lang]`): this component
// computes nothing and formats nothing; it only guarantees the mark travels
// with the number.

export function ProjectedText({
  text,
  period,
  projectedLabel,
  className,
  testId,
}: {
  text: string;
  period: string;
  projectedLabel: string;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      className={["forecast-projected", className].filter(Boolean).join(" ")}
      data-projected="true"
      data-projected-period={period}
      data-testid={testId}
    >
      <span data-projected-value="true">{text}</span>
      <sup
        aria-label={projectedLabel}
        title={projectedLabel}
        data-projected-mark="true"
        className="ml-[0.15em] select-none text-[0.65em] font-normal not-italic text-ink-mute"
      >
        ◇
      </sup>
    </span>
  );
}
