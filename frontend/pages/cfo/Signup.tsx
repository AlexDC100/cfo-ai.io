// /signup — standalone create-account page.

import { Link, useNavigate } from "react-router-dom";
import { AuthCard } from "@/components/cfo/AuthCard";
import { Logo } from "@/components/cfo/Logo";

export default function Signup() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <header className="px-6 sm:px-10 py-5 flex items-center justify-between gap-3">
        <Link to="/" className="flex items-center gap-3">
          <Logo size={26} compact />
          <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule">
            Financial Intelligence
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <Link to="/" className="text-[13px] text-ink-soft hover:text-ink transition-colors">
            Back to home
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-5 py-10 sm:py-16">
        <div className="w-full max-w-[440px]">
          <AuthCard
            initialMode="sign_up"
            tabsHidden={false}
            subtitle="Create your CFO AI workspace. Free tier — no credit card."
            onAuthenticated={() => navigate("/dashboard")}
          />
        </div>
      </main>

      <footer className="px-6 sm:px-10 py-6 text-[11px] text-ink-soft/70 text-center">
        AI-assisted financial recommendations only. Final decisions remain with management.
      </footer>
    </div>
  );
}
