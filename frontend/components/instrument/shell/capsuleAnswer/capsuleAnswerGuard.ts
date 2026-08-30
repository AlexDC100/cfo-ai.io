// THE CAPSULE — THE NUMERAL GUARD.
//
// THE INVARIANT: the model never emits a numeral. Every figure it cites
// is a placeholder naming a fact the retrieval step actually returned;
// the placeholder is resolved by `NarrativeText` / `<Amount>`, which own
// currency, locale, magnitude and provenance. A digit that reaches the
// DOM through model prose has bypassed all four.
//
// This module is the enforcement point, and it is deliberately a PARSER,
// not a prompt. The prompt asks; this refuses. The pipeline is:
//
//     guard(text) -> ok        → render
//     guard(text) -> violation → regenerate ONCE with the violation
//                                quoted back
//     still violating          → discard the prose entirely and render a
//                                deterministic answer built from facts
//
// ── Why "no digits at all" is not the rule ────────────────────────────
//
// "Dec 2025", "account 461", "TLV" — a correct answer has to be able to
// say these. So the rule is not "no digits", it is:
//
//     a digit may appear ONLY inside a placeholder, or inside a literal
//     the EVIDENCE itself supplied.
//
// The literal allowlist is data the retrieval step returned (period
// labels, account codes, row ids, scopes) plus the user's own question.
// It is never a pattern like "small numbers are fine" — that heuristic
// is how a magnitude gets mistaken for a year, and it is exactly the
// class of guess this codebase spent the 461 fix removing.

/** Mirrors `narrativeMoney.tsx`'s PLACEHOLDER_RX — the renderer and the
 *  guard must agree on what a placeholder IS, or the guard passes text
 *  the renderer will not resolve. Kept as a literal copy rather than an
 *  import because `narrativeMoney` does not export it; a drift here is
 *  caught by `capsuleAnswerGuard.test.ts`, which round-trips a guarded
 *  string through `parseNarrativeTemplate`. */
export const PLACEHOLDER_RE =
  /\{\{(money|fact|ratio|percent|days|count|score):([A-Za-z0-9_]+)((?:\|[a-z0-9]+)*)\}\}/g;

/** Anything that LOOKS like an attempted placeholder. Used only to give a
 *  regeneration a precise complaint ("you wrote {{money:cash_flow}} and
 *  there is no such fact") instead of a generic one. */
const LOOSE_PLACEHOLDER_RE = /\{\{[^{}]{0,80}\}\}/g;

const DIGIT_RE = /\d/;

export type GuardViolationKind =
  | "numeral"
  | "unknown_fact"
  | "unit_mismatch"
  | "malformed_placeholder"
  | "empty";

export interface GuardViolation {
  kind: GuardViolationKind;
  /** The offending fragment, verbatim — this is what gets quoted back to
   *  the model on the single regeneration. */
  sample: string;
}

export interface GuardInput {
  facts: Record<string, number>;
  factUnits: Record<string, string>;
  /** Digit-bearing strings the answer may reproduce verbatim. */
  literals: readonly string[];
}

export interface GuardResult {
  ok: boolean;
  violations: GuardViolation[];
  /** Facts the answer actually cites, in first-appearance order. */
  citedFacts: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Blank out every allowed literal occurrence, longest first so a short
 *  literal cannot shadow a longer one it is a prefix of. */
function maskLiterals(text: string, literals: readonly string[]): string {
  let out = text;
  const ordered = [...literals]
    .filter((l) => l && DIGIT_RE.test(l))
    .sort((a, b) => b.length - a.length);
  for (const literal of ordered) {
    out = out.replace(new RegExp(escapeRe(literal), "gi"), (m) => " ".repeat(m.length));
  }
  return out;
}

/** The digit run around `index`, with a little context, for the
 *  regeneration complaint. */
function digitContext(text: string, index: number): string {
  const start = Math.max(0, index - 18);
  const end = Math.min(text.length, index + 18);
  return text.slice(start, end).trim();
}

/**
 * Check one model answer against the evidence it was given.
 *
 * Pure and synchronous — the pipeline calls it, the tests call it, and
 * the deterministic fallback is chosen on its output alone.
 */
export function guardAnswer(text: string, input: GuardInput): GuardResult {
  const violations: GuardViolation[] = [];
  const citedFacts: string[] = [];
  const body = (text ?? "").trim();

  if (!body) {
    return { ok: false, violations: [{ kind: "empty", sample: "" }], citedFacts };
  }

  // 1. Placeholders: every one must name a retrieved fact, and the token
  //    must agree with the unit the ENGINE declared for it.
  const wellFormed: string[] = [];
  let m: RegExpExecArray | null;
  const rx = new RegExp(PLACEHOLDER_RE.source, "g");
  while ((m = rx.exec(body)) !== null) {
    const [full, token, fact] = m;
    wellFormed.push(full);
    const declared = input.factUnits[fact];
    const known = Object.prototype.hasOwnProperty.call(input.facts, fact);
    if (!known || !declared) {
      violations.push({ kind: "unknown_fact", sample: full });
      continue;
    }
    if (token === "money" && declared !== "money") {
      violations.push({ kind: "unit_mismatch", sample: full });
      continue;
    }
    if (token !== "money" && token !== "fact" && declared !== token) {
      violations.push({ kind: "unit_mismatch", sample: full });
      continue;
    }
    if (token === "fact" && declared === undefined) {
      violations.push({ kind: "unknown_fact", sample: full });
      continue;
    }
    if (!citedFacts.includes(fact)) citedFacts.push(fact);
  }

  // 2. A near-miss placeholder ("{{ money : cash }}", "{{revenue}}") is
  //    its own violation: left alone it would render as literal braces.
  const loose = body.match(LOOSE_PLACEHOLDER_RE) ?? [];
  for (const candidate of loose) {
    if (wellFormed.includes(candidate)) continue;
    violations.push({ kind: "malformed_placeholder", sample: candidate });
  }

  // 3. Numerals. Strip every placeholder, then every allowed literal;
  //    a digit that survives both is a figure the model invented.
  let residual = body.replace(new RegExp(PLACEHOLDER_RE.source, "g"), " ");
  residual = residual.replace(LOOSE_PLACEHOLDER_RE, " ");
  residual = maskLiterals(residual, input.literals);
  const digit = residual.search(DIGIT_RE);
  if (digit >= 0) {
    violations.push({ kind: "numeral", sample: digitContext(residual, digit) });
  }

  return { ok: violations.length === 0, violations, citedFacts };
}

/** The complaint handed to the single regeneration. Quotes the offending
 *  fragments so the retry is corrective rather than hopeful. */
export function violationBrief(violations: readonly GuardViolation[]): string {
  const lines = violations.slice(0, 6).map((v) => {
    switch (v.kind) {
      case "numeral":
        return `· You wrote a numeral: "${v.sample}". Replace it with the placeholder for the fact it refers to, or drop the claim.`;
      case "unknown_fact":
        return `· "${v.sample}" names a fact that was not retrieved. Only the FACTS listed may be named.`;
      case "unit_mismatch":
        return `· "${v.sample}" uses the wrong token for that fact's declared unit.`;
      case "malformed_placeholder":
        return `· "${v.sample}" is not a valid placeholder. The exact form is {{money:fact_name}} or {{fact:fact_name}}.`;
      default:
        return "· The answer was empty.";
    }
  });
  return lines.join("\n");
}

// ── splitting an accepted answer into renderable blocks ───────────────

export type AnswerBlockKind = "para" | "bullet";

export interface AnswerBlock {
  kind: AnswerBlockKind;
  /** The template string, placeholders intact. Rendered by
   *  `NarrativeText` with the evidence's facts + declared units. */
  template: string;
}

/**
 * Split guarded prose into blocks. Deliberately minimal — paragraphs and
 * single-level bullets, nothing else. The surface is four lines tall; a
 * markdown renderer here would be a second, competing text pipeline
 * beside `NarrativeText`, and figures would eventually flow through the
 * wrong one.
 */
export function toBlocks(text: string): AnswerBlock[] {
  const out: AnswerBlock[] = [];
  const lines = (text ?? "").replace(/\r/g, "").split("\n");
  let para: string[] = [];
  const flush = () => {
    const joined = para.join(" ").trim();
    if (joined) out.push({ kind: "para", template: joined });
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const bullet = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      out.push({ kind: "bullet", template: bullet[2].trim() });
      continue;
    }
    // Strip markdown headings and bold markers — this surface has one
    // type scale and the panel supplies its own hierarchy.
    para.push(line.replace(/^#{1,6}\s+/, "").replace(/\*\*/g, ""));
  }
  flush();
  return out;
}
