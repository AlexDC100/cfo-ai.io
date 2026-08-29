// EXPLAIN ANYTHING — AI as optional depth, never a dependency (Prompt 12, Part D).
//
// getExplanation() answers "what does this panel mean?" for the panel the
// user is looking at. Two paths, one contract:
//
//   TEMPLATE (deterministic) — 2-3 sentences assembled from the panel's
//     own figures plus the glossary's plain language. Always available,
//     always the same string for the same inputs. This is the floor the
//     drawer stands on with AI dead (gate M4).
//
//   AI (optional depth) — the existing chat Edge Function (cfoApi.chatLlm)
//     with a tight grounded prompt built ONLY from the figures the caller
//     passes — which the caller builds ONLY from what its panel already
//     renders. The model may rephrase; it may not introduce numbers.
//     Successes are cached in localStorage; ANY failure (thrown, or the
//     Edge Function's 200-with-error sentinel) collapses to the template
//     via the chat lane's classifyAiFailure mapper — never an error state,
//     never a raw payload.
//
// Figures arrive as ALREADY-FORMATTED STRINGS — the exact text the panel
// shows. This module never formats, converts or recomputes a value, so it
// cannot disagree with the screen (modes are presentation only; so is this).

import { classifyAiFailure, classifyUpstreamAnswer, type AiFailureKind } from "@/lib/aiDegraded";
import { cfoApi } from "@/lib/cfoApi";
import { plainFor } from "@/lib/glossary";

// Bump when the AI prompt materially changes — cached answers from an
// older prompt stop matching and are simply not found (no migration).
const PROMPT_VERSION = "v1";

export type ExplainPanelKind = "benchmark" | "scenario-impact" | "generic";

export interface ExplainFigure {
  /** Glossary id ("ebitda", "net_debt", ...) when the figure maps to one.
   *  Unknown/absent ids simply add no plain-language enrichment. */
  termId?: string;
  /** The label as the panel renders it (already localized by the caller). */
  label: string;
  /** The value EXACTLY as the panel shows it ("12,4%", "1,52×", "4,9 M RON"). */
  value: string;
  /** Optional second value: the industry median (benchmark panels) or the
   *  scenario outcome (impact panels). Same rule — screen text, verbatim. */
  compare?: string;
}

/** What a consumer supplies. `lang` is injected by the drawer from the
 *  active locale, so page-side call sites never hardcode a language. */
export interface ExplainInput {
  /** Stable panel id ("benchmark-profitability", "scenario-impact"). */
  panelId: string;
  panelKind: ExplainPanelKind;
  /** Coarse data-identity key (period id / label). Figure VALUES are
   *  hashed into the cache key separately, so a stale snapshotKey can
   *  never serve an explanation of different numbers. */
  snapshotKey: string;
  /** The panel's rendered title. */
  title: string;
  /** The figures on screen — the ONLY grounding the AI path receives. */
  figures: ExplainFigure[];
  companyName?: string | null;
}

export interface ExplainRequest extends ExplainInput {
  lang: string; // "en" | "ro" (activeLocale() form accepted too)
}

export interface Explanation {
  text: string;
  source: "ai" | "template";
  /** Set when the AI path failed and the template stands in — the drawer
   *  renders its calm "couldn't add more" retry row from this, never an
   *  error state. */
  degraded: AiFailureKind | null;
}

function isRo(lang: string): boolean {
  return lang.startsWith("ro");
}

// ── Deterministic templates ────────────────────────────────────────────
//
// One lead sentence per panel kind, one figures sentence assembled from
// the caller's strings, one closing read, plus (when a figure carries a
// glossary id) that term's reviewed plain-language sentence. Pure string
// assembly — same inputs, same output, forever.

const FIGURE_LIMIT = 4; // prose stays readable; the panel has the rest

function figuresSentence(req: ExplainRequest): string {
  const ro = isRo(req.lang);
  const parts = req.figures.slice(0, FIGURE_LIMIT).map((f) => {
    if (f.compare && req.panelKind === "scenario-impact") {
      return ro
        ? `${f.label} ar trece de la ${f.value} la ${f.compare}`
        : `${f.label} would go from ${f.value} to ${f.compare}`;
    }
    if (f.compare) {
      return ro
        ? `${f.label} este ${f.value} (tipic: ${f.compare})`
        : `${f.label} is ${f.value} (typical: ${f.compare})`;
    }
    return `${f.label}: ${f.value}`;
  });
  if (parts.length === 0) return "";
  return `${parts.join("; ")}.`;
}

/** The deterministic explanation — exported on its own so the drawer can
 *  paint it synchronously before (and regardless of) any network call. */
export function templateExplanation(req: ExplainRequest): string {
  const ro = isRo(req.lang);
  const company = req.companyName?.trim();

  let lead: string;
  let close: string;
  switch (req.panelKind) {
    case "benchmark":
      lead = ro
        ? `Acest panou compară cifrele ${company ? `pentru ${company}` : "companiei tale"} cu companii tipice din aceeași industrie.`
        : `This panel compares ${company ? `${company}'s` : "your company's"} figures with typical companies in the same industry.`;
      close = ro
        ? "O cifră apropiată de mediană este normală pentru industrie; una mult peste sau sub ea merită atenția ta."
        : "A figure close to the median is normal for the industry; one far above or below it is what deserves your attention.";
      break;
    case "scenario-impact":
      lead = ro
        ? "Aceste cifre arată ce s-ar schimba dacă scenariul s-ar întâmpla — cifrele tale reale rămân neatinse."
        : "These figures show what would change if this scenario happened — your actual numbers stay untouched.";
      close = ro
        ? "Dacă o cifră se înrăutățește aici, vezi unde ar apăsa scenariul mai întâi."
        : "Where a figure worsens here is where the scenario would put pressure first.";
      break;
    default:
      lead = ro
        ? `Pe scurt, iată ce arată panoul „${req.title}”.`
        : `In plain words, here is what the "${req.title}" panel shows.`;
      close = "";
  }

  const figures = figuresSentence(req);

  // One plain-language definition, from the FIRST figure that maps to the
  // reviewed glossary — never more, so the template stays 2-3 sentences.
  const firstTerm = req.figures.find((f) => f.termId && plainFor(f.termId, req.lang));
  const plain = firstTerm?.termId ? plainFor(firstTerm.termId, req.lang) : null;

  return [lead, figures, close, plain ?? ""].filter(Boolean).join(" ").trim();
}

// ── AI prompt ──────────────────────────────────────────────────────────

function buildPrompt(req: ExplainRequest): string {
  const ro = isRo(req.lang);
  const compareWord = req.panelKind === "scenario-impact" ? "scenario" : "industry typical";
  const lines = req.figures.map(
    (f) => `- ${f.label}: ${f.value}${f.compare ? ` (${compareWord}: ${f.compare})` : ""}`,
  );
  const langDirective = ro
    ? "Romanian, informal tu-form, full diacritics"
    : "English";
  return [
    "You are explaining one panel of a financial dashboard to a business owner with no finance background.",
    `Panel: "${req.title}"${req.companyName ? ` for ${req.companyName}` : ""} (${req.panelKind}).`,
    "The figures on screen are listed below. They are the ONLY numbers you may mention — quote them exactly as written; never invent, recompute, convert or extrapolate a figure.",
    ...lines,
    `Write 2 to 4 short sentences in ${langDirective}. Plain words; if a technical term is unavoidable, gloss it in a few words. No advice beyond what these figures show. No headings, no bullet points, no markdown.`,
  ].join("\n");
}

// ── localStorage cache (AI successes only) ─────────────────────────────

const CACHE_KEY = "cfo-explain-cache-v1";
const CACHE_MAX_ENTRIES = 40;

type CacheShape = Record<string, { t: string; at: number }>;

function readCache(): CacheShape {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as CacheShape;
  } catch {
    /* unreadable cache = no cache */
  }
  return {};
}

function writeCache(cache: CacheShape): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable/full — explanations still work, uncached */
  }
}

/** djb2 over the figure strings — folds the actual on-screen values into
 *  the cache identity so changed numbers can never hit a stale entry. */
function figuresHash(req: ExplainRequest): string {
  const s = req.figures.map((f) => `${f.label}=${f.value}|${f.compare ?? ""}`).join(";");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function explainCacheKey(req: ExplainRequest): string {
  const lang = isRo(req.lang) ? "ro" : "en";
  return `${PROMPT_VERSION}|${req.panelId}|${req.snapshotKey}|${lang}|${figuresHash(req)}`;
}

function cacheGet(key: string): string | null {
  const entry = readCache()[key];
  return entry && typeof entry.t === "string" && entry.t.length > 0 ? entry.t : null;
}

function cachePut(key: string, text: string): void {
  const cache = readCache();
  cache[key] = { t: text, at: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX_ENTRIES) {
    keys
      .sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0))
      .slice(0, keys.length - CACHE_MAX_ENTRIES)
      .forEach((k) => delete cache[k]);
  }
  writeCache(cache);
}

// ── Entry point ────────────────────────────────────────────────────────

/** Resolve an explanation. NEVER throws and never returns an error shape:
 *  the worst case is the deterministic template with `degraded` set. */
export async function getExplanation(
  req: ExplainRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<Explanation> {
  const fallback = (kind: AiFailureKind | null): Explanation => ({
    text: templateExplanation(req),
    source: "template",
    degraded: kind,
  });

  if (req.figures.length === 0) {
    // Nothing on screen to ground an AI turn in — the template's lead
    // sentence still says something true; don't spend a model call.
    return fallback(null);
  }

  const key = explainCacheKey(req);
  const cached = cacheGet(key);
  if (cached) return { text: cached, source: "ai", degraded: null };

  try {
    const res = await cfoApi.chatLlm(
      {
        messages: [{ role: "user", content: buildPrompt(req) }],
        mode: "workspace",
        page: req.panelId,
        company_name: req.companyName ?? undefined,
      },
      opts.signal,
    );
    const answer = typeof res?.answer === "string" ? res.answer.trim() : "";
    if (!answer) return fallback("service");
    // The Edge Function wraps upstream Anthropic failures in an HTTP 200
    // whose answer is a sentinel string carrying the raw status + JSON
    // body. Intercept it here — that payload must never reach the DOM.
    const upstream = classifyUpstreamAnswer(answer);
    if (upstream) return fallback(upstream);
    cachePut(key, answer);
    return { text: answer, source: "ai", degraded: null };
  } catch (err) {
    const kind = classifyAiFailure(err);
    try {
      // Raw payload to console.debug ONLY — same discipline as the chat
      // lane's reportAiFailure, labeled for this surface.
      // eslint-disable-next-line no-console
      console.debug("[explain] AI path failed — template served", { kind, error: err });
    } catch {
      /* logging must never throw */
    }
    return fallback(kind);
  }
}

// ── Metric → glossary mapping (best-effort enrichment) ─────────────────

/** Map a backend metric name onto a glossary id, or null. Purely an
 *  enrichment lookup — an unmapped metric just explains without a
 *  dictionary sentence. */
export function glossaryIdForMetric(metricName: string): string | null {
  const n = metricName.toLowerCase();
  if (n.includes("gross_margin") || n.includes("gross margin")) return "gross_margin";
  if (n.includes("net_margin") || n.includes("net margin")) return "net_margin";
  if (n.includes("ebitda")) return "ebitda";
  if (n.includes("net_debt") || n.includes("net debt")) return "net_debt";
  if (n.includes("dso")) return "dso";
  if (n.includes("dscr")) return "dscr";
  if (n.includes("current_ratio") || n.includes("current ratio")) return "current_ratio";
  if (n.includes("debt_to_equity") || n.includes("leverage") || n.includes("indatorare")) return "leverage";
  if (n.includes("equity")) return "equity";
  if (n.includes("liquidity") || n.includes("lichiditate")) return "liquidity";
  if (n.includes("receivable")) return "receivables";
  if (n.includes("payable")) return "payables";
  if (n.includes("inventory") || n.includes("stocuri")) return "inventory";
  if (n.includes("revenue") || n.includes("cifra")) return "revenue";
  if (n.includes("net_profit") || n.includes("net profit")) return "net_profit";
  if (n.includes("margin")) return "margin";
  return null;
}
