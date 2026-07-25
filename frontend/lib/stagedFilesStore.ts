// stagedFilesStore — keeps dropzone-staged File objects alive across tab
// switches (operator-reported 2026-07-25: files selected in the dashboard/
// products dropzone vanished after navigating away and back).
//
// Staged files are raw `File` handles, so they can't be serialised to
// localStorage — this is a plain module-level map, which survives SPA route
// swaps (the page component unmounts but the module doesn't) and is simply
// empty again after a full reload, matching the pre-upload nature of the
// staging area. Keyed by surface ("dashboard" / "products") so the two
// dropzones don't leak files into each other.

const staged = new Map<string, File[]>();

export function readStagedFiles(scope: string): File[] {
  return staged.get(scope) ?? [];
}

export function writeStagedFiles(scope: string, files: File[]): void {
  if (files.length > 0) staged.set(scope, files);
  else staged.delete(scope);
}
