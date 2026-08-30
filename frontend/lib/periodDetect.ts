// periodDetect — the frontend client for the engine's hint-free period
// detection service (`/api/period/detect`, Part B), plus the entity
// identity read off the same header bytes.
//
// WHY THIS MODULE EXISTS
// ──────────────────────
// `documents.period_end_hint` is a CONFIRMATION channel. The engine's
// `stage_persist` ranks it ABOVE its own detection, deliberately, because
// the hint is supposed to mean "a human confirmed that THIS document
// belongs to THIS month". The workspace UI was filling it with the DROP
// TARGET's date — a number read off a row, never off the document — so
// the engine correctly discarded correct detections. The 2026-08-30
// production audit found every mismatched row carrying `hint == stored`.
//
// This module is what makes a REAL confirmation possible: it asks the
// document. The dialog shows the answer and its evidence; only what the
// human then confirms is allowed to become a hint.
//
// THE LAWS, restated for the client side
//   W1  UI STATE IS NOT AN INPUT. `buildDetectRequest` accepts a filename
//       and the document's own bytes. There is no parameter for the open
//       period, the drop target, or the last month used, and the engine's
//       POST model is `extra="forbid"`, so smuggling one is a 422 rather
//       than a silently-ignored field.
//   W3  ABSENT != ZERO. "Not detected" is a first-class answer
//       (`proposedPeriodEnd: null`, `signalUsed: "none"`). It is never
//       today, never the open period, never a guess — it forces the human
//       to choose.
//   W5  NO SECOND OPINION. The engine's service is the authority; this
//       module maps its answer verbatim. The in-browser reader below runs
//       ONLY when the engine is unreachable (it can be — see
//       lib/useBackendStatus.ts), and even then it reads the DOCUMENT,
//       never the UI, and says so via `origin: "browser"`.
//
// One deliberate difference from the engine, documented rather than
// hidden: the engine refuses any date equal to today because its filename
// helper returns today when it finds nothing, so the two are
// indistinguishable there. The browser readers below never fall back to
// today, so a genuine today-dated document survives this path. The
// direction of the difference is safe (more evidence, never less).

import { detectPeriodEndFromFilename, detectPeriodEndFromText } from "@/lib/detectPeriodEnd";
import { fetchPeriodFromApi } from "@/lib/activePeriod";
import { getSupabase } from "@/lib/supabase";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

/** The engine's closed set of signals (engine.api._period_detect.SIGNALS). */
export const PERIOD_SIGNALS = [
  "in_document",
  "closing_balance",
  "filename",
  "none",
] as const;

export type PeriodSignal = (typeof PERIOD_SIGNALS)[number];

export interface PeriodCandidate {
  signal: PeriodSignal;
  periodEnd: string;
  evidenceSnippet: string | null;
}

export interface PeriodDetection {
  /** ISO date, or null — which means ABSENT, not "no period". */
  proposedPeriodEnd: string | null;
  /** 0.95 / 0.85 / 0.60 / 0.0 by tier — the engine's numbers, unmodified. */
  confidence: number;
  signalUsed: PeriodSignal;
  /** The literal text the answer was read from — the "why" line. */
  evidenceSnippet: string | null;
  /** Every tier that resolved, rank order — lets the UI show a
   *  disagreement ("content says X, filename says Y"), not just a winner. */
  candidates: PeriodCandidate[];
  /** Who answered. "engine" = the shared service; "browser" = the engine
   *  was unreachable and the file was read here; "unavailable" = nobody
   *  could read anything (still ABSENT, never a guess). */
  origin: "engine" | "browser" | "unavailable";
}

/** The one shape of "not detected". Frozen: it is compared by value. */
export const ABSENT_DETECTION: PeriodDetection = Object.freeze({
  proposedPeriodEnd: null,
  confidence: 0,
  signalUsed: "none" as PeriodSignal,
  evidenceSnippet: null,
  candidates: [] as PeriodCandidate[],
  origin: "unavailable" as const,
});

export interface EntityIdentity {
  /** Company name as printed in the document, or null when absent. */
  name: string | null;
  /** Fiscal code, digits only ("RO 1234567" → "1234567"), or null. */
  cui: string | null;
  /** The literal line it was read from. */
  evidence: string | null;
}

export const ABSENT_ENTITY: EntityIdentity = Object.freeze({
  name: null,
  cui: null,
  evidence: null,
});

export interface DocumentInspection {
  detection: PeriodDetection;
  entity: EntityIdentity;
}

/** The POST body — W1's shape at the wire. */
export interface PeriodDetectRequest {
  filename: string | null;
  extracted: Record<string, string> | null;
}

// ─── the request ─────────────────────────────────────────────────────────

/**
 * Build the detect request. The only inputs are the document's name and
 * the document's own bytes; there is no third parameter and no rest
 * argument, so no caller can widen this into a channel for UI state.
 */
export function buildDetectRequest(input: {
  filename: string | null;
  headerText: string;
}): PeriodDetectRequest {
  const headerText = (input.headerText ?? "").trim();
  return {
    filename: input.filename ?? null,
    // ABSENT != ZERO: unreadable bytes send no `extracted` at all rather
    // than an empty object that would read as "I looked and found none".
    extracted: headerText ? { header_text: headerText.slice(0, 8000) } : null,
  };
}

function asSignal(raw: unknown): PeriodSignal {
  return (PERIOD_SIGNALS as readonly string[]).includes(String(raw))
    ? (raw as PeriodSignal)
    : "none";
}

function mapEngineAnswer(raw: Record<string, unknown>): PeriodDetection {
  const signal = asSignal(raw.signal_used);
  const proposed =
    typeof raw.proposed_period_end === "string" ? raw.proposed_period_end : null;
  const candidates: PeriodCandidate[] = Array.isArray(raw.candidates)
    ? (raw.candidates as Record<string, unknown>[])
        .filter((c) => c && typeof c.period_end === "string")
        .map((c) => ({
          signal: asSignal(c.signal),
          periodEnd: String(c.period_end),
          evidenceSnippet:
            typeof c.evidence_snippet === "string" ? c.evidence_snippet : null,
        }))
    : [];
  return {
    proposedPeriodEnd: signal === "none" ? null : proposed,
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
    signalUsed: signal,
    evidenceSnippet:
      typeof raw.evidence_snippet === "string" ? raw.evidence_snippet : null,
    candidates,
    origin: "engine",
  };
}

/**
 * The in-browser reader. Runs ONLY when the engine cannot be reached, and
 * reads the same two things the engine reads — the document's text and
 * its filename — in the same rank order. Both helpers return null when
 * they recognise nothing, so this path cannot invent a date either.
 */
function detectInBrowser(filename: string | null, headerText: string): PeriodDetection {
  const fromText = detectPeriodEndFromText(headerText);
  if (fromText) {
    const line =
      headerText
        .split(/\r?\n/)
        .find((l) => /\d{4}/.test(l) && /balan|data|sold|perioad|period|as at|as of/i.test(l))
        ?.trim() ?? null;
    return {
      proposedPeriodEnd: fromText,
      confidence: 0.85,
      signalUsed: "closing_balance",
      evidenceSnippet: line ? line.slice(0, 160) : null,
      candidates: [
        { signal: "closing_balance", periodEnd: fromText, evidenceSnippet: line },
      ],
      origin: "browser",
    };
  }
  const fromName = detectPeriodEndFromFilename(filename);
  if (fromName) {
    return {
      proposedPeriodEnd: fromName,
      confidence: 0.6,
      signalUsed: "filename",
      evidenceSnippet: filename,
      candidates: [
        { signal: "filename", periodEnd: fromName, evidenceSnippet: filename },
      ],
      origin: "browser",
    };
  }
  return { ...ABSENT_DETECTION, candidates: [] };
}

/**
 * Ask the engine what month this document covers. Falls back to the
 * in-browser reader when the engine is unreachable, and to ABSENT when
 * neither can read anything.
 */
export async function detectPeriodFromEvidence(input: {
  filename: string | null;
  headerText: string;
}): Promise<PeriodDetection> {
  const body = buildDetectRequest(input);
  try {
    const sb = getSupabase();
    const token = sb
      ? (await sb.auth.getSession()).data.session?.access_token ?? null
      : null;
    if (!token) return detectInBrowser(input.filename, input.headerText);
    const res = await fetch(`${API_URL}/api/period/detect`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return detectInBrowser(input.filename, input.headerText);
    return mapEngineAnswer((await res.json()) as Record<string, unknown>);
  } catch {
    // Engine down / offline / CORS — the document still has evidence.
    return detectInBrowser(input.filename, input.headerText);
  }
}

// ─── reading the document's header ───────────────────────────────────────

/** `Blob.text` / `Blob.arrayBuffer` are recent; FileReader is not. Reading
 *  through the fallback keeps this working on older Safari — and in jsdom,
 *  whose File implements neither, which is where these tests run. */
function readFileAsText(file: File): Promise<string> {
  const blob = file as unknown as { text?: () => Promise<string> };
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : "");
    fr.onerror = () => reject(fr.error ?? new Error("file read failed"));
    fr.readAsText(file);
  });
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  const blob = file as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () =>
      resolve(fr.result instanceof ArrayBuffer ? fr.result : new ArrayBuffer(0));
    fr.onerror = () => reject(fr.error ?? new Error("file read failed"));
    fr.readAsArrayBuffer(file);
  });
}

/**
 * The document's title block — the first rows of a workbook / CSV, where
 * the company line and the reporting period live. Deliberately small:
 * the ledger rows below carry stray dates and no identity, and scanning
 * them would only add noise. Returns "" for formats the browser cannot
 * read (PDF, images) — the engine still gets the filename.
 */
export async function readDocumentHeader(file: File): Promise<string> {
  const lower = (file.name || "").toLowerCase();
  try {
    if (/\.(xlsx|xls)$/.test(lower)) {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await readFileAsArrayBuffer(file), { type: "array" });
      const parts: string[] = [];
      for (const sheet of wb.SheetNames.slice(0, 3)) {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], {
          header: 1,
          blankrows: false,
        });
        for (const row of rows.slice(0, 40)) {
          parts.push((row as unknown[]).map((c) => (c == null ? "" : String(c))).join(" "));
        }
      }
      return parts.join("\n");
    }
    if (/\.(csv|tsv|txt)$/.test(lower)) {
      const text = await readFileAsText(file);
      return text.split(/\r?\n/).slice(0, 40).join("\n");
    }
  } catch {
    // Corrupt / unreadable — fall through to "" (the filename still counts).
  }
  return "";
}

// ─── entity identity ─────────────────────────────────────────────────────

/** Legal forms, as printed in Romanian exports (with and without dots). */
const LEGAL_FORM_TAIL =
  /\b(s\.?\s*r\.?\s*l|s\.?\s*a|s\.?\s*n\.?\s*c|s\.?\s*c\.?\s*s|p\.?\s*f\.?\s*a|kft|zrt|gmbh|ltd|llc|bv|nv|plc|ag|sp\.?\s*z\.?\s*o\.?\s*o)\b\.?\s*$/i;

/** Labels an export may put in front of the company name. */
const NAME_LABEL = /^(denumire|denumirea|societatea|firma|unitatea|company|entity)\s*[:\-]\s*/i;

/** "C.U.I. RO 1234567", "CIF: 1234567", "Cod fiscal 1234567". */
const CUI_RE = /\b(?:c\.?\s*u\.?\s*i\.?|c\.?\s*i\.?\s*f\.?|cod\s+fiscal|vat)\s*[:\-]?\s*(?:ro)?\s*(\d{2,10})\b/i;

/**
 * Read the company identity off a document's header text. Both fields are
 * independently optional: ABSENT != ZERO, so an unreadable header yields
 * nulls and the entity guard simply never fires — it never guesses.
 */
export function detectEntityFromHeader(text: string | null | undefined): EntityIdentity {
  if (!text) return { ...ABSENT_ENTITY };
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());

  let cui: string | null = null;
  for (const line of lines) {
    const m = line.match(CUI_RE);
    if (m) {
      cui = m[1];
      break;
    }
  }

  let name: string | null = null;
  let evidence: string | null = null;
  for (const raw of lines) {
    if (!raw || raw.length > 120) continue;
    const line = raw.replace(NAME_LABEL, "").trim();
    if (!line || !/[A-Za-zĂÂÎȘȚăâîșț]{2,}/.test(line)) continue;
    if (!LEGAL_FORM_TAIL.test(line)) continue;
    name = line;
    evidence = raw;
    break;
  }

  return { name, cui, evidence };
}

/** Digits only — "RO 1234567" and "1234567" are the same company. */
export function normalizeCui(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, "");
  return digits.length >= 2 ? digits.replace(/^0+/, "") : null;
}

/**
 * A comparable company name: diacritics folded, legal form and the "S.C."
 * prefix dropped, punctuation removed. "S.C. Scandia RealEstate S.R.L."
 * and "SCANDIA REALESTATE SRL" normalize to the same string.
 */
export function normalizeEntityName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  s = s.replace(NAME_LABEL, "");
  s = s.replace(/^s\.?\s*c\.?\s+/i, "");
  s = s.replace(
    /\b(s\.?\s*r\.?\s*l|s\.?\s*a|s\.?\s*n\.?\s*c|s\.?\s*c\.?\s*s|p\.?\s*f\.?\s*a|kft|zrt|gmbh|ltd|llc|bv|nv|plc|ag)\b\.?/g,
    " ",
  );
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  return s || null;
}

/**
 * Do these two identities describe different companies? Answers `false`
 * whenever it cannot tell — a guard that fires on absence would train the
 * user to click through it.
 */
export function entitiesConflict(
  a: EntityIdentity | null | undefined,
  b: EntityIdentity | null | undefined,
): boolean {
  if (!a || !b) return false;
  const ca = normalizeCui(a.cui);
  const cb = normalizeCui(b.cui);
  // A fiscal code is the identity; a renamed company keeps its CUI.
  if (ca && cb) return ca !== cb;
  const na = normalizeEntityName(a.name);
  const nb = normalizeEntityName(b.name);
  if (!na || !nb) return false;
  if (na === nb) return false;
  // One name containing the other is a shortening ("scandia food" vs
  // "scandia food holding"), not a different company.
  if (na.includes(nb) || nb.includes(na)) return false;
  return true;
}

/** Positive identities only. A period's company does not change, so a
 *  resolved name is worth keeping across month toggles; a NULL is not
 *  cached, because "no analysis yet" becomes "analysed" the moment the
 *  upload we are about to make finishes, and a cached null would silence
 *  the entity guard for the rest of the session. */
const _entityCache = new Map<string, EntityIdentity>();

/**
 * The identity of what a period ALREADY holds, read off that period's own
 * analysis (the engine's report carries the company it extracted). Null
 * when the period has no analysis yet — ABSENT, so the guard stays quiet.
 */
export async function resolvePeriodEntity(
  periodId: string | null | undefined,
): Promise<EntityIdentity | null> {
  if (!periodId) return null;
  const cached = _entityCache.get(periodId);
  if (cached) return cached;
  try {
    const res = await fetchPeriodFromApi(periodId);
    if (res.kind !== "ok") return null;
    // `res.data.statements` is already typed `Statements`; the previous
    // `as { statements?: Record<string, unknown> }` asserted a looser shape
    // over it, which is how `cui` — a field the blob does not contain —
    // read as a live lookup instead of a permanent null. See the `cui`
    // note on the `Statements` interface.
    const statements = res.data.statements;
    const name =
      statements && typeof statements.companyName === "string"
        ? statements.companyName
        : null;
    const cui =
      statements && typeof statements.cui === "string" ? statements.cui : null;
    if (!name && !cui) return null;
    const entity: EntityIdentity = { name, cui, evidence: null };
    _entityCache.set(periodId, entity);
    return entity;
  } catch {
    return null;
  }
}

/**
 * One read of the file, both guards' evidence. The dialog calls exactly
 * this, with exactly one argument — the file. That signature is the UI's
 * half of W1.
 */
export async function inspectDocument(file: File): Promise<DocumentInspection> {
  const headerText = await readDocumentHeader(file);
  const detection = await detectPeriodFromEvidence({
    filename: file.name ?? null,
    headerText,
  });
  return { detection, entity: detectEntityFromHeader(headerText) };
}
