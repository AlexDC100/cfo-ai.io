// F5.0 Phase 9 — Landing section selling the CFO AI Learn layer.
// ─────────────────────────────────────────────────────────────────────
// A first-time visitor on cfo-ai.io has no idea every number in the
// product is clickable, formula-traceable, and source-auditable. That
// is the single biggest differentiator vs "another dashboard"; if it
// isn't on the landing page it doesn't sell itself.
//
// Three frames in one section:
//   1. Layer 1 — definition + sentiment ("EBITDA — operating profit
//      before interest, tax, depreciation")
//   2. Layer 2 — formula recursion ("EBIT + D&A; tap EBIT to keep going")
//   3. Layer 3 — source-account drill ("tap further to see 70x / 60x
//      raw accounts from the trial balance")
//
// Static SVG-only illustrations; no live numbers. The section lives in
// the marketing surface, not the analyst app, so we never want a build
// hash to invalidate it. Mobile-first, mirrors BridgeSection's layout.

import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";

export function LearningLayerSection() {
  const { t } = useTranslation();

  const layers = [
    {
      n: "1",
      label: t("landing.learn.layer1.label", "Definition"),
      title: t("landing.learn.layer1.title", "Tap any number"),
      body: t(
        "landing.learn.layer1.body",
        "A plain-English explanation pops up. No CFA charter required — every concept reads at smart-business-user level.",
      ),
      visual: <DefinitionIllustration />,
    },
    {
      n: "2",
      label: t("landing.learn.layer2.label", "Formula"),
      title: t("landing.learn.layer2.title", "Trace the calculation"),
      body: t(
        "landing.learn.layer2.body",
        "See exactly how the value was computed. Tap any operand to keep drilling — EBITDA opens to EBIT + D&A, EBIT opens to Revenue − OpEx, all the way down.",
      ),
      visual: <FormulaIllustration />,
    },
    {
      n: "3",
      label: t("landing.learn.layer3.label", "Source"),
      title: t("landing.learn.layer3.title", "Back to your trial balance"),
      body: t(
        "landing.learn.layer3.body",
        "At the bottom of every chain are the raw RAS accounts — 701, 602, 5121. Click through to see the actual debit / credit movements from your upload.",
      ),
      visual: <SourceIllustration />,
    },
  ];

  return (
    <section
      data-testid="landing-learn-section"
      className="relative border-t border-rule/40 bg-bg"
    >
      <div className="relative mx-auto max-w-[1100px] px-5 sm:px-8 py-20 sm:py-28">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-3xl mx-auto mb-14 sm:mb-16"
        >
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full
                       bg-[hsl(173,57%,55%)]/[0.08] border border-[hsl(173,57%,55%)]/[0.25]
                       mb-5"
          >
            <span
              className="h-1.5 w-1.5 rounded-full bg-[hsl(173,57%,40%)]"
              aria-hidden
            />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[hsl(173,57%,30%)]">
              {t("landing.learn.badge", "CFO AI Learn")}
            </span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-[44px] font-semibold tracking-tight leading-[1.05] text-ink mb-4">
            {t(
              "landing.learn.headline",
              "Every number, traceable. Every formula, walkable.",
            )}
          </h2>
          <p className="text-[15px] sm:text-base text-ink-soft leading-relaxed max-w-2xl mx-auto">
            {t(
              "landing.learn.subhead",
              "Most dashboards hand you a number and trust you to believe it. This one lets you tap any value and walk it back — definition, formula, then the actual trial-balance accounts behind it.",
            )}
          </p>
        </motion.div>

        <div className="relative grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8">
          {/* Connecting line — desktop only. Same pattern as BridgeSection. */}
          <div
            className="hidden md:block absolute top-[3.25rem] left-[16.66%] right-[16.66%]
                       h-px bg-gradient-to-r from-[hsl(173,57%,55%)]/0
                       via-[hsl(173,57%,55%)]/40 to-[hsl(173,57%,55%)]/0 pointer-events-none"
            aria-hidden
          />

          {layers.map((layer, i) => (
            <motion.div
              key={layer.n}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.12, duration: 0.5 }}
              className="relative flex flex-col items-center text-center"
              data-testid={`landing-learn-layer-${layer.n}`}
            >
              {/* Step circle — teal accent to match the in-app learning rail. */}
              <div
                className="
                  w-7 h-7 rounded-full
                  bg-[hsl(173,57%,55%)]/[0.16]
                  border border-[hsl(173,57%,55%)]/[0.3]
                  grid place-items-center
                  text-[11.5px] font-semibold text-[hsl(173,57%,30%)]
                  shadow-[0_1px_2px_rgba(0,0,0,0.04)]
                  relative z-10 mb-5
                "
              >
                {layer.n}
              </div>

              {/* Illustration card */}
              <div
                className="
                  w-full rounded-2xl border border-rule/60 bg-surface
                  px-5 py-6 sm:px-6 sm:py-7
                  shadow-[0_4px_24px_-12px_rgba(0,0,0,0.08)]
                  flex flex-col items-center
                "
              >
                <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-3">
                  {layer.label}
                </div>
                <div className="w-full h-[100px] sm:h-[120px] flex items-center justify-center mb-4">
                  {layer.visual}
                </div>
                <h3 className="font-serif text-[20px] sm:text-[22px] text-ink leading-tight mb-2">
                  {layer.title}
                </h3>
                <p className="text-[13.5px] text-ink-soft leading-relaxed">
                  {layer.body}
                </p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Bottom proof point — the single sentence the visitor takes
            away if they skim the rest of the landing page. */}
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.45, duration: 0.5 }}
          className="text-center text-[13px] text-ink-mute mt-12 max-w-2xl mx-auto"
        >
          {t(
            "landing.learn.footnote",
            "108 concepts in the glossary today — RAS / GAAP cross-references, plain-English explanations, and per-industry benchmarks. Press Cmd-K inside the app to search them all.",
          )}
        </motion.p>
      </div>
    </section>
  );
}

// ─── Inline SVG illustrations — no chart libs, no fonts loaded ──────────
// Each illustration is intentionally small (<50 nodes) so the section
// stays cheap to render and the SVG payload is negligible.

function DefinitionIllustration() {
  return (
    <svg
      viewBox="0 0 200 100"
      className="w-full max-w-[200px]"
      aria-hidden
    >
      {/* A "number" with an underline + a popover bubble next to it. */}
      <text
        x="40"
        y="55"
        fontFamily="system-ui, sans-serif"
        fontSize="22"
        fontWeight="600"
        fill="hsl(0, 0%, 12%)"
      >
        54.4M
      </text>
      <line
        x1="40"
        y1="62"
        x2="86"
        y2="62"
        stroke="hsl(173, 57%, 45%)"
        strokeWidth="1.5"
        strokeDasharray="2,2"
      />
      <rect
        x="95"
        y="22"
        width="92"
        height="56"
        rx="8"
        fill="white"
        stroke="hsl(0, 0%, 85%)"
        strokeWidth="1"
      />
      <text x="105" y="42" fontFamily="system-ui, sans-serif" fontSize="9" fontWeight="600" fill="hsl(173, 57%, 30%)">
        EBITDA
      </text>
      <line x1="105" y1="48" x2="175" y2="48" stroke="hsl(0, 0%, 90%)" />
      <text x="105" y="60" fontFamily="system-ui, sans-serif" fontSize="8" fill="hsl(0, 0%, 40%)">
        Operating profit
      </text>
      <text x="105" y="71" fontFamily="system-ui, sans-serif" fontSize="8" fill="hsl(0, 0%, 40%)">
        before interest
      </text>
    </svg>
  );
}

function FormulaIllustration() {
  return (
    <svg
      viewBox="0 0 200 100"
      className="w-full max-w-[200px]"
      aria-hidden
    >
      {/* EBITDA = EBIT + D&A, with each operand boxed/underlined to
          suggest tappability. */}
      <text
        x="20"
        y="38"
        fontFamily="system-ui, sans-serif"
        fontSize="14"
        fontWeight="600"
        fill="hsl(0, 0%, 12%)"
      >
        EBITDA
      </text>
      <text x="75" y="38" fontFamily="system-ui, sans-serif" fontSize="14" fill="hsl(0, 0%, 40%)">
        =
      </text>
      <rect x="90" y="24" width="42" height="20" rx="4" fill="hsl(173, 57%, 55%)" fillOpacity="0.08" stroke="hsl(173, 57%, 45%)" strokeWidth="1" />
      <text x="98" y="38" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="hsl(173, 57%, 30%)">
        EBIT
      </text>
      <text x="138" y="38" fontFamily="system-ui, sans-serif" fontSize="14" fill="hsl(0, 0%, 40%)">
        +
      </text>
      <rect x="150" y="24" width="40" height="20" rx="4" fill="hsl(173, 57%, 55%)" fillOpacity="0.08" stroke="hsl(173, 57%, 45%)" strokeWidth="1" />
      <text x="158" y="38" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="hsl(173, 57%, 30%)">
        D&A
      </text>

      {/* Drill arrow — EBIT opens to its own sub-formula. */}
      <path
        d="M111 48 L111 62"
        stroke="hsl(173, 57%, 45%)"
        strokeWidth="1.25"
        strokeDasharray="2,2"
      />
      <path
        d="M107 60 L111 64 L115 60"
        fill="none"
        stroke="hsl(173, 57%, 45%)"
        strokeWidth="1.25"
      />
      <text
        x="60"
        y="80"
        fontFamily="system-ui, sans-serif"
        fontSize="9"
        fill="hsl(0, 0%, 50%)"
      >
        Revenue − OpEx
      </text>
    </svg>
  );
}

function SourceIllustration() {
  return (
    <svg
      viewBox="0 0 200 100"
      className="w-full max-w-[200px]"
      aria-hidden
    >
      {/* Three RAS account codes with a tiny D/C indicator. */}
      <rect x="20" y="20" width="160" height="68" rx="6" fill="white" stroke="hsl(0, 0%, 85%)" strokeWidth="1" />
      <text x="30" y="35" fontFamily="ui-monospace, monospace" fontSize="10" fontWeight="600" fill="hsl(0, 0%, 12%)">
        701
      </text>
      <text x="60" y="35" fontFamily="system-ui, sans-serif" fontSize="9" fill="hsl(0, 0%, 40%)">
        Vânzare produse finite
      </text>
      <text x="155" y="35" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="600" fill="hsl(173, 57%, 30%)">
        C
      </text>

      <text x="30" y="55" fontFamily="ui-monospace, monospace" fontSize="10" fontWeight="600" fill="hsl(0, 0%, 12%)">
        602
      </text>
      <text x="60" y="55" fontFamily="system-ui, sans-serif" fontSize="9" fill="hsl(0, 0%, 40%)">
        Cheltuieli materiale
      </text>
      <text x="155" y="55" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="600" fill="hsl(0, 60%, 45%)">
        D
      </text>

      <text x="30" y="75" fontFamily="ui-monospace, monospace" fontSize="10" fontWeight="600" fill="hsl(0, 0%, 12%)">
        5121
      </text>
      <text x="60" y="75" fontFamily="system-ui, sans-serif" fontSize="9" fill="hsl(0, 0%, 40%)">
        Conturi la bănci RON
      </text>
      <text x="155" y="75" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="600" fill="hsl(0, 60%, 45%)">
        D
      </text>
    </svg>
  );
}
