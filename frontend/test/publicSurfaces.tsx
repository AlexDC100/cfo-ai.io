// publicSurfaces — render the PUBLIC pages the way a visitor gets them, for
// the two copy gates (landing-proof, public-claims).
//
// The landing is not a set of strings: it is a component that assembles
// HTML from landingStrings, engineProof.json and coverage.json. A gate that
// read the strings would miss everything the assembly adds (the proof
// block's headline values, the coverage table, the coming-soon card), which
// is exactly where the "8 vs 9 / 9" lived. So the gates mount the real
// <Landing /> and read the DOM back.
//
// The only double is auth (a signed-out visitor) — the same mock every
// page test uses. Nothing here stubs copy, proof or coverage.

import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import Landing from "@/pages/cfo/Landing";

export type SurfaceLang = "en" | "ro";

/** jsdom has neither; the landing's step animation and ticker use both. */
export function installBrowserStubs(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.scrollTo = () => {};
  Element.prototype.scrollIntoView ??= () => {};
}

export async function setLanguage(lang: SurfaceLang): Promise<void> {
  await act(async () => {
    await i18n.changeLanguage(lang);
  });
}

/** Mount the public landing (home page: hero, modules, how + coverage,
 *  proof, audiences, pricing, FAQ, footer) in `lang` and hand back its
 *  root. The caller cleans up. */
export async function renderLanding(lang: SurfaceLang): Promise<HTMLElement> {
  cleanup();
  installBrowserStubs();
  await setLanguage(lang);
  const { container } = render(
    <MemoryRouter initialEntries={["/"]}>
      <Landing />
    </MemoryRouter>,
  );
  const root = container.querySelector<HTMLElement>(".cfo-site");
  if (!root) throw new Error("the landing did not render a .cfo-site root");
  return root;
}

/** Visible text of an element, whitespace collapsed, non-breaking spaces
 *  read as plain ones (Intl joins "0.00 RON" with U+00A0). */
export function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Every number printed in `text`, parsed in the surface's language:
 *  English reads "." as the decimal mark and "," as grouping, Romanian the
 *  reverse. Returned as numbers so a law compares VALUES, not strings one
 *  printer produced (CLAUDE.md §26: never compare a printed figure only
 *  against the same printer). */
export function numbersIn(text: string, lang: SurfaceLang): number[] {
  const out: number[] = [];
  const rx = /\d[\d.,]*/g;
  for (const m of text.matchAll(rx)) {
    let raw = m[0].replace(/[.,]+$/, "");
    if (lang === "ro") raw = raw.replace(/\./g, "").replace(",", ".");
    else raw = raw.replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
