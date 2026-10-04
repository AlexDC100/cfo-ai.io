// GATE briefing-explicit-regenerate (the refusal half): A PLAN REFUSAL IS
// RENDERED FROM ITS CODE, PER VIEWER — never from the server's message.
//
// Owner ruling 2026-10-02: "Never write plan names into the shared
// documents.error — store a neutral code, render the message per viewer."
// The engine stores `NonRoNotIncludedError: {"error": "<code>"}`; each
// viewer's browser prints the code's sentence in that viewer's language.
//
// The expected sentences are STATED here, in English and in Romanian — not
// read back through the printer under test, and not read from the locale
// files (which a second test holds equal to them).
//
// Fails on: a known code printing the server's `message` (the planted
// `return d.message`), a plan name, the raw JSON or the bare code; a code
// without a sentence in either language; the sentence not following the
// viewer's language; "workspace" in the copy; an ordinary error being
// rewritten; a seam that stopped passing through the humanizer; the upgrade
// dialog printing a server line again.
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { DocRefusalReason } from "@/components/cfo/DocRefusalReason";
import {
  UPLOAD_REFUSAL_CODES,
  UPLOAD_REFUSAL_ENGLISH,
  documentRefusalCode,
  documentRefusalKey,
  friendlyDocumentError,
  parseUploadRefusal,
  uploadRefusalKey,
  uploadRefusalSentence,
  type UploadRefusalCode,
} from "@/lib/uploadRefusals";

// ── The law, stated: code → sentence, in each language. ────────────────
const EXPECTED: Record<UploadRefusalCode, { en: string; ro: string }> = {
  non_ro_not_included: {
    en: "This looks like a document from outside Romania. Today CFO AI reads Romanian trial balances only; other countries are not supported yet, on any plan.",
    ro: "Pare a fi un document din afara României. Astăzi CFO AI citește doar balanțe de verificare românești; alte țări nu sunt încă suportate, pe niciun plan.",
  },
  nonro_quota_exhausted: {
    en: "This company has reached this month's limit for documents from outside Romania.",
    ro: "Compania a atins limita lunii acesteia pentru documentele din afara României.",
  },
  metering_unavailable: {
    en: "We couldn't check the plan just now. Nothing was charged — try again in a few minutes.",
    ro: "Nu am putut verifica planul acum. Nu s-a taxat nimic — încearcă din nou în câteva minute.",
  },
};
const CODES = Object.keys(EXPECTED) as UploadRefusalCode[];
const LANGS = ["en", "ro"] as const;

// What the engine stores (spec D3), exactly.
const stored = (code: string) => `NonRoNotIncludedError: {"error": "${code}"}`;

// What rows written BEFORE the ruling hold: the uploader's plan, by name.
const SERVER_MESSAGES: Record<UploadRefusalCode, string> = {
  non_ro_not_included:
    "Non-Romanian documents aren't included in the RO Solo plan. Upgrade to Multi-Country to analyze documents from other jurisdictions.",
  nonro_quota_exhausted: "You've used all 8 non-RO documents included in the Multi-Country plan this month.",
  metering_unavailable: "ValueError: dictionary update sequence element #0 has length 1; 2 is required",
};
const legacyStored = (code: UploadRefusalCode) =>
  `NonRoNotIncludedError: ${JSON.stringify({
    error: code,
    upgrade_to: "multi",
    plan_key: "solo",
    message: SERVER_MESSAGES[code],
  })}`;

const PLAN_NAMES = /\b(RO Solo|Solo plan|Pro plan|Free trial|plan_key|solo|starter|intro)\b/i;
const NOT_A_COMPANY = /\b(workspaces?|workspace-ul(?:ui)?|spa[țt]i(?:u|ul|i|ile) de lucru)\b/i;

const locale = (lang: string) =>
  JSON.parse(readFileSync(resolve(__dirname, `../../i18n/locales/${lang}.json`), "utf8"));
const at = (tree: Record<string, unknown>, key: string): unknown =>
  key.split(".").reduce<unknown>(
    (node, k) => (node && typeof node === "object" ? (node as Record<string, unknown>)[k] : undefined),
    tree,
  );
const source = (rel: string) => readFileSync(resolve(__dirname, "../..", rel), "utf8");

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("the three stored codes", () => {
  it("are exactly the engine's three, each with its own i18n key", () => {
    expect([...UPLOAD_REFUSAL_CODES].sort()).toEqual([...CODES].sort());
    expect(new Set(CODES.map(uploadRefusalKey)).size).toBe(CODES.length);
  });

  for (const lang of LANGS) {
    for (const code of CODES) {
      it(`${lang}: ${code} — the stored code prints its sentence in the viewer's language`, async () => {
        await i18n.changeLanguage(lang);
        expect(friendlyDocumentError(stored(code))).toBe(EXPECTED[code][lang]);
        // every other shape the same code can arrive in
        expect(friendlyDocumentError(JSON.stringify({ error: code }))).toBe(EXPECTED[code][lang]);
        expect(friendlyDocumentError(JSON.stringify({ code }))).toBe(EXPECTED[code][lang]);
        expect(friendlyDocumentError(JSON.stringify({ detail: { error: code } }))).toBe(EXPECTED[code][lang]);
        expect(friendlyDocumentError(code)).toBe(EXPECTED[code][lang]);
        expect(friendlyDocumentError(`NonRoNotIncludedError: ${code}`)).toBe(EXPECTED[code][lang]);
        // pinned to a language whatever the active one
        expect(uploadRefusalSentence(code, lang)).toBe(EXPECTED[code][lang]);
      });

      it(`${lang}: ${code} — a row that still carries a server message never prints it`, async () => {
        await i18n.changeLanguage(lang);
        const out = friendlyDocumentError(legacyStored(code));
        expect(out).toBe(EXPECTED[code][lang]);
        expect(out).not.toContain(SERVER_MESSAGES[code]);
        expect(String(out)).not.toMatch(PLAN_NAMES);
        expect(out).not.toContain("{");
        expect(out).not.toContain(code);
        // the bare payload a pre-ruling quota refusal could be reduced to
        const bare = friendlyDocumentError(JSON.stringify({ error: code, message: SERVER_MESSAGES[code] }));
        expect(bare).toBe(EXPECTED[code][lang]);
      });
    }
  }

  it("the same row reads differently for two viewers: one stored string, two languages", async () => {
    const row = stored("nonro_quota_exhausted");
    await i18n.changeLanguage("ro");
    const romanianViewer = friendlyDocumentError(row);
    await i18n.changeLanguage("en");
    const englishViewer = friendlyDocumentError(row);
    expect(romanianViewer).toBe("Compania a atins limita lunii acesteia pentru documentele din afara României.");
    expect(englishViewer).toBe("This company has reached this month's limit for documents from outside Romania.");
  });

  it("says company, never workspace; names no person's plan; Romanian speaks to 'tu'", () => {
    for (const code of CODES) {
      for (const lang of LANGS) {
        expect(EXPECTED[code][lang], `${lang} ${code}`).not.toMatch(NOT_A_COMPANY);
        // "trial balance" is the document, not the plan: the sentence for
        // non_ro_not_included now says which documents ARE read (landing-trust,
        // 2026-10-01), so the plan-name law reads the text without that noun.
        const withoutTheDocumentNoun = EXPECTED[code][lang].replace(/\btrial balances?\b/gi, "");
        expect(withoutTheDocumentNoun, `${lang} ${code}`).not.toMatch(/\b(Solo|Pro|Starter|Intro|trial|Multi-Country)\b/);
      }
      expect(EXPECTED[code].ro).not.toMatch(/dumneavoastră|încercați|reîncercați/i);
    }
    expect(EXPECTED.metering_unavailable.ro).toContain("încearcă");
  });
});

describe("the locale files carry the stated sentences", () => {
  it.each(LANGS)("%s: every code's key holds the stated sentence", (lang) => {
    for (const code of CODES) {
      expect(at(locale(lang), uploadRefusalKey(code)), `${lang}: ${uploadRefusalKey(code)}`).toBe(EXPECTED[code][lang]);
    }
  });

  it("the fallback English (i18n not initialised) is en.json's, word for word", () => {
    expect(Object.keys(UPLOAD_REFUSAL_ENGLISH).sort()).toEqual(CODES.map(uploadRefusalKey).sort());
    for (const [key, sentence] of Object.entries(UPLOAD_REFUSAL_ENGLISH)) {
      expect(at(locale("en"), key), key).toBe(sentence);
    }
  });
});

describe("what is NOT a refusal passes through untouched", () => {
  it("ordinary errors, a sentence that merely mentions a code, an unknown code, nothing", () => {
    const ordinary = [
      "Extraction failed: bad workbook",
      "RuntimeError: compute failed",
      "Failed to fetch dynamically imported module: https://cfo-ai.io/assets/uploadRefusals-MkRGsgxP.js",
      "the gate answered non_ro_not_included for this document and then crashed",
      'NonRoNotIncludedError: {"error": "some_code_the_engine_may_add"}',
      "duplicate_of:8f2c",
    ];
    for (const err of ordinary) {
      expect(friendlyDocumentError(err), err).toBe(err);
      expect(documentRefusalCode(err), err).toBeNull();
      expect(documentRefusalKey(err), err).toBeNull();
    }
    expect(friendlyDocumentError(null)).toBeNull();
    expect(friendlyDocumentError(undefined)).toBeUndefined();
    expect(friendlyDocumentError("")).toBe("");
  });
});

describe("the HTTP refusal (caller only) carries the code's sentence, not the server's", () => {
  it.each(LANGS)("%s: parseUploadRefusal's message is the stated sentence", async (lang) => {
    await i18n.changeLanguage(lang);
    const r = parseUploadRefusal({
      detail: { error: "non_ro_not_included", upgrade_to: "multi", plan_key: "solo", message: SERVER_MESSAGES.non_ro_not_included },
    });
    expect(r).toEqual({ kind: "non_ro_blocked", upgradeTo: "multi", message: EXPECTED.non_ro_not_included[lang] });
  });

  it("only the non-RO code opens the upgrade dialog", () => {
    expect(parseUploadRefusal({ detail: { error: "nonro_quota_exhausted" } })).toBeNull();
    expect(parseUploadRefusal({ error: "metering_unavailable" })).toBeNull();
  });

  it("the upgrade dialog has no server-message line, and the hook hands it none", () => {
    const dialog = source("components/cfo/pricing/NonRoUpgradeDialog.tsx");
    expect(dialog).not.toMatch(/serverMessage/);
    expect(dialog).not.toMatch(/non-ro-server-message/);
    expect(dialog).toMatch(/t\("pricing\.nonRoBlockedDesc"\)/);
    const hook = source("hooks/useUploadEnqueue.tsx");
    expect(hook).toMatch(/<NonRoUpgradeDialog\s+open\s+onClose=\{handleNonRoClose\}\s*\/>/);
  });
});

describe("the Documents panel row of a failed document says why", () => {
  const row = (status: string, error: string | null) =>
    render(createElement(DocRefusalReason, { status, error }));

  for (const lang of LANGS) {
    for (const code of CODES) {
      it(`${lang}: a failed document holding ${code} prints the stated sentence`, async () => {
        await i18n.changeLanguage(lang);
        row("failed", stored(code));
        expect(screen.getByTestId("doc-refusal-reason").textContent).toBe(EXPECTED[code][lang]);
      });
    }
  }

  it("prints nothing for an ordinary error, for no error, or for a document that did not fail", () => {
    row("failed", "RuntimeError: compute failed");
    row("failed", null);
    row("analyzed", stored("non_ro_not_included"));
    row("queued", stored("metering_unavailable"));
    expect(screen.queryByTestId("doc-refusal-reason")).toBeNull();
  });

  it("the panel mounts it on the document row with the row's own status and error", () => {
    expect(source("components/cfo/DocsPanel.tsx")).toMatch(
      /<DocRefusalReason status=\{doc\.status\} error=\{doc\.error\} \/>/,
    );
  });
});

describe("every place a stored error reaches the screen passes through the humanizer", () => {
  it("the two seams of lib/supabase.ts, and the API-served copy on Products", () => {
    const supabase = source("lib/supabase.ts");
    // the status subscription and the one-shot status read
    expect(supabase.match(/friendlyDocumentError\(row\.error\)/g)?.length).toBe(2);
    expect(supabase).toMatch(/^import \{[^}]*friendlyDocumentError[^}]*\} from "@\/lib\/uploadRefusals";$/m);
    // /api/sku-analysis/inflight serves documents.error raw
    expect(source("pages/cfo/Products.tsx")).toMatch(/error: friendlyDocumentError\(j\.document\.error\) \?\? null/);
    // the humanizer itself never reads a `message`
    const lib = source("lib/uploadRefusals.ts");
    const code = lib.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
    expect(code).not.toMatch(/\.message\b/);
  });
});
