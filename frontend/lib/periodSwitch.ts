// Trigger for the fullscreen "re-scoping the app" cover.
//
// Split from the component (components/cfo/PeriodSwitchOverlay.tsx) so callers
// — the sidebar month stepper, the workspace switcher — import a plain function
// instead of pulling in a React component module. Mirrors how the language
// overlay keeps its bus in `@/i18n` rather than in the overlay.
//
// Both triggers share one overlay because they're the same event from the
// user's side: everything on screen is about to be replaced with a different
// slice of data, and a partial repaint mid-flight looks broken.

export const PERIOD_SWITCH_EVENT = "cfo:period-switch-start";

export interface PeriodSwitchDetail {
  /** Label shown under the spinner — a month ("March 2026") or workspace name. */
  label: string | null;
  /** Drives the accessible announcement; the two cases are indistinguishable
   *  visually but shouldn't be to a screen reader. */
  kind: "period" | "workspace";
}

function dispatch(kind: PeriodSwitchDetail["kind"], label?: string | null): void {
  window.dispatchEvent(
    new CustomEvent<PeriodSwitchDetail>(PERIOD_SWITCH_EVENT, {
      detail: { label: label ?? null, kind },
    }),
  );
}

/** Show the fullscreen switching cover. Call immediately BEFORE changing the
 *  active period; the overlay lifts on its own once the new month's queries
 *  settle (see PeriodSwitchOverlay for the dismissal rules). */
export function startPeriodSwitch(label?: string): void {
  dispatch("period", label);
}

/** Same cover, for switching workspace. A workspace switch clears the whole
 *  query cache and refetches every surface, so it needs the cover even more
 *  than a month change does. */
export function startWorkspaceSwitch(label?: string): void {
  dispatch("workspace", label);
}
