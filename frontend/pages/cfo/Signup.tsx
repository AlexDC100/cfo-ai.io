// /signup — standalone create-account page.

import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthCard } from "@/components/cfo/AuthCard";
import { Logo } from "@/components/cfo/Logo";

export default function Signup() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <header className="px-6 sm:px-10 py-5 flex items-center justify-between gap-3">
        <Link to="/" className="flex items-center gap-3">
          <Logo size={26} compact />
          <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule">
            {t("authX.tagline")}
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <Link to="/" className="text-[13px] text-ink-soft hover:text-ink transition-colors">
            {t("auth.back_to_home")}
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-5 py-10 sm:py-16">
        <div className="w-full max-w-[440px]">
          <AuthCard
            initialMode="sign_up"
            tabsHidden={false}
            subtitle={t("authX.subtitle_sign_up_page")}
            onAuthenticated={() => navigate("/dashboard")}
          />
        </div>
      </main>

      <footer className="px-6 sm:px-10 py-6 text-[11px] text-ink-soft/70 text-center">
        {t("authX.disclaimer")}
      </footer>
    </div>
  );
}
