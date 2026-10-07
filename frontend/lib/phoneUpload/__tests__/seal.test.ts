// The upload portal's seal: what the phone seals, the PC opens — and nothing
// else. The phone's half is the inline script of the phone page; this file
// holds the TypeScript twin to the same format and checks the page's
// constants against it (phonePage.test.ts holds the two page copies equal).
import { describe, expect, it } from "vitest";

import { isSealKey, looksSealed, newSealKey, seal, unseal } from "../seal";

const file = { name: "Balanta decembrie.xlsx", type: "application/vnd.ms-excel", data: new Uint8Array([1, 2, 3, 250, 0, 7]) };

describe("phone upload seal", () => {
  it("makes 256-bit base64url keys", () => {
    const k = newSealKey();
    expect(isSealKey(k)).toBe(true);
    expect(newSealKey()).not.toBe(k);
  });

  it("opens what it sealed, name and type included", async () => {
    const key = newSealKey();
    const sealed = await seal(file, key, "tok_abcdefghijklmnop");
    expect(looksSealed(sealed)).toBe(true);
    const opened = await unseal(sealed, key, "tok_abcdefghijklmnop");
    expect(opened.name).toBe(file.name);
    expect(opened.type).toBe(file.type);
    expect(Array.from(opened.data)).toEqual(Array.from(file.data));
  });

  it("refuses another key, another portal, and a flipped byte", async () => {
    const key = newSealKey();
    const sealed = await seal(file, key, "tok_abcdefghijklmnop");
    await expect(unseal(sealed, newSealKey(), "tok_abcdefghijklmnop")).rejects.toThrow();
    await expect(unseal(sealed, key, "tok_another_portal_xx")).rejects.toThrow();
    const bad = sealed.slice();
    bad[bad.length - 1] ^= 1;
    await expect(unseal(bad, key, "tok_abcdefghijklmnop")).rejects.toThrow();
    await expect(unseal(sealed.slice(0, 30), key, "tok_abcdefghijklmnop")).rejects.toThrow();
  });

  it("does not take a plain file for a sealed one", () => {
    expect(looksSealed(new TextEncoder().encode("Cont,Denumire\n101,Capital"))).toBe(false);
  });
});
