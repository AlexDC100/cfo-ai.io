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
