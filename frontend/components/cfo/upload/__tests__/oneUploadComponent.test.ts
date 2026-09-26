// GATE G5 — exactly one upload component (workspace redesign, 2026-09-21).
//
// Owner rule: "delete every other upload control; exactly one upload
// component in the codebase". Upload paths had multiplied — the dashboard
// hero, "Add month", the source line's Replace, the workspace wizard, the
// periods list's Add period / attach / replace — each with its own file
// input, its own drop handlers and its own idea of where the file goes.
//
// Scope (printed): every .ts/.tsx under frontend/ except tests.
//
// Fails on, after the redesign landed:
//   · a file input, a drop handler, a drop listener or a read of dropped
//     files in ANY module but components/cfo/upload/UploadDrop.tsx;
//   · a module building a picker or drop target from the primitives that is
//     not declared (with its reason) in UPLOAD_PRIMITIVE_CONSUMERS — and a
//     declared one that no longer uses them (the list must stay true);
//   · the confirmation-card flow started from anywhere but the component;
//   · a "redesign_off" consumer that is no longer switched off by the flag.
// Plant-proven below: a second component, a stray drop handler and an
// undeclared consumer each turn it red.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { UPLOAD_PRIMITIVE_CONSUMERS } from "@/components/cfo/upload/UploadDrop";

const FE = resolve(__dirname, "../../../..");
const THE_COMPONENT = "components/cfo/upload/UploadDrop.tsx";
const FLOW_STORE = "lib/uploadFlow.ts";

interface SourceFile {
  path: string;
  text: string;
}

const RAW_AFFORDANCES: Array<[string, RegExp]> = [
  ["file input", /\btype\s*=\s*\{?\s*["'`]file["'`]/],
  ["file input (DOM)", /\.type\s*=\s*["'`]file["'`]|setAttribute\(\s*["'`]type["'`]\s*,\s*["'`]file["'`]/],
  ["drop handler", /\bon(Drop|DragOver|DragEnter)\s*=/],
  ["drop listener", /addEventListener\(\s*["'`](drop|dragover|dragenter)["'`]|\.ondrop\s*=/],
  ["dropped files", /dataTransfer\s*\??\.\s*files/],
  ["picker library", /useDropzone|react-dropzone|showOpenFilePicker/],
];
const PRIMITIVE_USE = /\b(FilePickerInput|fileDropProps)\b/;
const FLOW_ENTRY = /\bstartUploadFlow\s*\(/;

/** Comments may DESCRIBE an input; only code counts. Line comments are cut
 *  only when `//` is not part of a URL (`https://`). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function sources(): SourceFile[] {
  const out: SourceFile[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name === "dist" || name === "test") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
        out.push({ path: relative(FE, p).split(sep).join("/"), text: readFileSync(p, "utf8") });
      }
    }
  })(FE);
  return out;
}

export function auditUploadAffordances(files: SourceFile[]) {
  const raw: Array<{ path: string; kind: string }> = [];
  const consumers = new Set<string>();
  const flowEntries = new Set<string>();
  for (const f of files) {
    const code = stripComments(f.text);
    for (const [kind, re] of RAW_AFFORDANCES) if (re.test(code)) raw.push({ path: f.path, kind });
    if (f.path !== THE_COMPONENT && PRIMITIVE_USE.test(code)) consumers.add(f.path);
    // A CALL, not the definition.
    if (FLOW_ENTRY.test(code.replace(/function\s+startUploadFlow\s*\(/g, ""))) flowEntries.add(f.path);
  }
  return {
    components: [...new Set(raw.map((r) => r.path))].sort(),
    raw,
    consumers: [...consumers].sort(),
    flowEntries: [...flowEntries].sort(),
  };
}

/** Throws on any violation — the plants below expect it to. */
export function assertOneUploadComponent(files: SourceFile[]): void {
  const a = auditUploadAffordances(files);
  if (a.components.length !== 1 || a.components[0] !== THE_COMPONENT) {
    throw new Error(
      `upload affordances outside ${THE_COMPONENT}: ` +
        JSON.stringify(a.raw.filter((r) => r.path !== THE_COMPONENT)),
    );
  }
  const declared = Object.keys(UPLOAD_PRIMITIVE_CONSUMERS).sort();
  const undeclared = a.consumers.filter((c) => !declared.includes(c));
  if (undeclared.length) throw new Error(`undeclared upload primitive consumers: ${undeclared.join(", ")}`);
  const stale = declared.filter((c) => !a.consumers.includes(c));
  if (stale.length) throw new Error(`declared consumers that no longer use the primitives: ${stale.join(", ")}`);
  const strayEntries = a.flowEntries.filter((p) => p !== THE_COMPONENT && p !== FLOW_STORE);
  if (strayEntries.length) throw new Error(`upload flow started outside the component: ${strayEntries.join(", ")}`);
}

const byPath = (files: SourceFile[], path: string) => files.find((f) => f.path === path)?.text ?? "";

describe("G5 — one upload component", () => {
  const files = sources();

  it("the real tree has exactly one module owning file inputs and drop handling", () => {
    const a = auditUploadAffordances(files);
    console.info(
      `[G5] ${files.length} files scanned · owner ${a.components.join(", ")} · ` +
        `${a.consumers.length} declared primitive consumers · flow entries ${a.flowEntries.join(", ")}`,
    );
    expect(files.length).toBeGreaterThan(300);
    // Non-vacuity: the component itself carries every kind the gate hunts.
    const kinds = new Set(a.raw.filter((r) => r.path === THE_COMPONENT).map((r) => r.kind));
    expect([...kinds].sort()).toEqual(["drop handler", "drop listener", "dropped files", "file input"].sort());
    expect(() => assertOneUploadComponent(files)).not.toThrow();
  });

  it("every redesign_off consumer is actually switched off by workspace_v2", () => {
    const off = Object.entries(UPLOAD_PRIMITIVE_CONSUMERS)
      .filter(([, why]) => why === "redesign_off")
      .map(([p]) => p)
      .sort();
    expect(off).toEqual([
      "components/cfo/workspace/PeriodsSection.tsx",
      "pages/cfo/FinancialStatements.tsx",
      "pages/cfo/Workspace.tsx",
    ]);
    // The dashboard reads the flag itself and mounts no picker with it on.
    const dash = byPath(files, "pages/cfo/FinancialStatements.tsx");
    expect(dash).toMatch(/const workspaceV2 = useWorkspaceV2\(\)/);
    expect(dash).toMatch(/\{!workspaceV2 && \(\s*<FilePickerInput/);
    expect(dash).toMatch(/\{!workspaceV2 && \(\s*<DashboardSourceFiles/);
    // The current workspace page is routed only in the flag-off branch.
    const app = byPath(files, "App.tsx");
    expect(app).toMatch(/enabled \? <WorkspaceHomeV2 \/> : <Workspace \/>/);
    expect(app.match(/<Workspace \/>/g)?.length).toBe(1);
    // The periods list (Add period / attach / replace) is reachable only
    // through the current workspace page's settings.
    const importers = files
      .filter((f) => /from ["']\.\/PeriodsSection["']|from ["']@\/components\/cfo\/workspace\/PeriodsSection["']/.test(f.text))
      .map((f) => f.path);
    expect(importers).toEqual(["components/cfo/workspace/WorkspaceSettingsV2.tsx"]);
    const renderers = files.filter((f) => /<WorkspaceSettingsV2\b/.test(stripComments(f.text))).map((f) => f.path);
    expect(renderers).toEqual(["pages/cfo/Workspace.tsx"]);
  });

  it("PLANT: a second component with its own file input turns the gate red", () => {
    const planted = [
      ...files,
      { path: "components/cfo/PlantedUpload.tsx", text: 'export const X = () => <input type="file" onChange={f} />;' },
    ];
    expect(() => assertOneUploadComponent(planted)).toThrow(/outside components\/cfo\/upload\/UploadDrop\.tsx/);
  });

  it("PLANT: a stray drop handler turns the gate red", () => {
    const planted = [
      ...files,
      {
        path: "pages/cfo/PlantedPage.tsx",
        text: "export const P = () => <div onDrop={(e) => take(e.dataTransfer.files)} />;",
      },
    ];
    expect(() => assertOneUploadComponent(planted)).toThrow(/PlantedPage/);
  });

  it("PLANT: an undeclared primitive consumer turns the gate red", () => {
    const planted = [
      ...files,
      {
        path: "components/cfo/PlantedPicker.tsx",
        text: 'import { FilePickerInput } from "@/components/cfo/upload/UploadDrop";\nexport const Q = () => <FilePickerInput />;',
      },
    ];
    expect(() => assertOneUploadComponent(planted)).toThrow(/undeclared upload primitive consumers: components\/cfo\/PlantedPicker\.tsx/);
  });

  it("PLANT: starting the upload flow from another module turns the gate red", () => {
    const planted = [
      ...files,
      { path: "components/cfo/PlantedEntry.tsx", text: "void startUploadFlow(files, orgId);" },
    ];
    expect(() => assertOneUploadComponent(planted)).toThrow(/upload flow started outside the component/);
  });

  it("a comment that merely DESCRIBES an input is not an affordance", () => {
    const withComment = [...files, { path: "lib/doc.ts", text: '// the old <input type="file"> lived here\n/* onDrop={x} */\nexport {};' }];
    expect(() => assertOneUploadComponent(withComment)).not.toThrow();
  });
});
