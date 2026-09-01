// THE CANVAS — SLASH COMMANDS.
//
// Six deterministic shortcuts that SKIP intent routing entirely.
//
//   /chart /table /export /scenario /compare /explain
//
// ══ WHY THEY EXIST ═════════════════════════════════════════════════════
//
// The router (`lib/capsuleRouter.ts`) is very good and still a guess: it
// reads "revenue by month" and decides, from token tables, whether you
// wanted a page, an entity, an action or an answer. Most of the time
// that is what you want. Sometimes you know exactly what you want and
// the guess is friction — you want the TABLE of revenue by month, not
// whatever the router thinks "revenue by month" is.
//
// A slash command is the reader saying so. It names the artifact kind
// up front, so the pipeline does not classify: it composes.
//
// ══ WHAT THIS MODULE IS AND IS NOT ═════════════════════════════════════
//
// Pure. No React, no i18n, no fetch, no storage, no clock. Same
// discipline as `capsuleRouter` and `capsuleSuggestions`, and for the
// same reason: it makes the unit gate assert BEHAVIOUR instead of
// snapshotting a render, and it keeps a keystroke-path module off the
// network.
//
// It does not decide whether a command SPENDS. That is the caller's
// boundary (`useCanvas`), and it reads `generative` here: `/explain`
// needs a model to compose a sentence; `/table` and `/chart` are the
// engine's own facts arranged, and `/export` is a download. A command
// that does not need the model must never reach it, which is the same
// rule Tier 0 lives by one layer up.

import type { CanvasArtifactKind } from "@/lib/canvasThread";

export interface CanvasSlashCommand {
  /** The word after the slash, lowercase. Also the i18n leaf. */
  id: string;
  /** Which artifact slot the entry fills. */
  artifact: CanvasArtifactKind;
  labelKey: string;
  hintKey: string;
  /**
   * True when the command is meaningless without a subject —
   * "/chart" alone has nothing to chart. A command missing its subject
   * is NOT an error: the surface shows the hint and waits.
   */
  needsSubject: boolean;
  /**
   * True when producing this artifact requires the model to COMPOSE
   * (prose, a narrative, a rationale). False when the artifact is the
   * engine's own facts arranged — those cost nothing and must not reach
   * a paid seam.
   */
  generative: boolean;
}

/** The registry. Data, not branches — adding a command is a line here
 *  plus a string pair, exactly like `CAPSULE_ROUTES`. */
export const CANVAS_SLASH_COMMANDS: readonly CanvasSlashCommand[] = Object.freeze([
  {
    id: "chart",
    artifact: "chart",
    labelKey: "canvas.slash.chart.label",
    hintKey: "canvas.slash.chart.hint",
    needsSubject: true,
    generative: false,
  },
  {
    id: "table",
    artifact: "table",
    labelKey: "canvas.slash.table.label",
    hintKey: "canvas.slash.table.hint",
    needsSubject: true,
    generative: false,
  },
  {
    id: "compare",
    artifact: "comparison",
    labelKey: "canvas.slash.compare.label",
    hintKey: "canvas.slash.compare.hint",
    needsSubject: true,
    generative: false,
  },
  {
    id: "scenario",
    artifact: "scenario",
    labelKey: "canvas.slash.scenario.label",
    hintKey: "canvas.slash.scenario.hint",
    needsSubject: true,
    generative: false,
  },
  {
    id: "export",
    artifact: "export",
    labelKey: "canvas.slash.export.label",
    hintKey: "canvas.slash.export.hint",
    needsSubject: false,
    generative: false,
  },
  {
    id: "explain",
    artifact: "explain",
    labelKey: "canvas.slash.explain.label",
    hintKey: "canvas.slash.explain.hint",
    needsSubject: true,
    generative: true,
  },
]);

export interface CanvasSlashParse {
  command: CanvasSlashCommand;
  /** Everything after the command word, trimmed. May be empty. */
  subject: string;
  /** True when the command has everything it needs to run. */
  ready: boolean;
}

const SLASH_RE = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i;

/**
 * Parse an input as a slash command.
 *
 * Returns null for anything that is not one — including `/` alone and
 * `/nosuchcommand`, both of which must fall through to ordinary routing
 * rather than becoming an error state. A reader who types "/" is opening
 * the menu, not making a mistake.
 */
export function parseCanvasSlash(input: string): CanvasSlashParse | null {
  const raw = (input ?? "").trim();
  const m = SLASH_RE.exec(raw);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const command = CANVAS_SLASH_COMMANDS.find((c) => c.id === word);
  if (!command) return null;
  const subject = (m[2] ?? "").trim();
  return {
    command,
    subject,
    ready: !command.needsSubject || subject.length > 0,
  };
}

/**
 * The menu, for an input that STARTS with a slash.
 *
 * `"/"` lists everything; `"/ch"` narrows by prefix; a complete command
 * with a subject lists nothing (the reader is past the menu). Returns an
 * empty array for input that is not slash-shaped at all, so the caller
 * can render `list.length > 0` without a second predicate.
 */
export function canvasSlashMenu(input: string): readonly CanvasSlashCommand[] {
  const raw = (input ?? "").trimStart();
  if (!raw.startsWith("/")) return [];
  const rest = raw.slice(1);
  // A space means the reader has committed to a command word; the menu
  // is done regardless of whether the word is real.
  if (/\s/.test(rest)) return [];
  const prefix = rest.toLowerCase();
  return CANVAS_SLASH_COMMANDS.filter((c) => c.id.startsWith(prefix));
}

/** The question a slash command asks, once its subject is filled in.
 *  Used as the entry's stored `question` so the rail reads as prose
 *  rather than as syntax. */
export function slashQuestion(parse: CanvasSlashParse): string {
  return parse.subject || `/${parse.command.id}`;
}
