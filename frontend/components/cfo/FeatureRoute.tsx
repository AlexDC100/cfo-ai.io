// FeatureRoute — the route-level half of the launch cut.
//
// Hiding a nav item is NOT hiding a feature: every route in App.tsx is
// reachable by typing the URL, by an old bookmark, by a link in an email,
// and by the browser's own history. Before this component the sidebar
// filter in Sidebar.tsx was the only gate, so `/benchmark` or
// `/dashboard/scenarios` still mounted the real page for anyone who
// deep-linked — which is exactly the "nav leads somewhere half-working"
// failure the launch gate forbids.
//
// So the ROUTE consults the same registry the nav does, and renders
// <PendingState> unless the feature's status is `active`.
//
// FAILING DIRECTION IS DELIBERATE. `useFeatures()` returns `{}` when the
// engine is unreachable, so every gated key reads `undefined` → the route
// renders PendingState. A user who cannot reach the backend sees a
// designed "not in this release" page rather than a page whose every
// query is about to fail. `active` is the ONLY value that opens a route.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFeatures, type FeatureKey } from "@/lib/features";
import { PendingState } from "@/components/cfo/PendingState";

/**
 * `loading` placeholder. Deliberately NOT a spinner: it is a still, empty
 * hold that occupies the same space, matching ContentFallback's policy in
 * App.tsx. The registry is one ~4 KB fetch shared app-wide, so this is
 * visible for a single round-trip at most.
 */
function RegistryHold() {
  return (
    <div aria-hidden data-testid="feature-registry-hold" className="px-6 sm:px-10 py-10">
      <div className="h-6 w-1/3 rounded-lg bg-bg-2/80" />
    </div>
  );
}

export function FeatureRoute({
  featureKey,
  children,
}: {
  featureKey: FeatureKey;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { features, loading } = useFeatures();

  if (loading) return <RegistryHold />;

  if (features[featureKey]?.status === "active") return <>{children}</>;

  return (
    <PendingState
      featureKey={featureKey}
      title={t(`pending.${featureKey}.title`, {
        defaultValue: features[featureKey]?.label ?? featureKey,
      })}
      description={t(`pending.${featureKey}.description`, {
        defaultValue: features[featureKey]?.description ?? "",
      })}
      requirement={t(`pending.${featureKey}.requirement`, {
        defaultValue: t("pending.needs"),
      })}
    />
  );
}

export default FeatureRoute;
