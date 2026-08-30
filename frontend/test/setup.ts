// Repair Web Storage before ANYTHING else. Node 25 installs a dud
// `localStorage`/`sessionStorage` global that shadows jsdom's working one;
// see webStorageShim.ts for the full diagnosis. This import must stay first —
// i18next's language detector reads localStorage at import time, so loading
// "@/i18n" ahead of the shim would let it resolve a language against broken
// storage and cache the result for the whole file.
import "./webStorageShim";

import "@testing-library/jest-dom";
// Initialize the real i18n singleton (EN resources) so components using
// useTranslation() render English strings in tests instead of raw keys —
// required since the 2026-08-04 i18n pass moved UI copy into en/ro.json.
import "@/i18n";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
