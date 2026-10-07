// The upload portal's file seal — the PC's half (the phone's half is the
// inline script of public/phone-upload.html; keep the two in step, the
// round-trip test in __tests__/seal.test.ts holds them together).
//
// Ported from DocVex's lib/phoneUploadCrypto, simplified to one AES-GCM
// operation per file (the cloud route caps a file at 50 MB):
//
//   sealed  = "CFOP" | 0x01 | iv (12 bytes) | AES-256-GCM(plain)
//   plain   = u32 BE header length | header JSON { name, type, size } | bytes
//   AAD     = "cfoai-phone-upload:v1:" + token   (binds a file to its portal)
//
// The key is 32 random bytes made on the PC and carried ONLY in the QR code's
// URL fragment (never sent to cfo-ai.io, Supabase or the engine). A file that
// fails its tag — tampered, from another portal, or truncated — never opens.

export const SEALED_MIME = "application/x-cfoai-sealed";
const MAGIC = [0x43, 0x46, 0x4f, 0x50];
const AAD_PREFIX = "cfoai-phone-upload:v1:";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A new 256-bit key, base64url (43 characters). */
export function newSealKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isSealKey(k: unknown): k is string {
  return typeof k === "string" && /^[A-Za-z0-9_-]{43}$/.test(k);
}

export function looksSealed(data: Uint8Array): boolean {
  return data.length > 17 && MAGIC.every((b, i) => data[i] === b) && data[4] === 1;
}

const aad = (token: string) => new TextEncoder().encode(AAD_PREFIX + token);

async function importKey(key: string, use: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64url(key), { name: "AES-GCM" }, false, [use]);
}

export interface Opened {
  name: string;
  type: string;
  data: Uint8Array;
}

/** Open a sealed file. Throws when the tag, the format or the portal is wrong. */
export async function unseal(sealed: Uint8Array, key: string, token: string): Promise<Opened> {
  if (!looksSealed(sealed)) throw new Error("not_sealed");
  const iv = sealed.slice(5, 17);
  const ct = sealed.slice(17);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(token) }, await importKey(key, "decrypt"), ct),
  );
  const len = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
  if (len > plain.length - 4) throw new Error("bad_header");
  const hdr = JSON.parse(new TextDecoder().decode(plain.slice(4, 4 + len))) as { name?: string; type?: string };
  return { name: String(hdr.name || "file").slice(0, 200), type: String(hdr.type || ""), data: plain.slice(4 + len) };
}

/** The phone's half, in TypeScript — used by the tests to prove the round trip. */
export async function seal(file: { name: string; type: string; data: Uint8Array }, key: string, token: string): Promise<Uint8Array> {
  const hdr = new TextEncoder().encode(JSON.stringify({ name: file.name, type: file.type, size: file.data.length }));
  const plain = new Uint8Array(4 + hdr.length + file.data.length);
  new DataView(plain.buffer).setUint32(0, hdr.length);
  plain.set(hdr, 4);
  plain.set(file.data, 4 + hdr.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(token) }, await importKey(key, "encrypt"), plain),
  );
  const out = new Uint8Array(17 + ct.length);
  out.set(MAGIC, 0);
  out[4] = 1;
  out.set(iv, 5);
  out.set(ct, 17);
  return out;
}
