// THE CANVAS — i18n bundle, bridge-registered.
//
// Same pattern as `instrument/shell/shellI18n.ts`: strings register at
// module load via `addResourceBundle` with overwrite=false, so if the
// locale-file owners later merge these keys into `i18n/locales/{en,ro}.json`
// this becomes a no-op. Everything lives under the `canvas` top-level
// key. Romanian is informal (tu-form) with full diacritics, matching the
// rest of ro.json.

import i18n from "@/i18n";
import strings from "./canvasStrings.json";

i18n.addResourceBundle("en", "translation", { canvas: strings.en.canvas }, true, false);
i18n.addResourceBundle("ro", "translation", { canvas: strings.ro.canvas }, true, false);

/** Artifact-kind → i18n key for the card title. One table so a card and
 *  a pin cannot disagree about what a "compare" is called. */
export const CANVAS_ARTIFACT_TITLE_KEY: Readonly<Record<string, string>> = Object.freeze({
  figures: "canvas.artifact.figures",
  chart: "canvas.artifact.chart",
  table: "canvas.artifact.table",
  comparison: "canvas.artifact.compare",
  scenario: "canvas.artifact.scenario",
  export: "canvas.artifact.export",
  explain: "canvas.artifact.explain",
});
