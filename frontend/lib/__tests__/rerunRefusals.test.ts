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
//
// F4 (stage 2 of the engine gate, 2026-10-04) — A RE-RUN THAT WAS ACCEPTED AND
// DID NOT FINISH. "Re-run analysis" is staged beside the file's month: a run
// that fails leaves the file `analyzed` over the analysis it had, and the
// engine says so in `documents.error` — `rerun_failed: <remainder>`. The
// reader gets one of three sentences by KIND; the remainder is never printed
// (the component's law: components/cfo/__tests__/docRerunNote.test.tsx).
// Fails on: the prefix or a code drifting from the engine's literals; a kind
// without a sentence in either language; the English fallback drifting from
// en.json; a stored error that is not a re-run's read as one.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import {
  RERUN_FAILED_ENGLISH,
  RERUN_FAILED_KINDS,
  RERUN_FAILED_PREFIX,
  RERUN_REFUSAL_CODES,
  RERUN_REFUSAL_ENGLISH,
  rerunFailedKey,
  rerunFailedKind,
  rerunFailedRemainder,
  rerunRefusalCode,
  rerunRefusalKey,
  type RerunFailedKind,
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


// ── F4 — a re-run that did not finish: prefix → kind → key → sentence ───
const FAILED: Record<RerunFailedKind, { key: string; en: string; ro: string }> = {
  interrupted: {
    key: "panels.rerunInterrupted",
    en: "The last re-run was interrupted while it was replacing the analysis. Run it again.",
    ro: "Ultima reanalizare a fost întreruptă în timp ce înlocuia analiza. Reia analiza.",
  },
  month_taken: {
    key: "panels.rerunMonthTaken",
    en: "The last re-run was not applied: the file now reads as a month that already has its own analysis. Nothing was changed.",
    ro: "Ultima reanalizare nu a fost aplicată: fișierul indică acum o lună care are deja propria analiză. Nu s-a schimbat nimic.",
  },
  kept: {
    key: "panels.rerunFailedKept",
    en: "The last re-run didn't finish. You're still seeing the previous analysis.",
    ro: "Ultima reanalizare nu s-a încheiat. Vezi în continuare analiza anterioară.",
  },
};
const KINDS = Object.keys(FAILED) as RerunFailedKind[];

describe("F4 — a re-run that did not finish has its sentence, by kind, in both languages", () => {
  it("the prefix and the two codes are the engine's own literals", () => {
    expect(RERUN_FAILED_PREFIX).toBe("rerun_failed: ");
    // src/engine/api/pipeline.py: RERUN_FAILED_PREFIX, RERUN_INTERRUPTED, RERUN_MONTH_TAKEN
    const engine = readFileSync(resolve(REPO, "src/engine/api/pipeline.py"), "utf8");
    expect(engine).toContain('RERUN_FAILED_PREFIX = "rerun_failed: "');
    expect(engine).toContain('RERUN_INTERRUPTED = "interrupted_replacing"');
    expect(engine).toContain('RERUN_MONTH_TAKEN = "rerun_month_taken"');
    expect([...RERUN_FAILED_KINDS].sort()).toEqual([...KINDS].sort());
  });

  it("what the engine stores reads as its kind", () => {
    const stored: [string, RerunFailedKind][] = [
      ["rerun_failed: interrupted_replacing", "interrupted"],
      ["rerun_failed: rerun_month_taken", "month_taken"],
      ["rerun_failed: RuntimeError: compute failed", "kept"],
      ["rerun_failed: document_superseded", "kept"],
      ['rerun_failed: {"error": "non_ro_not_included"}', "kept"],
      ["rerun_failed: ", "kept"],
      // a code is the WHOLE remainder, never a word inside a sentence
      ["rerun_failed: the takeover was interrupted_replacing something", "kept"],
    ];
    for (const [error, kind] of stored) expect(rerunFailedKind(error), error).toBe(kind);
  });

  it("an error that is not a re-run's is not one", () => {
    const others: unknown[] = [
      null,
      undefined,
      "",
      42,
      {},
      "interrupted_replacing",
      "rerun_month_taken",
      "superseded_by:0d0c0000-0000-4000-8000-0000000000d2",
      "duplicate_of:0d0c0000-0000-4000-8000-0000000000d1",
      "RuntimeError: compute failed",
      " rerun_failed: interrupted_replacing",
      "rerun_failed:interrupted_replacing",
      "RERUN_FAILED: interrupted_replacing",
    ];
    for (const error of others) {
      expect(rerunFailedKind(error as string), String(error)).toBeNull();
      expect(rerunFailedRemainder(error as string), String(error)).toBeNull();
    }
  });

  it("the remainder is what follows the prefix (for a code lookup, never for printing)", () => {
    expect(rerunFailedRemainder('rerun_failed: {"error": "non_ro_not_included"}')).toBe('{"error": "non_ro_not_included"}');
    expect(rerunFailedRemainder("rerun_failed: interrupted_replacing")).toBe("interrupted_replacing");
  });

  for (const kind of KINDS) {
    it(`${kind} → ${FAILED[kind].key}`, () => {
      expect(rerunFailedKey(kind)).toBe(FAILED[kind].key);
    });

    for (const lang of LANGS) {
      it(`${lang}: ${kind} prints the stated sentence`, async () => {
        await i18n.changeLanguage(lang);
        const printed = i18n.t(rerunFailedKey(kind));
        expect(printed).toBe(FAILED[kind][lang]);
        expect(printed).not.toBe(FAILED[kind].key);
        for (const raw of ["rerun_failed", "interrupted_replacing", "rerun_month_taken"]) {
          expect(printed).not.toContain(raw);
        }
      });
    }
  }

  it("both locale files hold the stated sentences, and the English fallback equals en.json", () => {
    for (const kind of KINDS) {
      expect(at(locale("en"), FAILED[kind].key)).toBe(FAILED[kind].en);
      expect(at(locale("ro"), FAILED[kind].key)).toBe(FAILED[kind].ro);
      expect(RERUN_FAILED_ENGLISH[FAILED[kind].key]).toBe(FAILED[kind].en);
    }
    expect(Object.keys(RERUN_FAILED_ENGLISH).sort()).toEqual(KINDS.map((k) => FAILED[k].key).sort());
  });

  it("each sentence says what the reader is looking at, and none names the action that empties the month", () => {
    // "kept": the previous analysis is still served; "month_taken": nothing changed;
    // "interrupted": the one line that asks for an action — run it again.
    expect(FAILED.kept.en).toMatch(/previous analysis/i);
    expect(FAILED.kept.ro).toMatch(/analiza anterioară/i);
    expect(FAILED.month_taken.en).toMatch(/nothing was changed/i);
    expect(FAILED.month_taken.ro).toMatch(/nu s-a schimbat nimic/i);
    expect(FAILED.interrupted.en).toMatch(/run it again/i);
    expect(FAILED.interrupted.ro).toMatch(/reia analiza/i);
    for (const kind of KINDS) {
      expect(FAILED[kind].en).not.toMatch(/source|make active|workspace/i);
      expect(FAILED[kind].ro).not.toMatch(/sursă|sursa|workspace|spațiu de lucru/i);
    }
  });
});
