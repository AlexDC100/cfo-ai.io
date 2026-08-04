// useLanguage — resolves the active UI language by walking the priority
// chain defined in src/i18n/index.ts (see file header for the full order).
//
// Two callers are expected:
//   - <LanguageSync /> — mounted at the app root; reads useLanguage() and
//     keeps i18next.language in sync via i18n.changeLanguage().
//   - Components that need to know the active language for non-UI work
//     (e.g. passing output_language to the backend on a re-run).
//
// The resolver itself is auth-aware. Marketing pages (no session) only
// honor URL override and persisted localStorage. Authenticated pages add
// user profile preference and (opt-in) document language.

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import {
  AUTO_DETECT_FLAG_KEY,
  LANGUAGE_CHANGED_EVENT,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGE_CODES,
  isSupportedLanguage,
  type SupportedLanguageCode,
} from "./index";

// ─── Sub-resolvers ──────────────────────────────────────────────────────────

function useUrlLang(): SupportedLanguageCode | null {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const raw = params.get("lang");
  return isSupportedLanguage(raw) ? raw : null;
}

function useLocalStorageLang(): SupportedLanguageCode | null {
  const [value, setValue] = useState<SupportedLanguageCode | null>(() => readStored());

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === LANGUAGE_STORAGE_KEY) setValue(readStored());
    }
    // Same-tab writes don't fire `storage` — setLanguage() dispatches this
    // custom event so the picker's own tab re-resolves immediately instead
    // of depending on the (async, failable) profile mirror.
    function onLocalChange() {
      setValue(readStored());
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(LANGUAGE_CHANGED_EVENT, onLocalChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LANGUAGE_CHANGED_EVENT, onLocalChange);
    };
  }, []);

  return value;
}

function readStored(): SupportedLanguageCode | null {
  try {
    const raw = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isSupportedLanguage(raw) ? raw : null;
  } catch {
    return null;
  }
}

function useAutoDetectFlag(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => readAutoDetect());

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === AUTO_DETECT_FLAG_KEY) setEnabled(readAutoDetect());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return enabled;
}

function readAutoDetect(): boolean {
  try {
    return localStorage.getItem(AUTO_DETECT_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Most recent active document's detected_language. null when:
 *    - user is unauthenticated
 *    - there are no documents yet
 *    - the column is null on every row
 *    - Supabase isn't configured (dev / sample mode) */
function useLastDocumentLanguage(): SupportedLanguageCode | null {
  const { isAuthenticated } = useAuth();
  const supabase = getSupabase();

  const { data } = useQuery({
    queryKey: ["last-document-language"],
    enabled: isAuthenticated && !!supabase,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!supabase) return null;
      const { data, error } = await supabase
        .from("documents")
        .select("detected_language, created_at")
        .not("detected_language", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      return (data as { detected_language: string | null }).detected_language ?? null;
    },
  });

  const code = (data || "").toString().toLowerCase().slice(0, 2);
  return isSupportedLanguage(code) ? code : null;
}

/** Browser Accept-Language → first supported match. Returns null if no
 *  supported match. ONLY used as the last-resort signal on authenticated
 *  pages, and only when no documents exist yet. Marketing pages must NOT
 *  use this — it's gated behind the auth check in useLanguage(). */
function useBrowserLanguageIfSupported(): SupportedLanguageCode | null {
  if (typeof navigator === "undefined") return null;
  const candidates: string[] = [];
  if (navigator.languages?.length) candidates.push(...navigator.languages);
  if (navigator.language) candidates.push(navigator.language);
  for (const candidate of candidates) {
    const code = candidate.toLowerCase().slice(0, 2);
    if (isSupportedLanguage(code)) return code;
  }
  return null;
}

// ─── Main resolver ──────────────────────────────────────────────────────────

/**
 * Resolve the active language by walking the priority chain. Returns a
 * supported code (always falls back to 'en'). Memoized via React Query for
 * the document-language sub-resolver; the rest is cheap.
 */
export function useLanguage(): SupportedLanguageCode {
  const { isAuthenticated, user } = useAuth();
  const urlLang = useUrlLang();
  const storedLang = useLocalStorageLang();
  const autoDetectEnabled = useAutoDetectFlag();
  const docLang = useLastDocumentLanguage();
  const browserLang = useBrowserLanguageIfSupported();

  // Read the user's saved profile language preference (Supabase user_metadata).
  const profileRaw = (user?.user_metadata as Record<string, unknown> | undefined)?.language;
  const profileLang =
    typeof profileRaw === "string" && isSupportedLanguage(profileRaw) ? profileRaw : null;

  // Marketing pages: URL → localStorage → 'en'. Nothing else.
  if (!isAuthenticated) {
    if (urlLang) return urlLang;
    if (storedLang) return storedLang;
    return "en";
  }

  // Authenticated pages: full priority chain.
  if (urlLang) return urlLang;
  if (profileLang) return profileLang;
  if (storedLang) return storedLang;
  // Document language only flips the UI when the user has opted in.
  if (autoDetectEnabled && docLang) return docLang;
  // Browser Accept-Language is a fallback ONLY when no document exists at
  // all. If a document exists in English (or any language) and the user
  // hasn't opted into auto-detect, we stay at English.
  if (!docLang && browserLang) return browserLang;
  return "en";
}

export { SUPPORTED_LANGUAGE_CODES };
