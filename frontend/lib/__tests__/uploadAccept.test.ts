// uploadAccept — the picker offers only what a reader opens.
//
// 2026-10-02 (one upload policy): FINANCIAL_UPLOAD_ACCEPT used to list
// .pptx / .ppt and the two PowerPoint MIME types. The engine refuses a
// PowerPoint file on every branch, by name (engine/api/_upload_type
// REACHES_NO_READER), so every financial input and drop zone was inviting
// a refusal. The engine-side law (tests/engine/test_upload_real_type.py,
// "the upload picker offers no type the engine refuses by name") reads this
// module's source against the engine's own refusal set; this file pins the
// browser half: the `accept` string and the drop-zone extension list are
// ONE list, and a no-reader type is neither offered nor accepted on drop.
//
// Reds on: .ppt / .pptx / .doc / .docx / .xlsb / .ods back in either list;
// a PowerPoint MIME type in the accept string; the two lists drifting.
import { describe, expect, it } from "vitest";

import {
  FINANCIAL_UPLOAD_ACCEPT,
  FINANCIAL_UPLOAD_EXTENSIONS,
  isAcceptedFinancialUpload,
} from "@/lib/uploadAccept";

/** Extensions whose own file type the engine refuses under every name. */
const NO_READER = [".ppt", ".pptx", ".pps", ".doc", ".docx", ".docm", ".dot", ".xlsb", ".ods", ".odt", ".odp"];

describe("the financial upload picker", () => {
  const tokens = FINANCIAL_UPLOAD_ACCEPT.split(",").map((t) => t.trim()).filter(Boolean);

  it("offers no extension whose file type no reader opens", () => {
    for (const ext of NO_READER) {
      expect(tokens, `accept offers ${ext}`).not.toContain(ext);
      expect(FINANCIAL_UPLOAD_EXTENSIONS as readonly string[], `drop accepts ${ext}`).not.toContain(ext);
      expect(isAcceptedFinancialUpload(`balanta${ext}`), `balanta${ext} accepted on drop`).toBe(false);
    }
    expect(tokens.filter((t) => /powerpoint|presentation|msword|wordprocessing/i.test(t))).toEqual([]);
  });

  it("still offers every type a reader opens", () => {
    for (const name of ["balanta.pdf", "balanta.xlsx", "Balanta.XLS", "balanta.csv", "scan.jpg", "scan.jpeg", "scan.png", "foto.heic"]) {
      expect(isAcceptedFinancialUpload(name), name).toBe(true);
    }
  });

  it("the accept attribute and the drop-zone list are one list", () => {
    const offered = tokens.filter((t) => t.startsWith(".")).sort();
    expect(offered).toEqual([...FINANCIAL_UPLOAD_EXTENSIONS].sort());
  });
});
