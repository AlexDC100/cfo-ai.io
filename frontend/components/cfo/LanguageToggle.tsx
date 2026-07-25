// Compact language switcher for TopHeader — sits next to CurrencyToggle.
//
//   ┌───────┐
//   │ 🌐 EN │  click →  ┌───────────────────┐
//   └───────┘            │ 🇬🇧 English   ✓  │
//                        │ 🇷🇴 Română       │
//                        └───────────────────┘
//
// Renders whatever SUPPORTED_LANGUAGES holds (currently just EN + RO);
// a dropdown keeps the top-bar footprint small. Mobile stays usable —
// same pattern, just compact label-less trigger.
//
// Persistence: `pickLanguageWithProfileSync` mirrors the choice to
// localStorage + Supabase `profiles.language` + auth user_metadata so
// `useLanguage()`'s priority chain treats this as the canonical user
// preference. Without the profile sync, `LanguageSync` would re-read
// profileLang on every render and override the localStorage write —
// the click would silently revert.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Globe, Check } from "lucide-react";

import { SUPPORTED_LANGUAGES, pickLanguageWithProfileSync } from "@/i18n";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { useLanguage } from "@/i18n/useLanguage";

export function LanguageToggle() {
  const active = useLanguage();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Click outside / ESC closes the dropdown — same accessor pattern as
  // CurrencyToggle's stale-rates tooltip + Sidebar's globe popover.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = SUPPORTED_LANGUAGES.find((l) => l.code === active)
    ?? SUPPORTED_LANGUAGES[0];

  function handlePick(code: string) {
    setOpen(false);
    void pickLanguageWithProfileSync(code, user ?? null, getSupabase());
  }

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Change language (currently ${current.label})`}
        data-testid="topheader-language-toggle"
        className="
          inline-flex items-center gap-1.5 h-8 px-2.5
          rounded-full border border-rule bg-bg-2
          text-[11.5px] font-medium text-ink-soft
          hover:text-ink hover:bg-bg-2/80 transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40
        "
      >
        <Globe size={12} strokeWidth={1.75} />
        <span className="tracking-wide">{current.code.toUpperCase()}</span>
        <ChevronDown
          size={11}
          strokeWidth={2}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          data-testid="topheader-language-popover"
          className="
            absolute top-full right-0 mt-2 min-w-[180px] z-50
            rounded-xl border border-rule bg-surface shadow-lg
            py-1
          "
        >
          {SUPPORTED_LANGUAGES.map((lng) => {
            const isActive = lng.code === active;
            return (
              <button
                key={lng.code}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => handlePick(lng.code)}
                data-testid={`topheader-language-${lng.code}`}
                className={`
                  w-full text-left px-3 py-2 text-[13px]
                  hover:bg-bg-2 transition-colors
                  flex items-center gap-2.5
                  ${isActive ? "text-ink font-medium" : "text-ink-soft"}
                `}
              >
                <span className="text-[14px] leading-none">{lng.flag}</span>
                <span className="flex-1">{lng.label}</span>
                {isActive && <Check size={13} strokeWidth={2.25} className="text-brand-d" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
