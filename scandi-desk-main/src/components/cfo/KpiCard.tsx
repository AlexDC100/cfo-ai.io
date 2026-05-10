import { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  hint?: string;
  trend?: "up" | "down" | "flat";
  accent?: "default" | "danger" | "success" | "warning" | "info";
}

const ACCENT_CLASS: Record<NonNullable<Props["accent"]>, string> = {
  default: "text-ink",
  danger: "text-alert",
  success: "text-success",
  warning: "text-caution",
  info: "text-info",
};

export function KpiCard({ label, value, hint, accent = "default" }: Props) {
  return (
    <div className="cfo-surface px-6 py-5 transition-shadow hover:shadow-1">
      <div className="label-eyebrow text-ink-soft">{label}</div>
      <div className={`mt-3 font-serif text-[36px] leading-[40px] tracking-[-0.015em] ${ACCENT_CLASS[accent]}`}>
        {value}
      </div>
      {hint && <div className="mt-2 text-[13px] text-ink-soft">{hint}</div>}
    </div>
  );
}
