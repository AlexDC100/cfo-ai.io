// Section.tsx — labeled group of rows inside a Command Center tab.
//
// Visual: an eyebrow label + a rounded card containing Row children.
// Identical to the legacy CommandDrawer section — extracted so all
// four tabs share the same primitive.
//
// Edge case: if a Section ends up with zero visible children (because
// every Row inside it was `hidden`), it renders nothing. Saves us from
// rendering empty-looking cards when the feature registry hides
// everything in a group.

import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

interface Props {
  label: string;
  children: ReactNode;
}

export function Section({ label, children }: Props): JSX.Element | null {
  // Filter out children that resolved to null (Row returning null when
  // status === "hidden"). React.Children.toArray drops null/false/undefined
  // automatically, so the length check is a reliable "anything renders?"
  // signal.
  const visible = Children.toArray(children).filter((c): c is ReactElement =>
    isValidElement(c),
  );
  if (visible.length === 0) return null;

  return (
    <section className="mb-5" data-testid="command-section">
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute mb-2.5 px-1 font-medium">
        {label}
      </div>
      <div className="rounded-xl border border-rule bg-bg-2 divide-y divide-rule overflow-hidden">
        {children}
      </div>
    </section>
  );
}
