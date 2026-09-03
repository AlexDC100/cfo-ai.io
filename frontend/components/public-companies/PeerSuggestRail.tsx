// PeerSuggestRail — peers suggested for the active workspace.
//
// "Peers pentru compania ta": BVB-listed companies from the same sector
// as the ACTIVE WORKSPACE, auto-suggested, with a one-click "Adaugă ca
// peer" that writes to the existing benchmark-peer store (the same store
// the search panel's peer chips and the Benchmarking groups read).
//
// Renders only when a real uploaded period is loaded AND the workspace's
// industry maps onto a universe sector with at least one BVB candidate —
// without a workspace there is no "compania ta" to suggest peers for.
//
// THE INSTRUMENT (B5): the brand-sleeve serif hero became a Panel with
// the standard caps header; each suggestion is a hairline tile with the
// ticker as a mono accent block, the key figure through <Amount>, and a
// quiet "Add as peer" button whose added state is a success Chip.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Check } from "lucide-react";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { addPeer, useBenchmarkPeers } from "@/lib/benchmarkPeersStore";
import { useActivePeriod } from "@/lib/activePeriod";
import { useWorkspaceName } from "@/lib/workspaceName";
import { toast } from "@/hooks/use-toast";
import { Amount } from "@/components/instrument/Amount";
import { provenanceOf } from "@/components/instrument/Provenance";
import { Chip, Panel, PanelHeader } from "@/components/instrument/Panel";
import { pickMagnitude } from "@/lib/amountFormat";
import { workspaceIndustryToSector } from "./pciData";
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
    <Panel data-testid="peer-suggest-rail">
      <PanelHeader title={t("pci.rail.title")} />
      <div className="px-4 py-3">
        <p className="text-[12px] text-ink-soft max-w-[640px]">
          {t("pci.rail.subtitle", { name })}
        </p>

        {/* Suggestion rail — horizontal scroll inside its own container. */}
        <div
          className="
            mt-3 flex gap-3 overflow-x-auto pb-1
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
                  shrink-0 w-[212px] rounded-md border border-rule bg-surface
                  p-3 flex flex-col gap-2
                "
              >
                <button
                  type="button"
                  onClick={() => onSelectTicker(r.ticker)}
                  className="flex items-center gap-2.5 min-w-0 text-left"
                >
                  {/* Ticker as a mono accent block — the tile's identity. */}
                  <span
                    className="
                      grid h-8 min-w-8 shrink-0 place-items-center rounded-sm
                      bg-brand-tint px-1.5
                      font-mono text-[11px] font-medium tabular-nums text-brand-dark
                    "
                  >
                    {displayTicker}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-ink truncate">
                      {r.companyName}
                    </div>
                    <div className="text-[10.5px] text-ink-mute truncate">
                      {r.industry ?? r.sector}
                    </div>
                  </div>
                </button>
                {r.revenue != null && Number.isFinite(r.revenue) && (
                  <div className="flex items-baseline justify-between gap-2 border-t border-rule-soft pt-2 text-[11px]">
                    <span className="uppercase tracking-[0.08em] text-[9.5px] text-ink-mute">
                      {t("pci.compare.row.revenue")}
                    </span>
                    {/* No inline currency on magnitude-scaled figures — the
                        page header's RON chip declares the unit once. */}
                    {/* The snapshot names its own origin: `source` (the universe
                        feed — "demo" is stated as plainly as "nasdaq"), the
                        fiscal period the figure belongs to, and when the row
                        was last refreshed. Nothing else is in the payload. */}
                    <Amount
                      value={r.revenue}
                      magnitude={pickMagnitude([r.revenue])}
                      className="text-[11.5px] text-ink"
                      provenance={provenanceOf({
                        source: r.source,
                        period: r.latestPeriod ?? undefined,
                        computedAt: r.lastUpdated,
                      })}
                    />
                  </div>
                )}
                {isAdded ? (
                  <span className="inline-flex justify-center">
                    <Chip tone="success" data-testid={`peer-suggest-added-${r.ticker}`}>
                      <Check size={11} strokeWidth={2.5} />
                      {t("pci.rail.inPeers")}
                    </Chip>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleAdd(r)}
                    data-testid={`peer-suggest-add-${r.ticker}`}
                    className="
                      inline-flex items-center justify-center gap-1.5 h-8 rounded-sm
                      border border-rule text-[11.5px] font-medium text-ink
                      hover:border-rule-strong hover:bg-bg-2 transition-colors duration-micro
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
    </Panel>
  );
}
