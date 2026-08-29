// /login — standalone sign-in page.
//
// Layout: dark canvas matching the landing hero's background, the landing
// page's own tab bar (MarketingHeader), centered AuthCard.

import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthCard } from "@/components/cfo/AuthCard";
import { MarketingHeader } from "./Landing";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  // Optional return path (e.g. the landing page sends ?next=/ so the user
  // comes back to it after signing in). Internal paths only — a value not
  // starting with a single "/" is ignored to rule out open redirects.
  const rawNext = searchParams.get("next");
  const next = rawNext && /^\/(?!\/)/.test(rawNext) ? rawNext : "/dashboard";
  // Landing's "Get started" CTAs link here with ?mode=sign_up so the card
  // opens straight to account creation instead of sign-in.
  const initialMode = searchParams.get("mode") === "sign_up" ? "sign_up" : "sign_in";
  return (
    <div
      className="min-h-screen text-ink flex flex-col"
      style={{
        background:
          "radial-gradient(ellipse 70% 60% at 50% 0%, hsl(var(--brand) / 0.10), transparent 60%), hsl(var(--bg))",
      }}
    >
      <MarketingHeader />

      <main className="flex-1 flex items-center justify-center px-5 py-10 sm:py-16">
        <div className="w-full max-w-[440px]">
          <AuthCard
            initialMode={initialMode}
            tabsHidden={false}
            subtitle={initialMode === "sign_up" ? t("authX.subtitle_sign_up") : t("authX.subtitle_sign_in_page")}
            onAuthenticated={() => navigate(next)}
          />
        </div>
      </main>
    </div>
  );
}
