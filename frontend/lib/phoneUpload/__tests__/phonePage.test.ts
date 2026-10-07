// The upload portal's PHONE page exists twice — served by the engine for the
// local-network route and by the site for the cloud route. They must be the
// same file, and the page must seal in the format lib/phoneUpload/seal.ts
// opens. It must also stay out of the frontend source tree: a file input
// there would red gate G5 (the one upload component).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const engineCopy = readFileSync(resolve(ROOT, "src/engine/api/phone_upload_page.html"), "utf8");
const siteCopy = readFileSync(resolve(ROOT, "public/phone-upload.html"), "utf8");
const sealSrc = readFileSync(resolve(ROOT, "frontend/lib/phoneUpload/seal.ts"), "utf8");

describe("phone upload page", () => {
  it("is one file in two places", () => {
    expect(siteCopy).toBe(engineCopy);
  });

  it("seals with the PC's magic, version and AAD prefix", () => {
    expect(engineCopy).toContain("var MAGIC = [0x43, 0x46, 0x4f, 0x50];");
    expect(sealSrc).toContain("const MAGIC = [0x43, 0x46, 0x4f, 0x50];");
    expect(engineCopy).toContain('var AAD_PREFIX = "cfoai-phone-upload:v1:";');
    expect(sealSrc).toContain('const AAD_PREFIX = "cfoai-phone-upload:v1:";');
    expect(engineCopy).toContain("out[4] = 1;");
  });

  it("reads its secrets from the fragment and clears the address bar", () => {
    expect(engineCopy).toContain('location.hash.replace(/^#/, "")');
    expect(engineCopy).toContain("history.replaceState");
  });

  it("loads nothing from elsewhere", () => {
    expect(engineCopy).toMatch(/default-src 'none'/);
    expect(engineCopy).not.toMatch(/<script[^>]+src=/);
    expect(engineCopy).not.toMatch(/<link[^>]+stylesheet/);
  });
});
