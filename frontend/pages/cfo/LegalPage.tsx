// LegalPage — /privacy, /terms, /cookies.
//
// THIS PAGE DELIBERATELY CONTAINS NO LEGAL TEXT.
//
// The three documents exist already, as sections of the marketing page
// (`Landing.tsx`, `#legal-privacy` / `#legal-cookies` / `#legal-terms`),
// and they carry `[bracketed]` placeholders that only the owner and a
// lawyer can fill. Drafting or paraphrasing any of that here would
// produce a SECOND, divergent version of a document with legal force —
// the exact failure mode the one-config rule exists to prevent.
//
// What this page does:
//   · gives each document a real URL (there was none — `/privacy` fell
//     through the SPA to the catch-all route);
//   · renders the registered-entity block from `lib/legalConfig`;
//   · while `legalBlockers()` is non-empty, renders a clearly marked
//     TEXT REQUIRED block naming every missing item, so the state is
//     visible rather than implied by a bracketed placeholder buried in
//     paragraph 4;
//   · links through to the drafted body on the marketing page, so the
//     text that DOES exist is one click away and lives in one place.
//
// The launch gate treats a page whose `legalBlockers()` is non-empty as
// BLOCKED, never as shipped copy.

import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  LEGAL_ENTITY,
  LEGAL_DOC_IDS,
  legalBlockers,
  legalDocPath,
  type LegalDocId,
} from "@/lib/legalConfig";

const DOC_TITLE: Record<LegalDocId, string> = {
  privacy: "Privacy Policy",
  terms: "Terms of Service",
  cookies: "Cookie Policy",
};

/** Human label for a blocker id. Kept next to the ids so a new required
 *  field cannot be added without a label. */
const BLOCKER_LABEL: Record<string, string> = {
  "entity.denumire": "Denumire — registered company name",
  "entity.cui": "CUI / CIF — fiscal identification code",
  "entity.regCom": "Nr. Reg. Com. — trade-register number",
  "entity.sediu": "Sediu social — registered office address",
  "entity.privacyEmail": "Data-protection contact address",
  "entity.legalEmail": "Legal contact address",
  legal_text_review: "Document bodies reviewed and approved by a lawyer",
};

export function LegalPage({ doc }: { doc: LegalDocId }) {
  const navigate = useNavigate();
  const blockers = legalBlockers();

  useEffect(() => {
    document.title = `${DOC_TITLE[doc]} · CFO AI`;
  }, [doc]);

  return (
    <main
      data-testid="legal-page"
      data-legal-doc={doc}
      data-legal-blockers={blockers.length}
      className="mx-auto max-w-[840px] px-6 py-14 sm:px-8"
    >
      <button
        type="button"
        onClick={() => navigate("/")}
        className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-mute hover:text-ink"
      >
        CFO AI
      </button>

      <h1 className="mt-4 text-[26px] font-medium text-ink">{DOC_TITLE[doc]}</h1>

      {/* ── Registered entity — the ONE config, rendered ────────────── */}
      <section className="mt-8 rounded-md border border-rule bg-surface p-5" data-testid="legal-entity">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          Operator
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[160px_1fr]">
          {(
            [
              ["Denumire", LEGAL_ENTITY.denumire],
              ["CUI / CIF", LEGAL_ENTITY.cui],
              ["Nr. Reg. Com.", LEGAL_ENTITY.regCom],
              ["Sediu social", LEGAL_ENTITY.sediu],
              ["Capital social", LEGAL_ENTITY.capitalSocial],
            ] as Array<[string, string | null]>
          ).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-soft">{label}</dt>
              <dd className={value ? "text-ink" : "font-mono text-[12px] text-caution"}>
                {value ?? "— not supplied —"}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── TEXT REQUIRED — owner item ──────────────────────────────── */}
      {blockers.length > 0 && (
        <section
          data-testid="legal-text-required"
          className="mt-6 rounded-md border border-caution/50 bg-caution-tint p-5"
        >
          <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-caution">
            TEXT REQUIRED — owner item
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            This document is not published. The items below are outstanding and
            must be supplied by the operator; nothing on this page is drafted
            or approved legal text.
          </p>
          <ul className="mt-3 space-y-1.5 text-[13px] text-ink-2">
            {blockers.map((b) => (
              <li key={b} className="flex gap-2">
                <span className="text-caution">·</span>
                <span>{BLOCKER_LABEL[b] ?? b}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[12.5px] leading-relaxed text-ink-soft">
            A working draft of all three documents already exists on the
            marketing page and carries bracketed placeholders for exactly the
            fields listed above. It is one source, not a second copy — fill{" "}
            <code className="font-mono text-[11.5px] text-ink-2">
              frontend/lib/legalConfig.ts
            </code>{" "}
            and have the bodies reviewed.
          </p>
          <a
            href="/#/legal"
            data-testid="legal-draft-link"
            className="mt-4 inline-flex h-9 items-center rounded-full border border-rule-strong px-4 text-[12.5px] text-ink hover:border-brand"
          >
            Read the current draft
          </a>
        </section>
      )}

      <nav className="mt-10 flex flex-wrap gap-3 border-t border-rule-soft pt-6 text-[13px]">
        {LEGAL_DOC_IDS.filter((d) => d !== doc).map((d) => (
          <Link key={d} to={legalDocPath(d)} className="text-ink-soft hover:text-ink">
            {DOC_TITLE[d]}
          </Link>
        ))}
        <Link to="/" className="text-ink-soft hover:text-ink">
          Home
        </Link>
      </nav>
    </main>
  );
}

export default LegalPage;
