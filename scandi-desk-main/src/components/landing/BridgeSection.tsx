// BridgeSection — the 3-step mental model that sells the product in 8 seconds.
// =========================================================================
// Strategic repositioning (2026-05-27): the landing page used to lead with
// AAPL/MSFT/NVDA tile previews, implicitly pitching "this tool analyzes
// mega-cap stocks." Real users are SMB / mid-market operators who want
// benchmarks against companies their size, not Apple. This component is the
// "OH NOW I GET IT" moment between Hero and the rest of the page — three
// illustrated frames showing upload → pick peers → see-yourself-in-context.
//
// All illustrations are inline SVG (no chart libs, no external assets) so
// the section renders during the LCP window without blocking on network or
// chart-renderer JS. Each illustration is intentionally small (<60 nodes)
// so the SVG payload is negligible.
//
// The connecting line on desktop ties the three steps visually — a hairline
// gradient that fades in/out at the endpoints so it doesn't bleed past the
// last step's circle. Hidden on mobile (single-column stack makes it
// confusing).
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";

export function BridgeSection() {
  const { t } = useTranslation();

  const steps = [
    {
      n: "1",
      title: t("landing.bridge.step1.title", "Upload your trial balance"),
      body: t(
        "landing.bridge.step1.body",
        "Romanian bilanț, P&L, or any standard format. Parsed in 90 seconds.",
      ),
      visual: <UploadIllustration />,
    },
    {
      n: "2",
      title: t("landing.bridge.step2.title", "Pick public peers"),
      body: t(
        "landing.bridge.step2.body",
        "We suggest public companies in your sector and size. Add 3–5 of them.",
      ),
      visual: <PeerPickerIllustration />,
    },
    {
      n: "3",
      title: t("landing.bridge.step3.title", "See yourself in context"),
      body: t(
        "landing.bridge.step3.body",
        "Your numbers, your peers, your industry range — all on one chart.",
      ),
      visual: <BenchmarkIllustration />,
    },
  ];

  return (
    <section className="relative border-t border-rule/40">
      <div className="relative mx-auto max-w-[1100px] px-5 sm:px-8 py-20 sm:py-28">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-3xl mx-auto mb-14 sm:mb-16"
        >
          <h2 className="text-3xl sm:text-4xl md:text-[44px] font-semibold tracking-tight leading-[1.05] text-ink mb-4">
            {t(
              "landing.bridge.headline",
              "Pick public peers your size. Compare your numbers to theirs.",
            )}
          </h2>
          <p className="text-[15px] sm:text-base text-ink-soft leading-relaxed max-w-2xl mx-auto">
            {t(
              "landing.bridge.subhead",
              "Not Apple. Not Microsoft. Actual mid-market public companies in your actual sector — companies you could realistically aspire to.",
            )}
          </p>
        </motion.div>

        <div className="relative grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8">
          {/* Connecting line — desktop only. Centered on step circles
              (top: 24px below their bottom = matches the 12-w / 12-h
              circle at top of card). Gradient fade at endpoints so it
              doesn't bleed past the first / last circle. */}
          <div
            className="hidden md:block absolute top-[3.25rem] left-[16.66%] right-[16.66%] h-px bg-gradient-to-r from-info/0 via-info/40 to-info/0 pointer-events-none"
            aria-hidden
          />

          {steps.map((step, i) => (
            <motion.div
              key={step.n}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.12, duration: 0.5 }}
              className="relative flex flex-col items-center text-center"
            >
              {/* Step number circle */}
              <div
                className="
                  relative z-10 mb-5
                  inline-flex items-center justify-center
                  w-[3.25rem] h-[3.25rem] rounded-full
                  bg-info/12 text-info
                  font-mono font-semibold text-lg
                  ring-4 ring-bg
                "
              >
                {step.n}
              </div>

              {/* Illustration frame */}
              <div
                className="
                  w-full rounded-2xl border border-rule/60 bg-surface
                  p-5 sm:p-6 mb-5
                  aspect-[5/3] flex items-center justify-center
                  shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)]
                "
              >
                {step.visual}
              </div>

              <h3 className="text-lg font-semibold text-ink mb-2">{step.title}</h3>
              <p className="text-[13.5px] text-ink-soft leading-relaxed max-w-xs">
                {step.body}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Illustrations — inline SVG using project tokens via CSS vars
// (--ink-mute / --info / --rule resolve through Tailwind's HSL setup).
// Stroke widths are 1.5–2 so they render crisply at the small frame size.
// ───────────────────────────────────────────────────────────────────────

function UploadIllustration() {
  return (
    <svg viewBox="0 0 200 120" className="w-full max-w-[200px]" aria-hidden>
      {/* Document outline */}
      <rect
        x="60" y="20" width="80" height="100" rx="6"
        fill="hsl(var(--surface))" stroke="hsl(var(--rule-strong, var(--rule)))"
        strokeWidth="1.5"
      />
      {/* Text lines */}
      <line x1="72" y1="38" x2="128" y2="38" stroke="hsl(var(--ink-mute))" strokeWidth="2" strokeLinecap="round" />
      <line x1="72" y1="48" x2="120" y2="48" stroke="hsl(var(--ink-mute))" strokeWidth="2" strokeLinecap="round" />
      <line x1="72" y1="58" x2="125" y2="58" stroke="hsl(var(--ink-mute))" strokeWidth="2" strokeLinecap="round" />
      <line x1="72" y1="68" x2="115" y2="68" stroke="hsl(var(--ink-mute))" strokeWidth="2" strokeLinecap="round" />
      {/* Upload arrow circle — accent */}
      <circle cx="100" cy="95" r="14" fill="hsl(var(--info))" opacity="0.15" />
      <path
        d="M100 85 V 100 M93 92 L100 85 L107 92"
        stroke="hsl(var(--info))" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function PeerPickerIllustration() {
  // Three peer chips spaced ~40-50px apart. Last one shows "+ add" prompt
  // to telegraph that the user is building a list, not searching one-shot.
  return (
    <svg viewBox="0 0 240 120" className="w-full max-w-[240px]" aria-hidden>
      {/* Picker frame */}
      <rect
        x="20" y="20" width="200" height="80" rx="10"
        fill="hsl(var(--surface))" stroke="hsl(var(--rule-strong, var(--rule)))"
        strokeWidth="1.5"
      />
      {/* Search input */}
      <rect
        x="32" y="32" width="176" height="20" rx="10"
        fill="hsl(var(--bg))" stroke="hsl(var(--rule))" strokeWidth="1"
      />
      <circle cx="44" cy="42" r="3" fill="none" stroke="hsl(var(--ink-mute))" strokeWidth="1.5" />
      {/* Three peer chips */}
      {[
        { x: 32, label: "HAIN" },
        { x: 82, label: "LWAY" },
        { x: 132, label: "JJSF" },
      ].map((chip) => (
        <g key={chip.label}>
          <rect x={chip.x} y="62" width="44" height="22" rx="11" fill="hsl(var(--info))" opacity="0.15" />
          <rect
            x={chip.x} y="62" width="44" height="22" rx="11"
            fill="none" stroke="hsl(var(--info))" strokeWidth="1" opacity="0.4"
          />
          <text
            x={chip.x + 22} y="76" textAnchor="middle"
            fontSize="8" fontFamily="ui-monospace, monospace" fontWeight="600"
            fill="hsl(var(--info))"
          >
            {chip.label}
          </text>
        </g>
      ))}
      <text x="184" y="76" fontSize="9" fill="hsl(var(--ink-mute))">+ add</text>
    </svg>
  );
}

function BenchmarkIllustration() {
  // The payoff illustration: P25-P75 industry range with median tick,
  // "YOU" dot (accent green) clearly below median, peer dots (info blue)
  // distributed above. Telegraphs the multi-dot benchmark output WITHOUT
  // overloading visually.
  return (
    <svg viewBox="0 0 240 120" className="w-full max-w-[240px]" aria-hidden>
      <rect
        x="20" y="20" width="200" height="80" rx="10"
        fill="hsl(var(--surface))" stroke="hsl(var(--rule-strong, var(--rule)))"
        strokeWidth="1.5"
      />
      <text x="32" y="38" fontSize="8" fill="hsl(var(--ink-soft))" fontWeight="600">
        EBITDA MARGIN
      </text>
      {/* Industry P25–P75 range */}
      <rect x="60" y="50" width="120" height="10" rx="5" fill="hsl(var(--info))" opacity="0.18" />
      <rect
        x="32" y="50" width="176" height="10" rx="5"
        fill="none" stroke="hsl(var(--rule))" strokeWidth="1"
      />
      {/* Median marker */}
      <line x1="110" y1="48" x2="110" y2="62" stroke="hsl(var(--ink-soft))" strokeWidth="1.5" />
      {/* YOU dot — green accent */}
      <circle cx="85" cy="55" r="4.5" fill="hsl(var(--success))" stroke="hsl(var(--surface))" strokeWidth="2" />
      <text x="85" y="80" textAnchor="middle" fontSize="7"
            fontFamily="ui-monospace, monospace" fontWeight="700" fill="hsl(var(--success))">
        YOU
      </text>
      {/* Peer dots — info blue */}
      <circle cx="140" cy="55" r="3" fill="hsl(var(--info))" stroke="hsl(var(--surface))" strokeWidth="2" />
      <text x="140" y="80" textAnchor="middle" fontSize="7"
            fontFamily="ui-monospace, monospace" fill="hsl(var(--info))">HAIN</text>
      <circle cx="165" cy="55" r="3" fill="hsl(var(--info))" stroke="hsl(var(--surface))" strokeWidth="2" />
      <text x="165" y="80" textAnchor="middle" fontSize="7"
            fontFamily="ui-monospace, monospace" fill="hsl(var(--info))">JJSF</text>
      <circle cx="100" cy="55" r="3" fill="hsl(var(--info))" stroke="hsl(var(--surface))" strokeWidth="2" />
      <text x="100" y="80" textAnchor="middle" fontSize="7"
            fontFamily="ui-monospace, monospace" fill="hsl(var(--info))">LWAY</text>
      {/* Percentile labels */}
      <text x="32" y="102" fontSize="6" fill="hsl(var(--ink-mute))">P25</text>
      <text x="200" y="102" fontSize="6" fill="hsl(var(--ink-mute))" textAnchor="end">P75</text>
    </svg>
  );
}
