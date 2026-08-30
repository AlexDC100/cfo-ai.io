// THE CAPSULE — INTENT ROUTER.
//
// One text box, four destinations. This module decides, on EVERY
// keystroke and with NO model call, whether what you are typing is a
// place to go, a thing to open, a command to run, or a question to ask.
//
//   NAVIGATE  a short noun phrase that names a route ("cash flow",
//             "bilanț", "scenarios")
//   ENTITY    a shape: a ticker, a RAS account code, a CUI
//             ("TLV", "cont 5121", "RO14399840")
//   ACTION    a verb phrase that names a registered command
//             ("upload trial balance", "exportă raportul")
//   ASK       an interrogative, a trailing question mark, a
//             natural-language shape, or anything unmatched with at
//             least three words
//
// ── Why this exists ───────────────────────────────────────────────────
//
// The palette used to hand every keystroke to the chat page. That is
// both slow and expensive: typing "dashboard" is navigation, and
// navigation must never cost a model call. So classification is pure
// data + pure functions here, and the model is reached ONLY by
// activating the Ask row (`willCallModel`). Nothing in this file
// fetches, imports i18n, touches storage, or reads a clock — it is a
// function of (query, context), which is what makes the fixture set in
// `capsuleRouterFixtures.ts` a real gate rather than a snapshot.
//
// ── The two guarantees the surface depends on ─────────────────────────
//
// INV-1  Every result contains EXACTLY ONE Ask row, at index 0 or 1.
//        `askInOneKeystroke` is therefore always true: from the default
//        selection, Ask is one ArrowDown away — and Tab jumps straight
//        to it from anywhere (`nextIndex`).
// INV-2  A model call happens only when the ACTIVATED row is the Ask
//        row. When a query matches a route, an entity or an action,
//        that match is row 0, so Enter navigates and costs nothing.
//
// `rows` is the KEYBOARD ORDER. A renderer may group rows visually (each
// row carries `group`), but it must keep this index order for INV-1 to
// hold — the Ask row sits deliberately between the top match and the
// rest.
//
// ── Rules are data ────────────────────────────────────────────────────
//
// `CAPSULE_ROUTES`, `CAPSULE_ACTIONS`, `CAPSULE_ENTITY_RULES` and the
// ask-trigger vocabularies are plain frozen arrays, EN + RO. Adding a
// destination is a data edit with a fixture line, not a new branch.
// i18n lives in `capsuleRouterStrings.json` (registered by
// `capsuleRouterI18n.ts`); rows carry KEYS, never rendered copy, so this
// module stays pure and testable.

// ─── Types ─────────────────────────────────────────────────────────────

export type CapsuleLane = "navigate" | "entity" | "action" | "ask";

export type CapsuleRowKind = "route" | "action" | "entity" | "ask";

export type CapsuleEntityKind = "ticker" | "account_code" | "cui";

export interface CapsuleRouteRule {
  id: string;
  /** Destination path, exactly as the router knows it. */
  to: string;
  /** i18n key for the row label — reuses the rail's own names. */
  labelKey: string;
  /** Lowercase, diacritic-folded match tokens (EN + RO). */
  tokens: readonly string[];
}

export interface CapsuleActionRule {
  id: string;
  /** The registered command the host executes. Never a URL. */
  commandId: string;
  labelKey: string;
  /** Folded verb tokens that open the phrase. */
  verbs: readonly string[];
  /** Folded object tokens; an action needs a verb AND an object. */
  objects: readonly string[];
}

export interface CapsuleEntityRule {
  id: string;
  kind: CapsuleEntityKind;
  /** Regex source, applied to the RAW query (`raw`) or the folded one. */
  pattern: string;
  on: "raw" | "folded";
  labelKey: string;
}

export interface CapsuleEntityMatch {
  kind: CapsuleEntityKind;
  /** The extracted value — the ticker, the account code, the CUI. */
  value: string;
}

export interface CapsuleRow {
  id: string;
  lane: CapsuleLane;
  kind: CapsuleRowKind;
  /** i18n key for the group heading. */
  group: string;
  /** i18n key for the label, when the label is translated copy. */
  labelKey?: string;
  /** Interpolation params for `labelKey` (the Ask row carries the query). */
  labelParams?: Record<string, string>;
  /** Literal label, when the label IS the user's own text (an entity). */
  label?: string;
  to?: string;
  commandId?: string;
  entity?: CapsuleEntityMatch;
  /** Deterministic match strength; ordering is (score desc, id asc). */
  score: number;
}

export interface CapsuleClassification {
  lane: CapsuleLane;
  /** True when the query reads as more than one lane at once — the
   *  surface then shows both the matches and the Ask row. */
  ambiguous: boolean;
  /** Which rules fired, in order. Stable strings, for debugging and
   *  for the fixture gate's failure messages. */
  reasons: readonly string[];
  /** Folded query. */
  normalized: string;
  /** Word count of the folded query. */
  words: number;
}

export interface CapsuleRouterResult {
  query: string;
  classification: CapsuleClassification;
  /** Keyboard order. Contains exactly one row of kind "ask". */
  rows: readonly CapsuleRow[];
  /** Index of the Ask row. Always 0 or 1 (INV-1). */
  askIndex: number;
  /** Always true — kept explicit so the gate asserts the guarantee
   *  rather than the implementation. */
  askInOneKeystroke: boolean;
  /** Initially selected row. Always 0; named so callers do not encode
   *  the assumption themselves. */
  defaultIndex: number;
  /** True when nothing matched and the Ask row is the only row. */
  noResults: boolean;
}

export interface CapsuleRouterContext {
  /** Known listed companies, for name/ticker recognition. */
  tickers?: readonly { ticker: string; name?: string }[];
  /** Account codes present in the active period, if known. */
  accountCodes?: readonly string[];
  /** Extra destinations (feature-gated routes the host knows about). */
  routes?: readonly CapsuleRouteRule[];
  /** Extra commands the host has registered. */
  actions?: readonly CapsuleActionRule[];
  /** Rows shown for an empty query. Defaults to the first six routes. */
  emptyStateRouteIds?: readonly string[];
}

// ─── Group keys ────────────────────────────────────────────────────────

export const GROUP_PAGES = "capsuleRouter.group.pages";
export const GROUP_ACTIONS = "capsuleRouter.group.actions";
export const GROUP_ENTITIES = "capsuleRouter.group.entities";
export const GROUP_ASK = "capsuleRouter.group.ask";

export const ASK_ROW_ID = "capsule.ask";

// ─── The rules (DATA) ──────────────────────────────────────────────────

/** Destinations. Tokens are folded (lowercase, no diacritics) so the RO
 *  entries match whether or not the user types the accents. */
export const CAPSULE_ROUTES: readonly CapsuleRouteRule[] = Object.freeze([
  {
    id: "route.dashboard", to: "/dashboard", labelKey: "sidebar.dashboard",
    tokens: ["dashboard", "overview", "home", "acasa", "panou", "tablou de bord"],
  },
  {
    id: "route.workspace", to: "/workspace", labelKey: "sidebar.workspaces",
    tokens: ["workspace", "workspaces", "spatiu de lucru", "companie", "firma"],
  },
  {
    id: "route.scenarios", to: "/dashboard/scenarios", labelKey: "sidebar.scenarios",
    tokens: ["scenarios", "scenario", "scenarii", "what if", "ce ar fi daca"],
  },
  {
    id: "route.benchmark", to: "/benchmark", labelKey: "sidebar.benchmark",
    tokens: ["benchmark", "benchmarks", "peers", "referinta", "comparatie sector"],
  },
  {
    id: "route.products", to: "/products", labelKey: "sidebar.products",
    tokens: ["products", "product", "skus", "sku", "produse"],
  },
  {
    id: "route.variance", to: "/dashboard/variance", labelKey: "sidebar.variance",
    tokens: ["variance", "budget variance", "buget", "abateri"],
  },
  {
    id: "route.decisions", to: "/decisions", labelKey: "sidebar.decisions",
    tokens: ["decisions", "decizii"],
  },
  {
    id: "route.alerts", to: "/alerts", labelKey: "sidebar.alerts",
    tokens: ["alerts", "alerte", "notifications", "notificari"],
  },
  {
    id: "route.publicCompanies", to: "/public-companies",
    labelKey: "sidebar.publicCompanies",
    tokens: ["public companies", "markets", "bursa", "companii listate", "piete"],
  },
  {
    id: "route.chat", to: "/chat", labelKey: "sidebar.chat",
    tokens: ["chat", "ask cfo", "intreaba"],
  },
  {
    id: "route.settings", to: "/settings", labelKey: "sidebar.settings",
    tokens: ["settings", "preferences", "setari", "preferinte"],
  },
  {
    id: "route.invoices", to: "/invoices", labelKey: "sidebar.invoices",
    tokens: ["invoices", "facturi"],
  },
  {
    id: "route.inventory", to: "/inventory", labelKey: "sidebar.inventory",
    tokens: ["inventory", "stocuri"],
  },
  {
    id: "route.balanceSheet", to: "/dashboard?tab=statements#balance-sheet",
    labelKey: "capsuleRouter.route.balanceSheet",
    tokens: ["balance sheet", "bilant", "situatia pozitiei financiare"],
  },
  {
    id: "route.profitLoss", to: "/dashboard?tab=statements#profit-loss",
    labelKey: "capsuleRouter.route.profitLoss",
    tokens: ["profit and loss", "profit & loss", "p&l", "pnl", "profit",
             "cont de profit si pierdere"],
  },
  {
    id: "route.cashFlow", to: "/dashboard?tab=statements#cash-flow",
    labelKey: "capsuleRouter.route.cashFlow",
    tokens: ["cash flow", "cashflow", "cash", "flux de numerar", "numerar"],
  },
  {
    id: "route.report", to: "/report", labelKey: "capsuleRouter.route.report",
    tokens: ["report", "comprehensive report", "raport"],
  },
  {
    id: "route.history", to: "/multi-year-history",
    labelKey: "capsuleRouter.route.history",
    tokens: ["history", "multi year", "istoric"],
  },
]);

/** Commands. An action needs a VERB and an OBJECT: "export" alone is a
 *  destination word, "export excel" is an instruction. */
export const CAPSULE_ACTIONS: readonly CapsuleActionRule[] = Object.freeze([
  {
    id: "action.upload", commandId: "capsule.upload",
    labelKey: "capsuleRouter.action.upload",
    verbs: ["upload", "import", "add", "incarca", "importa", "adauga"],
    objects: ["file", "document", "trial balance", "balance", "balanta",
              "tb", "statement", "fisier", "raport"],
  },
  {
    id: "action.export", commandId: "capsule.export",
    labelKey: "capsuleRouter.action.export",
    verbs: ["export", "download", "descarca", "exporta", "salveaza"],
    objects: ["excel", "xlsx", "csv", "pdf", "report", "raport", "data",
              "statements", "situatii"],
  },
  {
    id: "action.theme", commandId: "capsule.theme",
    labelKey: "capsuleRouter.action.theme",
    verbs: ["switch", "toggle", "change", "schimba", "comuta"],
    objects: ["theme", "dark", "light", "tema", "intunecat", "luminos"],
  },
  {
    id: "action.newChat", commandId: "capsule.newChat",
    labelKey: "capsuleRouter.action.newChat",
    verbs: ["new", "start", "open", "incepe", "deschide"],
    objects: ["chat", "conversation", "conversatie", "discutie"],
  },
  {
    id: "action.toggleSidebar", commandId: "capsule.toggleSidebar",
    labelKey: "capsuleRouter.action.toggleSidebar",
    verbs: ["toggle", "hide", "show", "collapse", "comuta", "ascunde"],
    objects: ["sidebar", "rail", "menu", "meniu", "bara laterala"],
  },
]);

/** Shapes. Order matters: the first rule that matches wins, so the
 *  explicitly-prefixed CUI is tested before the bare digit run. */
export const CAPSULE_ENTITY_RULES: readonly CapsuleEntityRule[] = Object.freeze([
  {
    id: "entity.cui", kind: "cui", on: "folded",
    pattern: "^(?:cui|cif)\\s*:?\\s*(?:ro)?\\s*([0-9]{2,10})$|^ro\\s?([0-9]{2,10})$",
    labelKey: "capsuleRouter.entity.cui",
  },
  {
    id: "entity.account", kind: "account_code", on: "folded",
    pattern: "^(?:cont|contul|account|acc)?\\s*([0-9]{3,8})$",
    labelKey: "capsuleRouter.entity.account",
  },
  {
    id: "entity.ticker", kind: "ticker", on: "raw",
    pattern: "^([A-Z][A-Z0-9]{1,7}(?:\\.[A-Z]{2,5})?)$",
    labelKey: "capsuleRouter.entity.ticker",
  },
]);

/** Single-token interrogatives that open a question, EN + RO (folded). */
export const ASK_LEAD_TOKENS: readonly string[] = Object.freeze([
  "what", "why", "how", "when", "where", "which", "who", "whom", "whose",
  "can", "could", "should", "would", "will", "is", "are", "was", "were",
  "do", "does", "did", "am", "has", "have", "had",
  "ce", "cum", "cand", "unde", "care", "cine", "cat", "cati", "cate",
  "pot", "poti", "putem", "este", "sunt", "exista", "ar", "avem",
]);

/** Multi-word natural-language openers, EN + RO (folded). */
export const ASK_LEAD_PHRASES: readonly string[] = Object.freeze([
  "de ce", "how much", "how many", "tell me", "show me", "explain",
  "explica", "spune mi", "arata mi", "compare", "compara", "cat de",
  "ce inseamna", "what is", "what are", "give me", "da mi",
]);

/** Shapes that read as a question anywhere in the string (folded). */
export const ASK_SHAPE_TOKENS: readonly string[] = Object.freeze([
  " vs ", " versus ", " fata de ", " compared to ",
]);

/** A query longer than this is no longer a "short noun phrase", so a
 *  merely-contained route token does not make it navigation. */
export const NAVIGATE_MAX_WORDS = 4;

/** Unmatched input needs at least this many words to read as a question. */
export const ASK_MIN_WORDS = 3;

/** Hard cap on returned rows — the Ask row is never the one dropped. */
export const MAX_ROWS = 12;

// ─── Normalisation ─────────────────────────────────────────────────────

/** Lowercase, diacritic-folded, punctuation-softened, space-collapsed.
 *  The ONE normaliser; every token in the rule tables is written in its
 *  output alphabet. */
export function foldQuery(input: string): string {
  return (input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-_'’]/g, " ")
    .replace(/[?!,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(folded: string): number {
  return folded ? folded.split(" ").length : 0;
}

/** Word-boundary containment — "cash" must not match inside "cashier". */
function containsToken(folded: string, token: string): boolean {
  const padded = ` ${folded} `;
  return padded.includes(` ${token} `);
}

// ─── Matching ──────────────────────────────────────────────────────────

const SCORE_EXACT = 100;
const SCORE_PREFIX = 85;
const SCORE_CONTAINS = 65;

interface RouteMatch { rule: CapsuleRouteRule; score: number }

function matchRoutes(
  folded: string,
  routes: readonly CapsuleRouteRule[],
): RouteMatch[] {
  if (!folded) return [];
  const out: RouteMatch[] = [];
  for (const rule of routes) {
    let best = 0;
    for (const token of rule.tokens) {
      if (folded === token) best = Math.max(best, SCORE_EXACT);
      else if (folded.length >= 2 && token.startsWith(folded)) {
        best = Math.max(best, SCORE_PREFIX);
      } else if (token.length >= 3 && containsToken(folded, token)) {
        best = Math.max(best, SCORE_CONTAINS);
      }
    }
    if (best > 0) out.push({ rule, score: best });
  }
  out.sort((a, b) => (b.score - a.score) || a.rule.id.localeCompare(b.rule.id));
  return out;
}

interface ActionMatch { rule: CapsuleActionRule; score: number }

function matchActions(
  folded: string,
  actions: readonly CapsuleActionRule[],
): ActionMatch[] {
  if (!folded) return [];
  const words = folded.split(" ");
  const out: ActionMatch[] = [];
  for (const rule of actions) {
    const verbIndex = words.findIndex((w) => rule.verbs.includes(w));
    if (verbIndex < 0) continue;
    // Object match is a SUBSTRING so RO inflection ("raportul") still
    // resolves to its stem ("raport") without a morphology table.
    const hasObject = rule.objects.some((o) => folded.includes(o));
    if (!hasObject) continue;
    out.push({ rule, score: verbIndex === 0 ? SCORE_EXACT : SCORE_CONTAINS });
  }
  out.sort((a, b) => (b.score - a.score) || a.rule.id.localeCompare(b.rule.id));
  return out;
}

const ENTITY_REGEXPS = CAPSULE_ENTITY_RULES.map((rule) => ({
  rule,
  rx: new RegExp(rule.pattern),
}));

function matchEntityShape(
  raw: string,
  folded: string,
): { rule: CapsuleEntityRule; match: CapsuleEntityMatch } | null {
  for (const { rule, rx } of ENTITY_REGEXPS) {
    const subject = rule.on === "raw" ? raw : folded;
    const m = rx.exec(subject);
    if (!m) continue;
    const captured = m.slice(1).find((g) => typeof g === "string" && g.length > 0);
    return {
      rule,
      match: { kind: rule.kind, value: (captured ?? m[0]).toUpperCase() },
    };
  }
  return null;
}

function matchKnownTickers(
  folded: string,
  tickers: readonly { ticker: string; name?: string }[],
): { ticker: string; name?: string; score: number }[] {
  if (!folded || folded.length < 2) return [];
  const out: { ticker: string; name?: string; score: number }[] = [];
  for (const row of tickers) {
    const t = foldQuery(row.ticker);
    const n = foldQuery(row.name ?? "");
    if (t === folded || n === folded) out.push({ ...row, score: SCORE_EXACT });
    else if (t.startsWith(folded) || (n && n.startsWith(folded))) {
      out.push({ ...row, score: SCORE_PREFIX });
    }
  }
  out.sort((a, b) => (b.score - a.score) || a.ticker.localeCompare(b.ticker));
  return out.slice(0, 4);
}

function askTrigger(raw: string, folded: string): string | null {
  if (raw.trim().endsWith("?")) return "trailing_question_mark";
  if (!folded) return null;
  for (const phrase of ASK_LEAD_PHRASES) {
    if (folded === phrase || folded.startsWith(`${phrase} `)) {
      return `lead_phrase:${phrase}`;
    }
  }
  const first = folded.split(" ")[0];
  if (ASK_LEAD_TOKENS.includes(first)) return `lead_token:${first}`;
  for (const shape of ASK_SHAPE_TOKENS) {
    if (` ${folded} `.includes(shape)) return `shape:${shape.trim()}`;
  }
  return null;
}

// ─── Row construction ──────────────────────────────────────────────────

function routeRow(match: RouteMatch): CapsuleRow {
  return {
    id: match.rule.id,
    lane: "navigate",
    kind: "route",
    group: GROUP_PAGES,
    labelKey: match.rule.labelKey,
    to: match.rule.to,
    score: match.score,
  };
}

function actionRow(match: ActionMatch): CapsuleRow {
  return {
    id: match.rule.id,
    lane: "action",
    kind: "action",
    group: GROUP_ACTIONS,
    labelKey: match.rule.labelKey,
    commandId: match.rule.commandId,
    score: match.score,
  };
}

function entityRow(
  rule: CapsuleEntityRule,
  match: CapsuleEntityMatch,
  score: number,
): CapsuleRow {
  return {
    id: `${rule.id}:${match.value}`,
    lane: "entity",
    kind: "entity",
    group: GROUP_ENTITIES,
    labelKey: rule.labelKey,
    label: match.value,
    entity: match,
    score,
  };
}

function askRow(query: string): CapsuleRow {
  return {
    id: ASK_ROW_ID,
    lane: "ask",
    kind: "ask",
    group: GROUP_ASK,
    labelKey: query.trim()
      ? "capsuleRouter.ask.row"
      : "capsuleRouter.ask.rowEmpty",
    labelParams: { query: query.trim() },
    score: 0,
  };
}

// ─── The router ────────────────────────────────────────────────────────

const DEFAULT_CONTEXT: CapsuleRouterContext = Object.freeze({});

/** Classify without building rows. Pure, allocation-light — safe to call
 *  on every keystroke. */
export function classify(
  query: string,
  ctx: CapsuleRouterContext = DEFAULT_CONTEXT,
): CapsuleClassification {
  return routeQuery(query, ctx).classification;
}

/**
 * Classify a query and build the keyboard-ordered row list.
 *
 * Precedence, in this order and for this reason:
 *   1. ASK TRIGGER — an explicit question stays a question even when it
 *      happens to contain a route word ("is the balance sheet balanced").
 *   2. EXACT ROUTE — a query that IS a destination name is navigation,
 *      even when it also looks like a ticker ("ALERTS").
 *   3. ENTITY SHAPE — a code is a code; nothing else in this product
 *      spells "5121".
 *   4. ACTION — verb + object.
 *   5. ROUTE (prefix/contains) for short phrases.
 *   6. ASK fallback for unmatched input of three words or more.
 */
export function routeQuery(
  query: string,
  ctx: CapsuleRouterContext = DEFAULT_CONTEXT,
): CapsuleRouterResult {
  const cached = readCache(query, ctx);
  if (cached) return cached;

  const raw = (query ?? "").trim();
  const folded = foldQuery(raw);
  const words = wordCount(folded);
  const reasons: string[] = [];

  const routes = ctx.routes ? [...CAPSULE_ROUTES, ...ctx.routes] : CAPSULE_ROUTES;
  const actions = ctx.actions
    ? [...CAPSULE_ACTIONS, ...ctx.actions]
    : CAPSULE_ACTIONS;

  const routeMatches = matchRoutes(folded, routes);
  const actionMatches = matchActions(folded, actions);
  const shape = matchEntityShape(raw, folded);
  const knownTickers = matchKnownTickers(folded, ctx.tickers ?? []);
  const trigger = askTrigger(raw, folded);
  const exactRoute = routeMatches.length > 0 && routeMatches[0].score === SCORE_EXACT;

  // Empty query: the default destinations plus Ask. Nothing is
  // classified, so nothing can be mis-classified.
  if (!folded) {
    reasons.push("empty");
    const ids = ctx.emptyStateRouteIds;
    const defaults = (ids
      ? routes.filter((r) => ids.includes(r.id))
      : routes.slice(0, 6)
    ).map((rule) => routeRow({ rule, score: SCORE_CONTAINS }));
    return finalize(query, {
      lane: "navigate", ambiguous: false, reasons, normalized: folded, words,
    }, defaults, [], ctx);
  }

  let lane: CapsuleLane;
  const primary: CapsuleRow[] = [];
  const secondary: CapsuleRow[] = [];

  const routeRows = routeMatches.map(routeRow);
  const actionRows = actionMatches.map(actionRow);
  const entityRows: CapsuleRow[] = [];
  if (knownTickers.length) {
    for (const hit of knownTickers) {
      entityRows.push(entityRow(
        CAPSULE_ENTITY_RULES.find((r) => r.kind === "ticker")!,
        { kind: "ticker", value: hit.ticker.toUpperCase() },
        hit.score,
      ));
    }
  }
  if (shape && !entityRows.some((r) => r.entity?.value === shape.match.value)) {
    entityRows.push(entityRow(shape.rule, shape.match, SCORE_EXACT));
  }

  if (trigger) {
    lane = "ask";
    reasons.push(`ask:${trigger}`);
    primary.push(...routeRows, ...actionRows, ...entityRows);
  } else if (exactRoute) {
    lane = "navigate";
    reasons.push(`route_exact:${routeMatches[0].rule.id}`);
    primary.push(...routeRows);
    secondary.push(...actionRows, ...entityRows);
  } else if (entityRows.length) {
    lane = "entity";
    reasons.push(`entity:${entityRows[0].entity?.kind}`);
    primary.push(...entityRows);
    secondary.push(...routeRows, ...actionRows);
  } else if (actionRows.length) {
    lane = "action";
    reasons.push(`action:${actionMatches[0].rule.id}`);
    primary.push(...actionRows);
    secondary.push(...routeRows);
  } else if (routeRows.length && words <= NAVIGATE_MAX_WORDS) {
    lane = "navigate";
    reasons.push(`route:${routeMatches[0].rule.id}`);
    primary.push(...routeRows);
  } else if (words >= ASK_MIN_WORDS) {
    lane = "ask";
    reasons.push("ask:unmatched_long");
    primary.push(...routeRows);
  } else {
    // One or two words that match nothing. NOT a question yet — a typo
    // or a half-typed word. The Ask row is still there, one keystroke
    // away, so the user is never stuck.
    lane = "navigate";
    reasons.push("unmatched_short");
  }

  const ambiguous =
    lane === "ask"
      ? primary.length > 0
      : secondary.length > 0 || (lane !== "navigate" && routeRows.length > 0);
  if (ambiguous) reasons.push("ambiguous");

  return finalize(query, {
    lane, ambiguous, reasons, normalized: folded, words,
  }, primary, secondary, ctx);
}

function finalize(
  query: string,
  classification: CapsuleClassification,
  primary: readonly CapsuleRow[],
  secondary: readonly CapsuleRow[],
  ctx: CapsuleRouterContext,
): CapsuleRouterResult {
  const ask = askRow(query);
  const ordered: CapsuleRow[] = [];
  if (classification.lane === "ask" || primary.length === 0) {
    // The question IS the answer path: Ask leads.
    ordered.push(ask, ...primary, ...secondary);
  } else {
    // The top match leads and Ask sits directly under it — one
    // ArrowDown, always (INV-1).
    ordered.push(primary[0], ask, ...primary.slice(1), ...secondary);
  }
  const askIndex = ordered.findIndex((r) => r.kind === "ask");
  const rows = ordered.slice(0, Math.max(MAX_ROWS, askIndex + 1));
  const result: CapsuleRouterResult = {
    query,
    classification,
    rows,
    askIndex,
    askInOneKeystroke: askIndex <= 1,
    defaultIndex: 0,
    noResults: rows.length === 1 && rows[0].kind === "ask",
  };
  writeCache(query, ctx, result);
  return result;
}

// ─── Keyboard ──────────────────────────────────────────────────────────

/** Where a key moves the selection. Tab always lands on Ask — that is
 *  the second half of the one-keystroke guarantee, for users who are
 *  already several rows down. */
export function nextIndex(
  result: CapsuleRouterResult,
  current: number,
  key: string,
): number {
  const last = result.rows.length - 1;
  if (last < 0) return 0;
  if (key === "Tab") return result.askIndex;
  if (key === "ArrowDown") return Math.min(current + 1, last);
  if (key === "ArrowUp") return Math.max(current - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return last;
  return Math.min(Math.max(current, 0), last);
}

/** The ONE predicate that decides whether activating a row costs a model
 *  call. Navigation, entities and actions are always false. */
export function willCallModel(
  result: CapsuleRouterResult,
  index: number,
): boolean {
  return result.rows[index]?.kind === "ask";
}

// ─── Memoisation ───────────────────────────────────────────────────────
//
// Typing is a burst of near-identical queries; a per-context LRU keeps
// the repeated prefixes free. Pure function, pure cache — the same
// (query, context) always yields the same object.

const CACHE_LIMIT = 240;
const CACHES = new WeakMap<object, Map<string, CapsuleRouterResult>>();

function cacheFor(ctx: CapsuleRouterContext): Map<string, CapsuleRouterResult> {
  const key = (ctx ?? DEFAULT_CONTEXT) as object;
  let cache = CACHES.get(key);
  if (!cache) {
    cache = new Map();
    CACHES.set(key, cache);
  }
  return cache;
}

function readCache(
  query: string,
  ctx: CapsuleRouterContext,
): CapsuleRouterResult | undefined {
  return cacheFor(ctx).get(query);
}

function writeCache(
  query: string,
  ctx: CapsuleRouterContext,
  result: CapsuleRouterResult,
): void {
  const cache = cacheFor(ctx);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(query, result);
}

/** Test/host hook — drops the memo for one context (or all of them). */
export function clearCapsuleRouterCache(ctx?: CapsuleRouterContext): void {
  if (ctx) cacheFor(ctx).clear();
  else cacheFor(DEFAULT_CONTEXT).clear();
}
