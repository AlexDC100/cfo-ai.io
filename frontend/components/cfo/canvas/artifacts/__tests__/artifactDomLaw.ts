// THE DOM LAW, for artifacts.
//
// Every digit that reaches the DOM must sit inside an element that names
// where it came from. This is the same law `capsuleGates.test.ts`
// applies to Capsule prose, moved onto rendered artifacts.
//
// ── Why this is a copy, and how the copy is kept honest ──────────────
//
// The Capsule version lives INSIDE a `.test.ts` file and is exported
// from there. Importing it would register that file's entire `describe`
// tree inside this suite — the tests would run twice and every per-file
// count `check_vitest.mjs` records would be wrong. So the attribute list
// is duplicated here, and `artifactGates.test.tsx` reads the Capsule
// file AS TEXT and fails when the two lists diverge. A silent copy is a
// drift; a copy with a drift alarm is a boundary.
//
// The digit detection is deliberately simpler than the Capsule
// version's: an artifact renders LABELS and FIGURES, never sentences,
// so there is no prose to strip and no allowlist to maintain. Anything
// digit-bearing in an artifact is a figure or a period label, and both
// must be attributed.

/** Attributes that make a rendered figure TRACEABLE. Kept byte-identical
 *  to `capsuleGates.test.ts`'s `PROVENANCE_ATTRS` — see the drift gate. */
export const PROVENANCE_ATTRS = [
  "data-narrative-money",
  "data-traceable-source-statement",
  "data-provenance",
  "data-fact",
];

function attributed(node: Element | null, root: Element): boolean {
  let el: Element | null = node;
  while (el) {
    for (const attr of PROVENANCE_ATTRS) {
      if (el.hasAttribute(attr)) return true;
    }
    if (el === root) return false;
    el = el.parentElement;
  }
  return false;
}

export interface UnattributedFigure {
  text: string;
  digits: string;
}

/** Digit runs, ignoring digits glued to letters (identifiers like `v1`,
 *  `rId2`, `sha256`) — those are names, not quantities. */
const DIGIT_RUN = /(?<![A-Za-z_])\d[\d.,  ]*\d|(?<![A-Za-z_])\d(?![A-Za-z_])/g;

export function digitsIn(text: string, allowed: readonly string[]): string[] {
  let masked = text;
  for (const literal of [...allowed].sort((a, b) => b.length - a.length)) {
    if (!literal || !/\d/.test(literal)) continue;
    masked = masked.split(literal).join(" ".repeat(literal.length));
  }
  const out: string[] = [];
  DIGIT_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIGIT_RUN.exec(masked)) !== null) out.push(m[0]);
  return out;
}

/**
 * Walk `root` and return every text node carrying a digit that is NOT
 * inside an attributed element.
 *
 * `allowed` is the evidence's own literal list — period labels, account
 * codes, tickers. It is DATA the retrieval returned, never a pattern
 * like "small numbers are fine": that heuristic is how a magnitude gets
 * mistaken for a year.
 */
export function unattributedFigures(
  root: HTMLElement,
  allowed: readonly string[] = [],
): UnattributedFigure[] {
  const out: UnattributedFigure[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    const digits = digitsIn(text, allowed);
    if (digits.length > 0 && !attributed(node.parentElement, root)) {
      out.push({ text, digits: digits.join("|") });
    }
    node = walker.nextNode();
  }
  return out;
}

/** How many ATTRIBUTED figures a render produced. A DOM law that finds
 *  no offenders on a render that produced no figures has examined
 *  nothing — this is the number the gate compares against (TC-9).
 *
 *  Counts every attribute in the law, not just `data-fact`: a document
 *  artifact's figures come out of `NarrativeText`, which marks them
 *  `data-narrative-money`. Counting one attribute would have reported
 *  ZERO examined figures for a document that rendered several, which is
 *  the same false-negative the law itself exists to prevent. */
export function attributedFigureCount(root: HTMLElement): number {
  const selector = PROVENANCE_ATTRS.map((a) => `[${a}]`).join(",");
  return root.querySelectorAll(selector).length;
}
