// PeerSuggestRail — the page hero (2026-08-04 PCI redesign).
//
// "Peers pentru compania ta": BVB-listed companies from the same sector
// as the ACTIVE WORKSPACE, auto-suggested, with a one-click "Adaugă ca
// peer" that writes to the existing benchmark-peer store (the same store
// the search panel's peer chips and the Benchmarking groups read).
//
// Renders only when a real uploaded period is loaded AND the workspace's
// industry maps onto a universe sector with at least one BVB candidate —
// without a workspace there is no "compania ta" to suggest peers for.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Check } from "lucide-react";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { addPeer, useBenchmarkPeers } from "@/lib/benchmarkPeersStore";
import { useActivePeriod } from "@/lib/activePeriod";
import { useWorkspaceName } from "@/lib/workspaceName";
import { toast } from "@/hooks/use-toast";
import { CompanyLogo } from "./CompanyLogo";
import { fmtCompactMoney, workspaceIndustryToSector } from "./pciData";
import "./pciI18n";

interface Props {
  rows: PublicCompanyFinancialSnapshot[];
  onSelectTicker: (ticker: string) => void;
}

const MAX_SUGGESTIONS = 6;

export function PeerSuggestRail({ rows, onSelectTicker }: Props) {
  const { t } = useTranslation();
  const period = useActivePeriod();
  const workspaceName = useWorkspaceName();
  const peers = useBenchmarkPeers();

  const loaded =
    period.isLoaded && period.source === "upload" && !!period.statements;
  const industry = period.industry ?? period.statements?.industry ?? null;
  const sector = workspaceIndustryToSector(industry);

  const suggestions = useMemo(() => {
    if (!sector) return [];
    return rows
      .filter((r) => r.exchange === "BVB" && r.sector === sector)
      .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0) || (b.revenue ?? 0) - (a.revenue ?? 0))
      .slice(0, MAX_SUGGESTIONS);
  }, [rows, sector]);

  if (!loaded || !sector || suggestions.length === 0) return null;

  const name = workspaceName || period.statements?.companyName || "—";
  const peerSet = new Set(peers.map((p) => p.ticker));

  const handleAdd = (r: PublicCompanyFinancialSnapshot) => {
    addPeer({
      ticker: r.ticker,
      name: r.companyName,
      sector: r.sector ?? null,
      exchange: r.exchange ?? "BVB",
      currency: r.currency,
    });
    toast({ title: t("pci.rail.added", { ticker: r.ticker.replace(/\.BVB$/, "") }) });
  };

  return (
    <section
      data-testid="peer-suggest-rail"
      className="card-2026 relative overflow-hidden p-4 sm:p-5"
    >
      {/* Brand sleeve — marks the AI-suggested hero, matching the app's
          left-sleeve card convention. */}
      <div className="absolute inset-y-0 left-0 w-1.5 bg-brand" aria-hidden />
      <div className="pl-2">
        <h2 className="font-serif text-[22px] text-ink leading-tight tracking-[-0.005em]">
          {t("pci.rail.title")}
        </h2>
        <p className="mt-1 text-[12.5px] text-ink-soft max-w-[640px]">
          {t("pci.rail.subtitle", { name })}
        </p>

        {/* Suggestion rail — horizontal scroll inside its own container. */}
        <div
          className="
            mt-4 flex gap-2.5 overflow-x-auto pb-1
            [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
          "
        >
          {suggestions.map((r) => {
            const displayTicker = r.ticker.replace(/\.BVB$/, "");
            const isAdded = peerSet.has(r.ticker);
            return (
              <div
                key={r.ticker}
                data-testid={`peer-suggest-${r.ticker}`}
                className="
                  shrink-0 w-[210px] rounded-xl border border-rule bg-bg-2/40
                  p-3 flex flex-col gap-2
                "
              >
                <button
                  type="button"
                  onClick={() => onSelectTicker(r.ticker)}
                  className="flex items-center gap-2.5 min-w-0 text-left"
                >
                  <CompanyLogo
                    ticker={displayTicker}
                    variant="monogram"
                    size={32}
                    className="rounded-lg"
                  />
                  <div className="min-w-0">
                    <div className="font-mono font-semibold text-[12px] text-ink tabular-nums">
                      {displayTicker}
                    </div>
                    <div className="text-[10.5px] text-ink-soft truncate">
                      {r.companyName}
                    </div>
                  </div>
                </button>
                <div className="text-[10.5px] text-ink-mute tabular-nums truncate">
                  {r.industry ?? r.sector}
                  {r.revenue != null && Number.isFinite(r.revenue) && (
                    <> · {fmtCompactMoney(r.revenue, r.currency)}</>
                  )}
                </div>
                {isAdded ? (
                  <span
                    className="
                      inline-flex items-center justify-center gap-1.5 h-9 rounded-lg
                      border border-brand/40 bg-brand/10
                      text-[11.5px] font-medium text-ink
                    "
                  >
                    <Check size={12} strokeWidth={2.5} />
                    {t("pci.rail.inPeers")}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleAdd(r)}
                    data-testid={`peer-suggest-add-${r.ticker}`}
                    className="
                      inline-flex items-center justify-center gap-1.5 h-9 rounded-lg
                      bg-brand text-paper text-[11.5px] font-medium
                      hover:bg-brand-dark transition-colors
                    "
                  >
                    <Plus size={12} strokeWidth={2.5} />
                    {t("pci.rail.add")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
