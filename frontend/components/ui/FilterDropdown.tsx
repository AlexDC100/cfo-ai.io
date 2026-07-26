// FilterDropdown — the app's pill-styled select.
//
// A Radix popover rather than a native <select>: native selects render with
// the OS's own widget, which ignores the design tokens entirely and looks
// foreign next to the surrounding pills (and can't show a check mark, a
// faded count, or a rotating chevron).
//
// Extracted from Products (2026-07-26), where it replaced the filter selects,
// so the decision-rules controls can use the same control instead of a second
// hand-rolled variant.

import { useState, type ReactNode } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";

export interface DropdownOption {
  value: string;
  label: string;
  /** Optional second line under the label — used where an option needs a
   *  sentence of explanation (the decision-rules presets and modes). */
  description?: ReactNode;
}

export function FilterDropdown({
  value,
  onChange,
  options,
  placeholder,
  count,
  testid,
  id,
  fullWidth = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  /** Label shown when nothing is selected (value === ""). */
  placeholder: string;
  /** Optional faded count shown beside the placeholder (no parentheses). */
  count?: number;
  testid?: string;
  /** Set when an external <label htmlFor> points at this control. */
  id?: string;
  /** Stretch to the container instead of hugging its label — for form rows
   *  (decision rules) rather than an inline filter bar. */
  fullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          id={id}
          data-testid={testid}
          className={`${
            fullWidth ? "flex w-full justify-between" : "inline-flex"
          } items-center h-9 pl-3.5 pr-3 rounded-full border border-rule bg-surface text-[13px] font-medium text-ink hover:bg-bg-2 hover:border-rule-strong data-[state=open]:border-brand/40 transition-colors cursor-pointer`}
        >
          <span className={`truncate ${fullWidth ? "" : "max-w-[200px]"}`}>
            {selected ? selected.label : placeholder}
          </span>
          {/* Faded count on the placeholder — no parentheses (2026-07-26). */}
          {!selected && count != null && (
            <span className="ml-1.5 text-ink-mute/60 tabular-nums">{count}</span>
          )}
          {/* Chevron with extra gap to its right (pr-3 on the button + ml-2). */}
          <ChevronDown
            size={14}
            strokeWidth={2}
            className={`ml-2 mr-1 shrink-0 text-ink-mute transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-[110] min-w-[180px] max-w-[min(420px,calc(100vw-24px))] max-h-[320px] overflow-y-auto rounded-xl border border-rule bg-surface p-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.18)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value || "__all__"}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`group flex w-full items-start gap-2 px-2.5 py-1.5 rounded-lg text-left text-[13px] transition-colors ${
                  active ? "bg-brand/[0.08] text-ink" : "text-ink-soft hover:bg-bg-2 hover:text-ink"
                }`}
              >
                <span className="flex-1 min-w-0">
                  <span className={`block ${o.description ? "" : "truncate"}`}>{o.label}</span>
                  {o.description && (
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-mute">
                      {o.description}
                    </span>
                  )}
                </span>
                {active && (
                  <Check size={13} strokeWidth={2.5} className="mt-0.5 shrink-0 text-brand-d" />
                )}
              </button>
            );
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
