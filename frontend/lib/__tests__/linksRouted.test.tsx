// NO LINK IN THE PRODUCT LEADS TO A PATH THE APP DOES NOT ROUTE.
//
// WHY THIS EXISTS (found 2026-10-04 by the review of the no-prior hotfix):
// the learning popover's source-account rows linked to
// `/financials?account=<code>`, and the cash-flow card's "upload the prior
// period" to `/financials`. App.tsx has never routed `/financials` (the
// statements page was /financial-statements, then /dashboard), so both
// opened the not-found page in production — for months, because nothing
// compares the paths the source links to with the paths the router knows.
// The Playwright specs click what they were written to click; a link nobody
// scripted is a link with no gate.
//
// THE LAW. Every path literal in the frontend's source — a string or
// template literal that begins with "/", an origin-prefixed template
// (`${window.location.origin}/…`), or an `href="/…"` / `action="/…"` /
// `src="/…"` written inside a string of HTML (the landing page, the legal
// documents, a translation) — is one of:
//
//   page      a path App.tsx routes (a `:param` segment takes any segment; a
//             `${…}` in the literal is a segment of unknown text);
//   request   a request, never a place the browser goes: `/health`, and
//             anything under a prefix the dev server proxies
//             (vite.config.ts `server.proxy` — read from that file, so the
//             list cannot drift from it);
//   asset     a file under public/ — and the file must BE there (for a
//             literal ending in `${…}`, its directory);
//   not-a-path  prose: a literal with whitespace in it, or one of the
//             price-unit suffixes listed below ("/mo").
//
// Anything else is a link to the not-found page and reds, wherever it is
// written — an attribute, a `navigate()` call, a nav model's `to:`, a
// function's default parameter. The walk is over the TypeScript AST, so a
// path NAMED in a comment (to say it was retired) is not a link.
//
// WHAT IT REDS ON, with the defect repaired (TC-11): a new literal path
// App.tsx does not route (a typo, a page renamed in the router and not at
// its callers, a route deleted while a link remains); a public asset linked
// and not in public/; a route removed from App.tsx that something still
// links; a listed unit suffix that no source file uses any more (the list
// only shrinks); the learning popover's account row leaving the account
// view (`accountEvidenceHref`), dropping the period or the company, or
// landing on a tab the account's class does not live on.
//
// WHAT IT CANNOT SEE: a path assembled at run time (`"/" + name`, a route
// read from the feature registry or served by the engine — attention/1's
// actions, a notification's target); a `${…}` segment's VALUE (it is held to
// the route's shape only, so `/workspace/${x}` passes whatever x is); the
// query string and the hash (`?tab=` slugs are evidenceLanding.test.tsx's
// law; whether `/#pricing` names a section that exists is nobody's);
// whether a ROUTED path renders anything useful (a FeatureRoute's pending
// state, a redirect chain); index.html and the files under public/; links
// the engine renders (the public storefront, e-mails); external URLs.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { SourceAccountRow } from "@/components/learning/LearningPopover";
import { PopoverStackProvider, usePopoverStack } from "@/components/learning/PopoverStackProvider";
import { STATIC_SOURCE_ACCOUNTS } from "@/lib/learning/sourceAccountMap";
import { accountStatementTab } from "@/lib/evidence/evidenceLink";
import { readEvidenceRequest } from "@/components/cfo/evidence/evidenceView";

const REPO = resolve(process.cwd());
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

/** `${…}` inside a template literal: text the source does not spell. */
const HOLE = "\u0000";

/** A price-unit suffix printed after an amount — a string that begins with
 *  "/" and is not a path. Each must still occur in the source (the list
 *  only shrinks). */
const UNIT_SUFFIXES: readonly string[] = ["/mo", "/lună"];

// ── The router ─────────────────────────────────────────────────────────

function parse(rel: string, text = read(rel)): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Every `<Route path="…">` of App.tsx, the catch-all included. */
function routePathsOf(app: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === "Route"
    ) {
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.name.getText() === "path" && attr.initializer && ts.isStringLiteral(attr.initializer)) {
          out.push(attr.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(app);
  return out;
}

const ALL_ROUTE_PATHS = routePathsOf(parse("frontend/App.tsx"));
const ROUTES = [...new Set(ALL_ROUTE_PATHS.filter((p) => p !== "*"))];

const segmentsOf = (path: string) => path.split("/").filter((s) => s.length > 0);
const escapeRx = (lit: string) => lit.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");

/** Does the app route this path? `path` is a pathname (no query, no hash)
 *  and may hold HOLEs. */
function isRouted(path: string): boolean {
  const cs = segmentsOf(path);
  return ROUTES.some((route) => {
    const rs = segmentsOf(route);
    if (rs.length !== cs.length) return false;
    return rs.every((seg, i) => {
      if (seg.startsWith(":")) return true;
      if (!cs[i].includes(HOLE)) return cs[i] === seg;
      // A segment with a hole: its spelled text must be the route's, in
      // order; the hole is whatever is left (a query suffix, an id).
      const spelled = cs[i].split(HOLE).map(escapeRx).join(".*");
      return new RegExp("^" + spelled + "$").test(seg);
    });
  });
}

// ── What is not a page ─────────────────────────────────────────────────

/** The prefixes the dev server proxies upstream — read from vite.config.ts. */
function proxiedPrefixes(): string[] {
  const src = read("vite.config.ts");
  const block = /proxy:\s*\{([\s\S]*?)\n {4}\},/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/^\s{6}"(\/[a-z-]+)":\s*\{/gm)].map((m) => m[1]);
}
const PROXIED = proxiedPrefixes();

type Kind = "page" | "request" | "asset" | "not-a-path" | "UNROUTED";

function classify(literal: string): Kind {
  if (/\s/.test(literal) || UNIT_SUFFIXES.includes(literal)) return "not-a-path";
  const path = literal.split(/[?#]/)[0];
  if (path === "/health" || PROXIED.some((p) => path === p || path.startsWith(`${p}/`))) return "request";
  if (isRouted(path)) return "page";
  // A public asset: the file, or — when the name is a hole — its directory.
  const spelled = path.includes(HOLE) ? path.slice(0, path.indexOf(HOLE)).replace(/[^/]*$/, "") : path;
  if (segmentsOf(spelled).length > 0 && existsSync(join(REPO, "public", spelled))) return "asset";
  return "UNROUTED";
}

// ── The walk ───────────────────────────────────────────────────────────

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__" || name === "test") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      acc.push(relative(REPO, full));
    }
  }
  return acc;
}

interface Found {
  literal: string;
  where: string;
}

/** `href="/…"`, `action="/…"`, `src="/…"` written inside a string. */
const EMBEDDED = /(?:href|action|src)\s*=\s*\\?["'](\/[^"'\\]*)/g;

function pathLiteralsOf(rel: string, text?: string): Found[] {
  const sf = parse(rel, text);
  const out: Found[] = [];
  const at = (node: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      text = node.text;
    } else if (ts.isTemplateExpression(node)) {
      text = node.head.text + node.templateSpans.map((s) => HOLE + s.literal.text).join("");
      // `${window.location.origin}/auth/callback` is a link to the app.
      if (node.head.text === "" && /\borigin\b/i.test(node.templateSpans[0].expression.getText())) {
        text = text.slice(1);
      }
    }
    if (text !== null) {
      if (/^\/(?:$|[\p{L}\p{N}#?\u0000])/u.test(text)) out.push({ literal: text, where: at(node) });
      else for (const m of text.matchAll(EMBEDDED)) out.push({ literal: m[1], where: at(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The translation bundles: a sentence may carry a link. */
function pathLiteralsOfBundle(rel: string): Found[] {
  const out: Found[] = [];
  const walk = (node: unknown, key: string) => {
    if (typeof node === "string") {
      for (const m of node.matchAll(EMBEDDED)) out.push({ literal: m[1], where: `${rel}:${key}` });
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, key ? `${key}.${k}` : k);
    }
  };
  walk(JSON.parse(read(rel)), "");
  return out;
}

const FILES = [
  ...sourceFiles(join(REPO, "frontend")),
  // The native shell opens the web app at a path of its own (HOME_PATH).
  "mobile/App.tsx",
  ...sourceFiles(join(REPO, "mobile", "src")),
];
const FOUND: Found[] = [
  ...FILES.flatMap((rel) => pathLiteralsOf(rel)),
  ...pathLiteralsOfBundle("frontend/i18n/locales/en.json"),
  ...pathLiteralsOfBundle("frontend/i18n/locales/ro.json"),
];
const show = (literal: string) => literal.split(HOLE).join("${…}");

describe("links-routed — every path the source links to is a path App.tsx routes", () => {
  it("the router is read: its routes, and the catch-all an unrouted path falls to", () => {
    expect(ROUTES).toContain("/dashboard");
    expect(ROUTES).toContain("/workspace/:orgId");
    // The consequence the law exists for: anything unmatched is the
    // not-found page.
    expect(ALL_ROUTE_PATHS.filter((p) => p === "*").length).toBe(1);
    expect(read("frontend/App.tsx")).toMatch(/<Route path="\*" element=\{<NotFound \/>\} \/>/);
    // The matcher itself, on the router's own shapes.
    expect(isRouted("/dashboard")).toBe(true);
    expect(isRouted(`/workspace/${HOLE}`)).toBe(true);
    expect(isRouted(`/dashboard${HOLE}`)).toBe(true); // `/dashboard${qs}`
    expect(isRouted("/workspace/a/b")).toBe(false);
    expect(isRouted("/dashboards")).toBe(false);
    expect(isRouted(`/report/${HOLE}`)).toBe(false);
    expect(isRouted("/financials")).toBe(false);
    expect(classify("/financials?account=701")).toBe("UNROUTED");
  });

  it("the walk reads every form a link is written in — and not a path that is only NAMED in a comment", () => {
    const snippet = [
      '// a comment naming "/retired-a" is not a link',
      'const model = [{ to: "/in-a-model" }];',
      'function go(navigate: (to: string) => void, back = "/a-default") { navigate("/in-a-call"); return back; }',
      'const built = (id: string) => `/built/${id}?x=${id}`;',
      'const own = `${window.location.origin}/own-origin`;',
      'const html = `<a class="x" href="/in-html?plan=${model.length}">go</a><img src=\'/in-src.png\'>`;',
      'const node = <><Link to="/in-jsx">x</Link><a href={"/in-braces"}>y</a></>; /* "/retired-b" */',
      'const unit = "/mo"; const prose = "/ per month"; const api = base + "/api/thing";',
    ].join("\n");
    expect(pathLiteralsOf("snippet.tsx", snippet).map((f) => show(f.literal))).toEqual([
      "/in-a-model",
      "/a-default",
      "/in-a-call",
      "/built/${…}?x=${…}",
      "/own-origin",
      "/in-html?plan=${…}",
      "/in-src.png",
      "/in-jsx",
      "/in-braces",
      "/mo",
      "/api/thing",
    ]);
    // …and it reaches the app, the pages, the components, the libraries
    // and the native shell.
    for (const dir of ["frontend/App.tsx", "frontend/pages/", "frontend/components/", "frontend/lib/", "mobile/"]) {
      expect(FOUND.some((f) => f.where.startsWith(dir)), dir).toBe(true);
    }
  });

  it("no path literal in the source is unrouted — a page, a request, a public asset, or not a path at all", () => {
    const kinds = new Map<Kind, number>();
    const unrouted: string[] = [];
    for (const f of FOUND) {
      const kind = classify(f.literal);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (kind === "UNROUTED") unrouted.push(`${f.where}  ${show(f.literal)}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `GATE-WORK links-routed files=${FILES.length} literals=${FOUND.length} ` +
        `pages=${kinds.get("page") ?? 0} requests=${kinds.get("request") ?? 0} ` +
        `assets=${kinds.get("asset") ?? 0} not_paths=${kinds.get("not-a-path") ?? 0} ` +
        `routes=${ROUTES.length} unrouted=${unrouted.length}`,
    );
    expect(unrouted, "a link to a path App.tsx does not route opens the not-found page").toEqual([]);
    // Every class is exercised — an empty one means the walk or the
    // classifier stopped seeing it.
    for (const kind of ["page", "request", "asset", "not-a-path"] as const) {
      expect(kinds.get(kind) ?? 0, kind).toBeGreaterThan(0);
    }
  });

  it("what is exempt is still what it was exempted as", () => {
    // The request prefixes are the dev server's own proxy table.
    expect(PROXIED).toContain("/api");
    // A unit suffix nothing prints any more is a hole in the law, not an
    // exemption: the list only shrinks.
    const literals = new Set(FOUND.map((f) => f.literal));
    for (const unit of UNIT_SUFFIXES) expect(literals.has(unit), `${unit} is no longer in the source`).toBe(true);
    // …and none of them could be mistaken for a page.
    for (const unit of UNIT_SUFFIXES) expect(isRouted(unit)).toBe(false);
  });
});

// ── The repaired link ──────────────────────────────────────────────────

function Probe() {
  const { pathname, search } = useLocation();
  const { stack, push } = usePopoverStack();
  return (
    <div>
      <output data-testid="location">{pathname + search}</output>
      <output data-testid="stack">{stack.length}</output>
      <button type="button" onClick={() => push({ conceptKey: "revenue", value: 1 })}>open</button>
    </div>
  );
}

function mountRow(code: string, scope: { periodId: string | null; orgId: string | null }, onLeave = () => {}) {
  return render(
    <MemoryRouter initialEntries={["/dashboard?period=p-on-screen&org=o-on-screen&tab=overview"]}>
      <PopoverStackProvider>
        <Probe />
        <SourceAccountRow
          account={{ code, label: "An account", amount: 0 }}
          currency="RON"
          scope={scope}
          onLeave={onLeave}
        />
      </PopoverStackProvider>
    </MemoryRouter>,
  );
}

describe("links-routed — the learning popover's source account opens the account view", () => {
  const SCOPE = { periodId: "p-on-screen", orgId: "o-on-screen" };
  // Every code the static map can put in a row.
  const CODES = [...new Set(Object.values(STATIC_SOURCE_ACCOUNTS).flatMap((list) => list.map((a) => a.code)))];

  it("every code of the static map: a routed path, the period and company on screen, the account's own statement, the code the receiver reads", () => {
    expect(CODES.length).toBeGreaterThan(0);
    for (const code of CODES) {
      const { unmount } = mountRow(code, SCOPE);
      const href = screen.getByTestId(`learn-pop-account-${code}`).getAttribute("href") ?? "";
      const [path, query = ""] = href.split("?");
      expect(isRouted(path), `${code}: ${href}`).toBe(true);
      const sp = new URLSearchParams(query);
      expect(sp.get("period")).toBe("p-on-screen");
      expect(sp.get("org")).toBe("o-on-screen");
      expect(sp.get("tab")).toBe(accountStatementTab(code));
      // The dashboard's receiver (EvidenceDrawer) reads exactly this code.
      expect(readEvidenceRequest(sp)?.accounts).toEqual([code]);
      unmount();
    }
    // eslint-disable-next-line no-console
    console.log(`GATE-WORK links-routed account_rows=${CODES.length}`);
  });

  it("a click stays in the app: the location becomes the account view, the popover stack closes, the popover is told", () => {
    let left = 0;
    mountRow("701", SCOPE, () => { left += 1; });
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("stack").textContent).toBe("1");
    fireEvent.click(screen.getByTestId("learn-pop-account-701"));
    expect(screen.getByTestId("location").textContent).toBe(
      "/dashboard?period=p-on-screen&org=o-on-screen&tab=pl&account=701",
    );
    // From the dashboard the pathname does not change, so the stack would
    // not close by itself.
    expect(screen.getByTestId("stack").textContent).toBe("0");
    expect(left).toBe(1);
  });

  it("the popover hands the row the period on screen and its own close", () => {
    // The row is rendered above with a scope of the test's; what the popover
    // itself passes is read from its source.
    const src = read("frontend/components/learning/LearningPopover.tsx");
    const uses = src.match(/<SourceAccountRow\b[\s\S]*?\/>/g) ?? [];
    expect(uses.length).toBe(1);
    expect(uses[0]).toContain("scope={{ periodId: activePeriod.id, orgId: activePeriod.organizationId }}");
    expect(uses[0]).toContain("onLeave={onClose}");
  });

  it("with no period loaded the row still leads to a routed page (the dashboard's own empty state)", () => {
    mountRow("5121", { periodId: null, orgId: null });
    const href = screen.getByTestId("learn-pop-account-5121").getAttribute("href") ?? "";
    expect(href).toBe("/dashboard?tab=balance_sheet&account=5121");
    expect(isRouted(href.split("?")[0])).toBe(true);
  });
});
