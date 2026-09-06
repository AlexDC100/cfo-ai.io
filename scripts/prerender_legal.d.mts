// Types for scripts/prerender_legal.mjs — see the sibling
// generate_legal_documents.d.mts for why the implementation stays `.mjs`.

/** Write the six legal pages into `distDir`. Returns the relative paths. */
export function prerenderLegal(distDir: string): string[];
