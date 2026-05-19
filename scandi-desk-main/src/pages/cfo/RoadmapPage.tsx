// Phase 5 — Public roadmap page.
//
// This is where features we have NOT shipped live, with honest target
// dates. Pricing page must never mention these. Status labels are
// conservative:
//   research   — we're studying it
//   in-design  — we're scoping it
//   planning   — next quarter
//   backlog    — someday
//
// Never label anything "shipping next month" unless you're literally 2
// weeks from beta.

import { Link } from "react-router-dom";
import { Logo } from "@/components/cfo/Logo";
import { ThemeToggle } from "@/components/cfo/ThemeToggle";

type RoadmapStatus = "research" | "in-design" | "planning" | "backlog";

interface RoadmapEntry {
  title: string;
  description: string;
  status: RoadmapStatus;
  tier_target?: string;
}

const Q2_2026: RoadmapEntry[] = [
  {
    title: "ERP integration",
    description:
      "Direct sync from Saga, WinMentor, and SAP. No more manual trial-balance uploads.",
    status: "in-design",
    tier_target: "Professional",
  },
  {
    title: "ANAF e-Factura sync",
    description:
      "Automatic VAT and invoice pull from Romania's national e-invoicing system.",
    status: "research",
    tier_target: "Professional",
  },
];

const Q3_2026: RoadmapEntry[] = [
  {
    title: "White-label PDF reports",
    description:
      "Your logo, your colors, your client-facing analysis pack.",
    status: "planning",
    tier_target: "Professional",
  },
  {
    title: "SSO + Audit logs",
    description:
      "SAML/OIDC for enterprise teams; full audit trail per workspace.",
    status: "planning",
    tier_target: "Professional",
  },
  {
    title: "Custom KPI dashboards",
    description:
      "Build your own KPIs from line items. Drag-and-drop dashboard editor.",
    status: "planning",
    tier_target: "Professional",
  },
];

const BACKLOG: RoadmapEntry[] = [
  {
    title: "Multi-currency consolidation",
    description:
      "Holding companies with subsidiaries in EUR/RON/USD. Automated FX consolidation.",
    status: "backlog",
  },
  {
    title: "Banking integration",
    description:
      "Direct bank feeds for real-time cash position.",
    status: "backlog",
  },
];

const STATUS_COLORS: Record<RoadmapStatus, string> = {
  research: "bg-blue-500/10 text-blue-500 border-blue-500/30",
  "in-design": "bg-violet-500/10 text-violet-500 border-violet-500/30",
  planning: "bg-amber-500/10 text-amber-500 border-amber-500/30",
  backlog: "bg-ink-soft/10 text-ink-soft border-ink-soft/30",
};

const STATUS_LABELS: Record<RoadmapStatus, string> = {
  research: "Research",
  "in-design": "In design",
  planning: "Planning",
  backlog: "Backlog",
};

export default function RoadmapPage() {
  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <header className="px-6 sm:px-10 py-5 flex items-center justify-between gap-3">
        <Link to="/" className="flex items-center gap-3">
          <Logo size={26} compact />
          <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule">
            Roadmap
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <ThemeToggle compact />
          <Link to="/pricing" className="text-[13px] text-ink-soft hover:text-ink">
            Pricing
          </Link>
          <Link to="/" className="text-[13px] text-ink-soft hover:text-ink">
            Home
          </Link>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-[860px] px-5 sm:px-8 py-12">
        <h1 className="text-[34px] sm:text-[40px] font-semibold tracking-tight text-ink">
          Product Roadmap
        </h1>
        <p className="mt-3 text-[14.5px] text-ink-soft max-w-[560px]">
          What we're building. Honest target dates — these slip; we'd rather
          under-promise than refund.
        </p>

        <RoadmapSection title="Q2 2026" entries={Q2_2026} />
        <RoadmapSection title="Q3 2026" entries={Q3_2026} />
        <RoadmapSection title="Backlog (no date yet)" entries={BACKLOG} />

        <div className="mt-14 rounded-xl border border-rule bg-surface p-5 text-center">
          <p className="text-[13.5px] text-ink-soft">
            Need one of these to make a buying decision?{" "}
            <Link to="/contact-sales" className="text-ink underline underline-offset-2">
              Talk to us
            </Link>{" "}
            — early-access for Professional customers.
          </p>
        </div>
      </main>
    </div>
  );
}

function RoadmapSection({
  title,
  entries,
}: {
  title: string;
  entries: RoadmapEntry[];
}) {
  return (
    <section className="mt-10">
      <h2 className="text-[18px] font-semibold text-ink mb-4">{title}</h2>
      <ul className="space-y-3">
        {entries.map((e) => (
          <li
            key={e.title}
            className="rounded-xl border border-rule bg-surface p-4 sm:p-5"
          >
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold text-ink">
                  {e.title}
                </h3>
                <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">
                  {e.description}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span
                  className={
                    "text-[10.5px] uppercase tracking-wider px-2 py-0.5 rounded-full border " +
                    STATUS_COLORS[e.status]
                  }
                >
                  {STATUS_LABELS[e.status]}
                </span>
                {e.tier_target && (
                  <span className="text-[10.5px] text-ink-soft">
                    Target: {e.tier_target}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
