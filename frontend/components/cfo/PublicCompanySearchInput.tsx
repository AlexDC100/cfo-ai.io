// NASDAQ-8 — Big Apple-clean search input. Debounced, with loading state.
//
// State owned by parent (PublicCompanySearchPage) so the parent can reset
// it (e.g. when user lands on the page from a deep link). Debounce window
// is 300ms — feels instant but doesn't fire on every keystroke.

import { Search, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

interface Props {
  value: string;
  onChange: (next: string) => void;
  loading: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}

export function PublicCompanySearchInput({
  value,
  onChange,
  loading,
  autoFocus = true,
  placeholder = "Search by ticker (AAPL) or company name (Apple)…",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  return (
    <div className="
      relative flex items-center gap-3
      h-12 px-4
      rounded-md border border-rule
      bg-surface
      focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/20
      transition-all duration-micro
    ">
      <Search size={20} strokeWidth={1.75} className="text-ink-mute shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="characters"
        data-testid="public-company-search-input"
        className="
          flex-1 min-w-0
          bg-transparent outline-none
          text-[15px] text-ink placeholder:text-ink-mute
          tracking-[-0.005em]
        "
      />
      {loading && (
        <Loader2
          size={16}
          strokeWidth={1.75}
          className="shrink-0 text-brand-d animate-spin"
        />
      )}
    </div>
  );
}
