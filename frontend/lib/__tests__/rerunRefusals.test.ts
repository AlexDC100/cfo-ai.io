// GATE rerun-refusal-surfaces (the module half): A REFUSED RE-RUN IS SAID IN
// WORDS, FROM ITS CODE — never the bare code, never the server's words.
//
// `POST /api/pipeline/retry` refuses a re-run that would reset a period which
// is not the document's own (engine gate rerun-data-loss). It answers a CODE
// and nothing else; the reader's browser prints the sentence written for that
// code in the reader's language. Before 2026-10-04 the Docs panel discarded
// the body and said only "Couldn't start re-run".
//
// The expected sentences are STATED here, in English and in Romanian — not
// read back through the module under test and not read from the locale files
// (which a second test holds equal to them).
//
// Fails on: a code without a sentence in either language; a sentence that is
// the bare code or carries it; the English fallback drifting from en.json; a
// body's `message` (or anything but its code) being read; an unknown code
// treated as a refusal; "Use as this period's source" being named (it empties
// the month before its own re-run); the module moving behind a lazy import.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import {
  RERUN_REFUSAL_CODES,
  RERUN_REFUSAL_ENGLISH,
  rerunRefusalCode,
  rerunRefusalKey,
  type RerunRefusalCode,
} from "@/lib/rerunRefusals";

// ── The law, stated: code → key → sentence, in each language. ───────────
const EXPECTED: Record<RerunRefusalCode, { key: string; en: string; ro: string }> = {
  document_superseded: {
    key: "panels.rerunSuperseded",
    en: "Another upload has replaced this file for its month, so it was not re-analysed and the month was not changed. To use this file for the month again, upload it again.",
    ro: "O altă încărcare a înlocuit acest fișier pentru luna lui, așa că nu a fost reanalizat, iar luna nu s-a schimbat. Ca să folosești din nou acest fișier pentru lună, încarcă-l din nou.",
  },
  rerun_period_not_own: {
    key: "panels.rerunPeriodNotOwn",
    en: "This file isn't linked to an analysis of its own, so it was not re-analysed and nothing was changed. To analyse it, upload the file again.",
    ro: "Fișierul nu este legat de o analiză proprie, așa că nu a fost reanalizat și nu s-a schimbat nimic. Ca să îl analizezi, încarcă fișierul din nou.",
  },
  rerun_unavailable: {
    key: "panels.rerunUnavailable",
    en: "We couldn't read this file's analysis just now, so the re-run didn't start. Nothing was changed — try again in a moment.",
    ro: "Nu am putut citi acum analiza acestui fișier, așa că reanalizarea nu a pornit. Nu s-a schimbat nimic — încearcă din nou peste puțin timp.",
  },
};
const CODES = Object.keys(EXPECTED) as RerunRefusalCode[];
const LANGS = ["en", "ro"] as const;

const FRONTEND = resolve(__dirname, "../..");
const REPO = resolve(FRONTEND, "..");
const source = (rel: string) => readFileSync(resolve(FRONTEND, rel), "utf8");
const locale = (lang: string) => JSON.parse(source(`i18n/locales/${lang}.json`));
const at = (tree: Record<string, unknown>, key: string): unknown =>
  key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);

/** What the REAL route answers for a superseded document — the file the
 *  engine law (tests/engine/test_rerun_ownership.py, O1) holds the route to. */
const FIXTURE = resolve(REPO, "tests/engine/fixtures/rerun/retry_refused_superseded.json");

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("F1 — every refusal code of the retry route has its sentence, in both languages", () => {
  it("the codes are exactly the three the route answers with", () => {
    expect([...RERUN_REFUSAL_CODES].sort()).toEqual([...CODES].sort());
  });

  for (const code of CODES) {
    it(`${code} → ${EXPECTED[code].key}`, () => {
      expect(rerunRefusalKey(code)).toBe(EXPECTED[code].key);
    });

    for (const lang of LANGS) {
      it(`${lang}: ${code} prints the stated sentence`, async () => {
        await i18n.changeLanguage(lang);
        const printed = i18n.t(rerunRefusalKey(code));
        expect(printed).toBe(EXPECTED[code][lang]);
        // never the bare code, never the key, never a code inside the sentence
        expect(printed).not.toBe(code);
        expect(printed).not.toBe(EXPECTED[code].key);
        for (const any of CODES) expect(printed).not.toContain(any);
      });
    }
  }

  it("both locale files hold the stated sentences, and the English fallback equals en.json", () => {
    for (const code of CODES) {
      expect(at(locale("en"), EXPECTED[code].key)).toBe(EXPECTED[code].en);
      expect(at(locale("ro"), EXPECTED[code].key)).toBe(EXPECTED[code].ro);
      expect(RERUN_REFUSAL_ENGLISH[EXPECTED[code].key]).toBe(EXPECTED[code].en);
    }
    expect(Object.keys(RERUN_REFUSAL_ENGLISH).sort()).toEqual(CODES.map((c) => EXPECTED[c].key).sort());
  });

  it("says what was NOT changed, and never names the action that empties the month", () => {
    for (const code of CODES) {
      expect(EXPECTED[code].en).toMatch(/(was not changed|nothing was changed)/i);
      expect(EXPECTED[code].ro).toMatch(/(nu s-a schimbat)/i);
      // "Use as this period's source" / "Folosește ca sursă a perioadei"
      // (make-active) wipes the month's analysis before its own re-run.
      expect(EXPECTED[code].en).not.toMatch(/source|make active/i);
      expect(EXPECTED[code].ro).not.toMatch(/sursă|sursa/i);
      // companies have files and months; "workspace" is not the reader's word
      expect(EXPECTED[code].en).not.toMatch(/workspace/i);
      expect(EXPECTED[code].ro).not.toMatch(/workspace|spațiu de lucru/i);
    }
  });
});

describe("F2 (the reader) — the code is read from the answer, and only the code", () => {
  it("the committed answer of the real route reads as document_superseded", () => {
    const body = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(body).toEqual({ detail: { code: "document_superseded" } });
    expect(rerunRefusalCode(body)).toBe("document_superseded");
  });

  it("each code is read under FastAPI's `detail` envelope and bare", () => {
    for (const code of CODES) {
      expect(rerunRefusalCode({ detail: { code } })).toBe(code);
      expect(rerunRefusalCode({ code })).toBe(code);
    }
  });

  it("anything else is not a refusal this client knows", () => {
    const unknown: unknown[] = [
      null,
      undefined,
      "document_superseded",
      42,
      [],
      [{ code: "document_superseded" }],
      {},
      { detail: "Internal Server Error" },
      { detail: { code: "some_new_code" } },
      { detail: { code: 409 } },
      // the retry route's own answers that are NOT these refusals
      { detail: { code: "document_deleted", message: "This document was deleted. Restore it before re-running it." } },
      { document_id: "d1", status: "queued" },
      // a code under another name is not read
      { detail: { error: "document_superseded" } },
    ];
    for (const body of unknown) expect(rerunRefusalCode(body)).toBeNull();
  });
});

describe("F3 — the server's words are never read", () => {
  it("a body carrying a message yields its code and nothing of the message", () => {
    const out = rerunRefusalCode({
      detail: { code: "document_superseded", message: "period 0d0c0000 belongs to document 1234", period_id: "0d0c0000" },
    });
    expect(out).toBe("document_superseded");
  });

  it("the module never reads a `message`, a period id or a document id", () => {
    const code = source("lib/rerunRefusals.ts")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/\.message\b/);
    expect(code).not.toMatch(/period_id|document_id/);
  });
});

describe("F6 — the module is on an error path, so it is never behind a lazy import", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  walk(FRONTEND);

  it("is imported statically by the client that reads the answer and by the panel that prints it", () => {
    expect(source("lib/supabase.ts")).toMatch(
      /^import \{[^}]*rerunRefusalCode[^}]*\} from "@\/lib\/rerunRefusals";$/m,
    );
    expect(source("components/cfo/DocsPanel.tsx")).toMatch(
      /^import \{[^}]*rerunRefusalKey[^}]*\} from "@\/lib\/rerunRefusals";$/m,
    );
  });

  it("no file reaches it through import()", () => {
    expect(files.length).toBeGreaterThan(200); // the walk found the app
    const lazy = files.filter((f) => /import\(\s*["'][^"']*rerunRefusals["']\s*\)/.test(readFileSync(f, "utf8")));
    expect(lazy).toEqual([]);
  });
});
