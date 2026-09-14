// RATIO PARITY CAPTURE — what `computeRatios` prints for the four firm
// books, as JSON the ENGINE's ratio table is held to.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────
//
// The engine becomes the one authority for ratio values and bands
// (`src/engine/ratios/table.py`). Before any surface switches to reading
// it, the engine's quantized value must equal what `computeRatios` prints
// today, to the printed digit, on every shared key of every committed
// book (critic rule f). Python cannot run TypeScript, so the FE half of
// that comparison is captured here and committed under
// `tests/engine/fixtures/ratio_parity/<book>.json`, and
// `tests/engine/test_ratio_table.py` compares against it.
//
// ── THE PAYLOAD ─────────────────────────────────────────────────────
//
// The served payload is the one `exportBooks.ts` already composes for
// every export gate — `statementsFor(book)` (the captured statements
// joined with the served `canonical_bs`), `metricsFor(book)` (the real
// `stage_compute` rows) and, for the `disputed` variant, `servedAs(book,
// disputes)` (the real `industry_signal` for the workspace setting the
// book's own account mix disagrees with). The Python gate composes the
// SAME three committed files the same way, so both sides read one input.
//
// The `perturbed` variant is the served payload with every served metric
// multiplied by `METRIC_PERTURBATION` (1.37). On the unperturbed books the
// metric and the division of the printed statements agree to the printed
// digit on 16 of the 21 `mOr`/`bsOr` keys, so flipping which one wins is
// invisible there; ×1.37 separates them on every key that has both, so
// the engine gate can see every precedence choice.
//
// ── MODES ───────────────────────────────────────────────────────────
//
//   CAPTURE=1 npx vitest run --root . frontend/lib/__tests__/ratioParityCapture.test.ts
//       rewrites the four JSON files.
//   (no CAPTURE)
//       writes NOTHING and asserts the committed files still equal a fresh
//       `computeRatios` run — so a change to the FE arithmetic cannot leave
//       the engine gate comparing against a stale capture.
//
// ── WHAT THIS REDS ON (TC-11) ───────────────────────────────────────
//
//   · without CAPTURE: any key, value, printed string, verdict or
//     direction in a committed capture that differs from computeRatios
//     today, or a book / variant missing from the capture;
//   · `printed` is `formatRatio(row)` with its unit suffix removed — the
//     string the report prints — so a change to the digits the FE
//     actually prints reds here, not only a change to the value;
//   · a variant that grades nothing or withholds nothing (TC-3): the
//     served variant must carry at least one graded row and the disputed
//     variant at least one `ungraded` row, or the capture proves nothing
//     about sector withholding.
//
// SCOPE (TC-13): the four firm books × {served, disputed, perturbed}; the 22 keys
// `computeRatios` emits. The Altman row is not a `computeRatios` row and
// is not captured here.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { computeRatios, formatRatio, type Ratio } from "@/lib/financialReport";
import {
  BOOKS,
  metricsFor,
  servedAs,
  statementsFor,
  workspaceKeys,
  type Book,
  type BookStatements,
} from "./exportBooks";

const OUT_DIR = resolve(__dirname, "../../../tests/engine/fixtures/ratio_parity");
const CAPTURE = process.env.CAPTURE === "1";

/** Every served metric is multiplied by this in the `perturbed` variant.
 *  `tests/engine/test_ratio_table.py` applies the same factor. */
const METRIC_PERTURBATION = 1.37;

/** The unit suffix `formatRatio` appends, removed to leave the digits. */
const SUFFIX: Record<Ratio["unit"], string> = { x: "×", "%": "%", days: " days", ratio: "" };

function printedDigits(row: Ratio): string | null {
  if (row.value === null) return null;
  const text = formatRatio(row);
  const suffix = SUFFIX[row.unit];
  if (!text.endsWith(suffix)) {
    throw new Error(`formatRatio(${row.key}) printed ${JSON.stringify(text)}, expected a ${JSON.stringify(suffix)} suffix`);
  }
  return suffix === "" ? text : text.slice(0, -suffix.length);
}

function perturbed(metrics: Record<string, number | null>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(metrics)) out[k] = v === null ? null : v * METRIC_PERTURBATION;
  return out;
}

interface CapturedRow {
  value: number | null;
  printed: string | null;
  unit: Ratio["unit"];
  verdict: Ratio["verdict"];
  higher_is_better: boolean | null;
  /** The ladder the verdict was decided by, in the row's unit — null when
   *  no ladder was applied (refused or ungraded). */
  ladder: { critical?: number; watch?: number; healthy?: number; strong?: number } | null;
  absence: Ratio["unavailable"] | null;
}

function capturedRows(s: BookStatements, metrics: Record<string, number | null>): Record<string, CapturedRow> {
  const r = computeRatios(s, undefined, metrics);
  const out: Record<string, CapturedRow> = {};
  for (const row of [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency].flat()) {
    out[row.key] = {
      value: row.value,
      printed: printedDigits(row),
      unit: row.unit,
      verdict: row.verdict,
      higher_is_better: row.ladder ? row.ladder.higherIsBetter : null,
      ladder: row.ladder ? row.ladder.bands : null,
      absence: row.unavailable ?? null,
    };
  }
  return out;
}

function captureFor(book: Book): Record<string, unknown> {
  const disputes = workspaceKeys(book).disputes;
  return {
    _provenance: {
      what: "computeRatios(statements, undefined, metricsByName) over the served payload of one firm book",
      written_by: "frontend/lib/__tests__/ratioParityCapture.test.ts (CAPTURE=1)",
      payload:
        "statements = tests/engine/fixtures/firm/saga_10_col_<book>.json .statements + .envelope.canonical_bs; " +
        "metrics = served_metrics.json[<book>]; disputed adds industry_signal.json[<book>][<disputes>]",
      printed: "formatRatio(row) with the unit suffix removed",
      perturbed: "the served variant with every served metric multiplied by METRIC_PERTURBATION = 1.37",
    },
    book,
    disputed_workspace_key: disputes,
    variants: {
      served: capturedRows(statementsFor(book), metricsFor(book)),
      disputed: capturedRows(servedAs(book, disputes), metricsFor(book)),
      perturbed: capturedRows(statementsFor(book), perturbed(metricsFor(book))),
    },
  };
}

function serialise(v: unknown): string {
  return JSON.stringify(v, null, 2) + "\n";
}

describe("ratio parity capture — computeRatios over the four served firm books", () => {
  for (const book of BOOKS) {
    it(`${book}: ${CAPTURE ? "writes" : "matches"} tests/engine/fixtures/ratio_parity/${book}.json`, () => {
      const fresh = captureFor(book);
      const variants = fresh.variants as Record<string, Record<string, CapturedRow>>;
      // TC-3 — the capture must exercise grading AND withholding.
      expect(Object.values(variants.served).some((r) => ["strong", "healthy", "watch", "critical"].includes(r.verdict))).toBe(true);
      expect(Object.values(variants.disputed).some((r) => r.verdict === "ungraded")).toBe(true);

      const path = resolve(OUT_DIR, `${book}.json`);
      if (CAPTURE) {
        if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(path, serialise(fresh), "utf-8");
        return;
      }
      expect(existsSync(path), `${path} missing — run with CAPTURE=1`).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe(serialise(fresh));
    });
  }
});
