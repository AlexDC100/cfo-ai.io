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
//
// 2026-10-02, the third review. The first harvest read a TAG LIST
// ("h1,h2,h3,p,li,a,button,span,div,time"); the landing renders four
// <strong> elements, and a claim typed inside one passed every gate. A
// gate now reads EVERY TEXT NODE of a rendered page (`textNodes`, a
// TreeWalker), and the pages a visitor reaches without a session are
// mounted here once, for both copy gates: the landing, /pricing, /signup,
// /sample and /contact-sales (`renderPublicPage`). The test file supplies
// the doubles a page needs (auth, the visitor's plan, the toast) with
// `vi.mock` — a mock is hoisted per file and cannot live here.

import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import {
  __setPricingConfigForTest,
  type PlanConfig,
  type PricingPublicConfig,
} from "@/lib/pricingConfig";
import ContactSalesPage from "@/pages/cfo/ContactSalesPage";
import Landing from "@/pages/cfo/Landing";
import Pricing from "@/pages/cfo/Pricing";
import PublicSample from "@/pages/cfo/PublicSample";
import Signup from "@/pages/cfo/Signup";

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

function plan(p: Partial<PlanConfig> & { key: PlanConfig["key"] }): PlanConfig {
  return {
    display_name: p.key, blurb: "", price_eur: 0, recurring: false, requires_card: false,
    included_docs: 1, extra_doc_eur: null, chat_daily_cap: null, chat_monthly_cap: null,
    window_days: null, ...p,
  } as PlanConfig;
}

/** The pricing config the pricing table renders from — the backend's
 *  values, verbatim (src/engine/api/_pricing_config.py; held to that file by
 *  pricingMatchesRegistry / shippedClaimsMatchCode), INCLUDING the server's
 *  English blurbs the cards must not show and the Multi-Country one. */
export const PRICING_CONFIG_FIXTURE: PricingPublicConfig = {
  plans: [
    plan({ key: "trial" }),
    plan({ key: "intro", price_eur: 0.99, window_days: 7 }),
    plan({ key: "solo", display_name: "RO Solo", price_eur: 4.99, recurring: true, purchasable: true,
      included_docs: 3, extra_doc_eur: 1.49, max_workspaces: 1, allows_non_ro: false,
      blurb: "Three Romanian analyses per month, extras at €1.49/doc." }),
    plan({ key: "pro", display_name: "Pro", price_eur: 9.99, recurring: true, purchasable: true,
      included_docs: 15, extra_doc_eur: 0.99, max_workspaces: 5, allows_non_ro: false,
      blurb: "Fifteen Romanian analyses per month, extras at €0.99/doc." }),
    plan({ key: "multi", display_name: "Multi-Country", price_eur: 16.99, recurring: true, purchasable: true,
      included_docs: 15, extra_doc_eur: 0.99, max_workspaces: 5, allows_non_ro: true,
      included_nonro_docs: 8, extra_nonro_doc_eur: 1.49,
      blurb: "Fifteen analyses per month plus eight non-Romanian documents included; overages metered." }),
  ],
};

/** The public pages a visitor reaches with no session. */
export type PublicPage = "landing" | "pricing" | "signup" | "sample" | "contact-sales";
export const PUBLIC_PAGES: PublicPage[] = ["landing", "pricing", "signup", "sample", "contact-sales"];

/** Mount one public page in `lang` and hand back its root. The caller
 *  cleans up (and clears the pricing config: `__clearPricingConfigForTest`). */
export async function renderPublicPage(page: PublicPage, lang: SurfaceLang): Promise<HTMLElement> {
  if (page === "landing") return renderLanding(lang);
  cleanup();
  installBrowserStubs();
  await setLanguage(lang);
  if (page === "pricing") __setPricingConfigForTest(PRICING_CONFIG_FIXTURE);
  const element =
    page === "pricing" ? <Pricing />
      : page === "signup" ? <Signup />
        : page === "sample" ? <PublicSample />
          : <ContactSalesPage />;
  const { container } = render(<MemoryRouter initialEntries={[`/${page}`]}>{element}</MemoryRouter>);
  return container;
}

export interface TextNodeLine {
  /** The element that owns the text node: its tag, and the ids / test ids above it. */
  where: string;
  text: string;
  element: Element;
}

/** EVERY text node under `root`, in document order — a TreeWalker, not a
 *  tag list — except those inside an element matching `skip` (and <style> /
 *  <script>). Whitespace collapsed; empty nodes dropped. */
export function textNodes(root: Element, skip?: string): TextNodeLine[] {
  const out: TextNodeLine[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest("style,script")) continue;
    if (skip && parent.closest(skip)) continue;
    const text = (node.textContent ?? "").replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const marks: string[] = [];
    for (let el: Element | null = parent; el && el !== root; el = el.parentElement) {
      const testId = el.getAttribute("data-testid");
      if (el.id) marks.unshift(`#${el.id}`);
      else if (testId) marks.unshift(`@${testId}`);
    }
    out.push({ where: `${marks.slice(-3).join(" ")} <${parent.tagName.toLowerCase()}>`.trim(), text, element: parent });
  }
  return out;
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
