// THE PDF, RENDERED THE WAY A CUSTOMER GETS IT.
//
// `exportBooks.ts` hands the gates the printed HTML and the workbook.
// This is its third half: the PDF, produced by the SAME renderer the
// product ships — `services/pdf/render.mjs`, the sidecar service — so a
// gate reading these bytes is reading the artefact, not a re-creation of
// it. Rendering the report here with a second, gate-local Chromium
// configuration would prove that a document like this one prints; it
// would prove nothing about the one the customer opens, and the two would
// drift the first time the service changed a page option.
//
// The import is dynamic, by absolute path, for two reasons. The service
// is plain ESM outside `tsconfig`'s program, so a static import would be
// a type error in `check_tsc.mjs` for the whole repo; and if the module
// is ever moved or renamed, this throws a sentence naming the path it
// looked for, instead of a gate quietly skipping.
//
// ── COST ──────────────────────────────────────────────────────────────
//
// One Chromium process for the whole file, launched on the first render
// and closed in `afterAll`. Measured 2026-09-08 on this machine: the four
// committed books render in 635 / 401 / 380 / 419 ms — the first carries
// the browser launch — for 1.8 s of a 2.9 s file. That is the price of
// asserting over real PDF bytes, and it is why the renders are memoised
// per (book, html) inside one process rather than taken per assertion:
// the gate makes 52 assertions over 4 renders, not 52 renders.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { extractPdfText, type PdfDocText } from "./pdfText";

const repoRoot = resolve(__dirname, "../../..");
const RENDERER = resolve(repoRoot, "services/pdf/render.mjs");

interface RenderResult {
  bytes: Buffer;
  pages: number;
  dateFieldsNormalised: number;
}

interface RendererModule {
  renderPdf: (html: string, opts?: { timeoutMs?: number }) => Promise<RenderResult>;
  closeBrowser: () => Promise<void>;
}

let rendererPromise: Promise<RendererModule> | null = null;

async function renderer(): Promise<RendererModule> {
  if (rendererPromise === null) {
    rendererPromise = (async () => {
      try {
        readFileSync(RENDERER);
      } catch {
        throw new Error(
          `the PDF renderer is not at ${RENDERER}. This gate reads the bytes the shipped ` +
            `service produces; it has no second renderer to fall back to, and a fallback is ` +
            `exactly what would let the product and the gate drift apart.`,
        );
      }
      const mod = (await import(/* @vite-ignore */ pathToFileURL(RENDERER).href)) as Partial<RendererModule>;
      if (typeof mod.renderPdf !== "function" || typeof mod.closeBrowser !== "function") {
        throw new Error(
          `${RENDERER} no longer exports renderPdf/closeBrowser; it exports: ` +
            Object.keys(mod).join(", "),
        );
      }
      return mod as RendererModule;
    })();
  }
  return rendererPromise;
}

export interface RenderedPdf {
  readonly bytes: Uint8Array;
  /** Page count as the SERVICE counts it, from the page tree. */
  readonly pages: number;
  /** How many `/CreationDate`-shaped fields the service neutralised. */
  readonly dateFieldsNormalised: number;
  readonly text: PdfDocText;
}

const cache = new Map<string, Promise<RenderedPdf>>();

/** Render one HTML document and read its text layer back. */
export function renderedPdf(cacheKey: string, html: string): Promise<RenderedPdf> {
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const job = (async (): Promise<RenderedPdf> => {
    const mod = await renderer();
    const out = await mod.renderPdf(html);
    const bytes = new Uint8Array(out.bytes);
    return {
      bytes,
      pages: out.pages,
      dateFieldsNormalised: out.dateFieldsNormalised,
      text: extractPdfText(bytes),
    };
  })();
  cache.set(cacheKey, job);
  return job;
}

/** Shut the shared browser down. Call once, in `afterAll`. */
export async function closePdfRenderer(): Promise<void> {
  if (rendererPromise === null) return;
  const mod = await rendererPromise;
  await mod.closeBrowser();
}
