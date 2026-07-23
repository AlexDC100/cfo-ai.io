// /login — standalone sign-in page.
//
// Layout: dark canvas matching the landing hero's background, the landing
// page's own tab bar (MarketingHeader), centered AuthCard.

import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthCard } from "@/components/cfo/AuthCard";
import { MarketingHeader } from "./Landing";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Optional return path (e.g. the landing page sends ?next=/ so the user
  // comes back to it after signing in). Internal paths only — a value not
  // starting with a single "/" is ignored to rule out open redirects.
  const rawNext = searchParams.get("next");
  const next = rawNext && /^\/(?!\/)/.test(rawNext) ? rawNext : "/dashboard";
  return (
    <div
      className="min-h-screen text-ink flex flex-col"
      style={{
        background:
          "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(92,211,197,.10), transparent 60%), #060a12",
      }}
    >
      <MarketingHeader />

      <main className="flex-1 flex items-center justify-center px-5 py-10 sm:py-16">
        <div className="w-full max-w-[440px]">
          <AuthCard
            initialMode="sign_in"
            tabsHidden={false}
            subtitle="Sign in to your CFO AI workspace."
            onAuthenticated={() => navigate(next)}
          />
        </div>
      </main>
    </div>
  );
}
