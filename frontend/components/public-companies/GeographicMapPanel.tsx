// GeographicMapPanel — Romania county (județ) choropleth for the Public
// Company Intelligence page. Port of the "Geographic Map.html" design
// (claude.ai/design 34b6d30f…) into the app's React + token system.
//
// What it does:
//   · Colors each județ by how many listed companies are headquartered
//     there (teal ramp), with a metric bar (companies / market cap /
//     revenue / growth / margin) that re-scores counties — multiple
//     active chips average into a composite score.
//   · Click a covered county → the map zooms to it (CSS transform on the
//     <g>, animated) and the side panel lists its companies sorted by the
//     first value-bearing active metric. Click empty space → zoom out.
//   · Company row click bubbles up via onSelectTicker so the page opens
//     the existing StockDetailDrawer.
//
// Implementation notes:
//   · d3-geo (projection + path) and topojson-client only — no full d3
//     bundle, no d3-zoom (click-to-focus covers the design's core
//     interaction; wheel-zoom was dropped deliberately).
//   · Geometry is served from OUR origin (/geo/*.json, checked into
//     public/) — no runtime CDN dependency. Romania counties: GADM via
//     Natural Earth-style geojson (42 features incl. București);
//     neighbours: world-atlas 110m with Romania removed.
//   · Companies are placed via BVB_HQ_COUNTY (ticker → județ). Unmapped
//     tickers simply don't appear; the panel footer says so.
//   · Values are RON (the universe is BVB-only) — formatted compactly
//     ("1.2B"), labeled RON in the legend area, deliberately NOT via the
//     currency toggle (a choropleth legend can't re-render per toggle
//     without bespoke plumbing; the detail drawer shows toggled values).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { geoMercator, geoPath, type GeoPermissibleObjects } from "d3-geo";
import { feature as topoFeature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { MapPin, ArrowLeft } from "lucide-react";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { CompanyLogo } from "./CompanyLogo";
import { BVB_HQ_COUNTY, normCounty } from "./bvbHqCounties";
import { staticBvbRows } from "@/lib/bvbStaticUniverse";

interface Props {
  rows: PublicCompanyFinancialSnapshot[];
  onSelectTicker: (ticker: string) => void;
}

// ── Formatting (RON, compact) ────────────────────────────────────────────
const fmtRon = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return `${v.toFixed(0)}`;
};
const fmtPct = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
const fmtInt = (v: number | null | undefined): string =>
  v == null ? "—" : `${Math.round(v)}`;

const mean = (a: Array<number | null | undefined>): number | null => {
  const f = a.filter((x): x is number => x != null && Number.isFinite(x));
  return f.length ? f.reduce((s, x) => s + x, 0) / f.length : null;
};
const sum = (a: Array<number | null | undefined>): number =>
  a.filter((x): x is number => x != null && Number.isFinite(x)).reduce((s, x) => s + x, 0);

// ── Metrics ──────────────────────────────────────────────────────────────
type Row = PublicCompanyFinancialSnapshot;
interface MetricDef {
  label: string;
  higher: boolean;
  agg: (cos: Row[]) => number | null;
  fmt: (v: number | null) => string;
  co: ((c: Row) => number | null | undefined) | null;
  cofmt?: (v: number | null | undefined) => string;
  unit?: string;
}
const METRICS: Record<string, MetricDef> = {
  count: { label: "Companies", higher: true, agg: (c) => c.length, fmt: fmtInt, co: null },
  mktcap: { label: "Market cap", higher: true, agg: (c) => sum(c.map((x) => x.marketCap)) || null, fmt: fmtRon, co: (c) => c.marketCap, cofmt: fmtRon, unit: "RON" },
  revenue: { label: "Revenue", higher: true, agg: (c) => sum(c.map((x) => x.revenue)) || null, fmt: fmtRon, co: (c) => c.revenue, cofmt: fmtRon, unit: "RON" },
  growth: { label: "Rev. growth", higher: true, agg: (c) => mean(c.map((x) => x.revenueGrowth)), fmt: fmtPct, co: (c) => c.revenueGrowth, cofmt: fmtPct },
  margin: { label: "Net margin", higher: true, agg: (c) => mean(c.map((x) => x.netMargin)), fmt: fmtPct, co: (c) => c.netMargin, cofmt: fmtPct },
};
const METRIC_ORDER = ["count", "mktcap", "revenue", "growth", "margin"] as const;

// ── Map colors (fixed light ramp — reads as "map" in both themes) ────────
// Constraint: these are DATA-scale literals painted into SVG `fill`
// attributes; a CSS-var token cannot be interpolated in JS, so the ramp
// endpoints are pinned here — to the Paper accent (verified green-teal),
// replacing the retired bright teal.
const EMPTY_FILL = "hsl(var(--bg-2))";
// Listings exist but the active metric has no figure — a distinct
// honest state between "no companies" and the value ramp.
const LISTED_NO_DATA_FILL = "hsl(var(--surface-hi))";
const rampAt = (t: number): string => {
  // E7F5F2 → 0E7C6B (brand ramp, light stop → accent)
  const a = [0xe7, 0xf5, 0xf2];
  const b = [0x0e, 0x7c, 0x6b];
  const c = a.map((av, i) => Math.round(av + (b[i] - av) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

type CountyFeature = Feature<Geometry> & { ckey: string; display: string };

export function GeographicMapPanel({ rows: liveRows, onSelectTicker }: Props) {
  // Fall back to the bundled static BVB list while the universe fetch is
  // loading/failing, so the map is never blank (financial metrics render
  // "—" on static rows; company count still colors the counties).
  const rows = liveRows.length > 0 ? liveRows : staticBvbRows();
  const [counties, setCounties] = useState<CountyFeature[] | null>(null);
  const [neighbours, setNeighbours] = useState<Feature<Geometry>[]>([]);
  const [geoError, setGeoError] = useState(false);
  // ONE metric at a time (radio). The old multi-chip "composite score"
  // averaged normalized metrics into an opaque 0-100 — and scored a
  // county with NO data 0.5, ranking it above real below-median values.
  // Default is Companies: the only metric complete for every county, so
  // the first paint never shows a wall of dashes.
  const [metric, setMetric] = useState<string>("count");
  const [selected, setSelected] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; html: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 560 });

  // ── Geometry load (from our own origin) ──
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/geo/romania-counties.geojson").then((r) => r.json()),
      fetch("/geo/countries-110m.json").then((r) => r.json()),
    ])
      .then(([cgeo, wtopo]: [FeatureCollection, Topology]) => {
        if (cancelled) return;
        const cf = cgeo.features.map((f) => {
          const raw = String(
            (f.properties as Record<string, unknown>)?.NAME_1 ??
              (f.properties as Record<string, unknown>)?.name ??
              "",
          );
          const ckey = normCounty(raw);
          // Prefer the proper Romanian display name from the HQ table.
          const display =
            Object.values(BVB_HQ_COUNTY).find((n) => normCounty(n) === ckey) ?? raw;
          return Object.assign(f, { ckey, display }) as CountyFeature;
        });
        const world = topoFeature(
          wtopo,
          wtopo.objects.countries as GeometryCollection,
        ) as unknown as FeatureCollection;
        setNeighbours(world.features.filter((f) => String(f.id) !== "642"));
        setCounties(cf);
      })
      .catch(() => !cancelled && setGeoError(true));
    return () => { cancelled = true; };
  }, []);

  // ── Responsive size ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setSize({ w: r.width, h: Math.max(480, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Companies by county ──
  const byCounty = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const county = BVB_HQ_COUNTY[r.ticker];
      if (!county) continue;
      const key = normCounty(county);
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r);
    }
    return m;
  }, [rows]);
  const mappedCount = useMemo(
    () => rows.filter((r) => BVB_HQ_COUNTY[r.ticker]).length,
    [rows],
  );

  // ── The active metric's VALUE per county (no normalization games) ──
  const countyValues = useMemo(() => {
    const m = METRICS[metric];
    const out = new Map<string, number | null>();
    for (const [cc, cos] of byCounty) out.set(cc, m.agg(cos));
    return out;
  }, [metric, byCounty]);

  const reportingCount = useMemo(
    () => [...countyValues.values()].filter((v) => v != null).length,
    [countyValues],
  );

  // Normalized 0..1 among VALUE-BEARING counties only — drives fill and
  // the row bars. A county without data is simply not on this scale.
  const valueFraction = useCallback(
    (cc: string): number | null => {
      const v = countyValues.get(cc);
      if (v == null) return null;
      const nums = [...countyValues.values()].filter(
        (x): x is number => x != null,
      );
      const lo = Math.min(...nums), hi = Math.max(...nums);
      if (hi === lo) return 1;
      const n = (v - lo) / (hi - lo);
      return METRICS[metric].higher ? n : 1 - n;
    },
    [countyValues, metric],
  );

  // ── Projection / paths ──
  const { pathFor, transform } = useMemo(() => {
    if (!counties) return { pathFor: null, transform: "" };
    const fc: FeatureCollection = { type: "FeatureCollection", features: counties };
    const mx = Math.max(48, size.w * 0.18), my = Math.max(40, size.h * 0.13);
    const projection = geoMercator();
    projection.fitExtent(
      [[mx, my], [size.w - mx, size.h - my]],
      fc as GeoPermissibleObjects,
    );
    const p = geoPath(projection);
    let t = "";
    if (selected) {
      const f = counties.find((c) => c.ckey === selected);
      if (f) {
        const [[x0, y0], [x1, y1]] = p.bounds(f as GeoPermissibleObjects);
        const dx = Math.max(1, x1 - x0), dy = Math.max(1, y1 - y0);
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const k = Math.min(9, 0.55 * Math.min(size.w / dx, size.h / dy));
        t = `translate(${size.w / 2 - k * cx}px, ${size.h / 2 - k * cy}px) scale(${k})`;
      }
    }
    return { pathFor: p, transform: t };
  }, [counties, size, selected]);

  // ── Fill color: the ACTIVE metric drives the choropleth. The old map
  // always colored by company count, so switching "Score by" recolored
  // nothing — the control looked broken. A county with listings but no
  // figure for this metric gets its own honest state (never the ramp,
  // never the empty fill).
  const fillFor = useCallback(
    (ckey: string): string => {
      const cos = byCounty.get(ckey);
      if (!cos?.length) return EMPTY_FILL;
      const t = valueFraction(ckey);
      if (t == null) return LISTED_NO_DATA_FILL;
      return rampAt(0.22 + 0.78 * t);
    },
    [byCounty, valueFraction],
  );

  const showTipFor = useCallback(
    (f: CountyFeature, e: React.MouseEvent) => {
      const cos = byCounty.get(f.ckey) ?? [];
      const m = METRICS[metric];
      const lines = cos.length
        ? `<span class="opacity-60">${m.label}</span> ${m.fmt(m.agg(cos))}`
        : `<span class="opacity-60">No listed companies</span>`;
      const count = cos.length
        ? `<span class="opacity-60">${cos.length} listed compan${cos.length > 1 ? "ies" : "y"}</span><br>`
        : "";
      setTip({ x: e.clientX, y: e.clientY, html: `<b>${f.display}</b><br>${count}${lines}` });
    },
    [byCounty, metric],
  );

  // ── Panel data ── value-bearing counties by value, then the no-data
  // tail by listing count. The two groups never interleave: a county
  // with no figure must not outrank one with a real below-median figure
  // (the old null->0.5 normalization did exactly that — "Botoșani, —"
  // above a county with an actual number, under a "Ranked by Market
  // cap" heading).
  const covered = useMemo(() => {
    const m = METRICS[metric];
    return [...byCounty.keys()].sort((a, b) => {
      const va = countyValues.get(a), vb = countyValues.get(b);
      if (va != null && vb != null) return m.higher ? vb - va : va - vb;
      if (va != null) return -1;
      if (vb != null) return 1;
      return byCounty.get(b)!.length - byCounty.get(a)!.length;
    });
  }, [byCounty, countyValues, metric]);
  const displayOf = useCallback(
    (ckey: string) =>
      counties?.find((c) => c.ckey === ckey)?.display ??
      Object.values(BVB_HQ_COUNTY).find((n) => normCounty(n) === ckey) ??
      ckey,
    [counties],
  );

  if (geoError) {
    return (
      <div className="rounded-2xl border border-rule bg-surface p-10 text-center text-ink-soft">
        Could not load the map geometry. Reload the page to try again.
      </div>
    );
  }

  const selCos = selected ? byCounty.get(selected) ?? [] : [];
  const detailKey = METRICS[metric].co ? metric : "mktcap";
  const detailMetric = METRICS[detailKey];
  const sortedSel = [...selCos].sort(
    (a, b) => (detailMetric.co?.(b) ?? -1e18) - (detailMetric.co?.(a) ?? -1e18),
  );

  return (
    <div className="space-y-4" data-testid="geographic-map">
      {/* ── Toolbar: metric chips + legend ── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-ink-mute mr-1">
            Score by
          </span>
          {METRIC_ORDER.map((k) => {
            const on = metric === k;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setMetric(k)}
                className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-[12.5px] font-medium transition-colors ${
                  on
                    ? "bg-brand border-brand text-paper font-semibold"
                    : "border-rule bg-surface text-ink-soft hover:text-ink hover:border-ink-mute/50"
                }`}
              >
                {METRICS[k].label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-4">
          <div className="flex flex-col gap-1">
            <div
              className="w-[150px] h-[9px] rounded-md border border-rule"
              style={{ background: `linear-gradient(90deg,${rampAt(0.22)},${rampAt(0.6)},${rampAt(1)})` }}
            />
            <div className="flex justify-between text-[10.5px] text-ink-mute">
              <span>Lower</span>
              <span>{METRICS[metric].label}</span>
              <span>Higher</span>
            </div>
          </div>
          {reportingCount < covered.length && (
            <div className="flex items-center gap-1.5 text-[11px] text-ink-mute">
              <i className="inline-block w-[13px] h-[13px] rounded-[3px] border" style={{ background: LISTED_NO_DATA_FILL, borderColor: "hsl(var(--rule))" }} />
              Listed · no data
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[11px] text-ink-mute">
            <i className="inline-block w-[13px] h-[13px] rounded-[3px] border" style={{ background: EMPTY_FILL, borderColor: "hsl(var(--rule))" }} />
            No listings
          </div>
        </div>
      </div>

      {/* ── Map + panel ── */}
      <div className="flex gap-4 flex-col lg:flex-row min-h-[560px]">
        <div
          ref={wrapRef}
          className="relative flex-1 min-w-0 min-h-[480px] overflow-hidden rounded-md border border-rule bg-surface"
        >
          {!counties ? (
            <div className="absolute inset-0 flex items-center justify-center text-ink-mute text-[13px]">
              Loading map…
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${size.w} ${size.h}`}
              className="block w-full h-full"
              onClick={(e) => {
                if (!(e.target as Element).closest("[data-county]")) setSelected(null);
              }}
            >
              <g
                style={{
                  transform: transform || undefined,
                  transformOrigin: "0 0",
                  transition: "transform var(--dur-3, 320ms) var(--ease-quint)",
                }}
              >
                {pathFor &&
                  neighbours.map((f, i) => (
                    <path
                      key={`n${i}`}
                      d={pathFor(f as GeoPermissibleObjects) ?? undefined}
                      fill="hsl(var(--bg-2))"
                      stroke="hsl(var(--surface))"
                      strokeWidth={0.5}
                      style={{ vectorEffect: "non-scaling-stroke" }}
                      pointerEvents="none"
                    />
                  ))}
                {pathFor &&
                  counties.map((f) => {
                    const has = (byCounty.get(f.ckey)?.length ?? 0) > 0;
                    const isSel = f.ckey === selected;
                    return (
                      <path
                        key={f.ckey}
                        data-county={f.ckey}
                        d={pathFor(f as GeoPermissibleObjects) ?? undefined}
                        fill={fillFor(f.ckey)}
                        stroke={isSel ? "hsl(var(--ink))" : "hsl(var(--surface))"}
                        strokeWidth={isSel ? 1.6 : 0.5}
                        className={has ? "cursor-pointer hover:stroke-brand-dark" : ""}
                        style={{ vectorEffect: "non-scaling-stroke", transition: "fill .3s ease" }}
                        onMouseMove={(e) => showTipFor(f, e)}
                        onMouseLeave={() => setTip(null)}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (has) setSelected(f.ckey);
                          else setSelected(null);
                        }}
                      />
                    );
                  })}
              </g>
            </svg>
          )}
          <div className="absolute left-3.5 bottom-3 text-[11px] text-ink-mute bg-surface/85 backdrop-blur px-2.5 py-1.5 rounded-lg border border-rule-soft pointer-events-none">
            Click a județ to zoom in · click empty space to zoom back out
          </div>
        </div>

        {/* ── Side panel ── */}
        <aside className="w-full lg:w-[372px] shrink-0 flex flex-col overflow-hidden max-h-[720px] rounded-md border border-rule bg-surface">
          {!selected ? (
            <>
              <div className="px-4 pt-4 pb-3.5 border-b border-rule-soft">
                <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-mute">
                  Romania · {counties?.length ?? "—"} județe · {covered.length} with listings
                </div>
                <div className="text-[15px] font-semibold mt-0.5 text-ink">
                  Ranked by {METRICS[metric].label}
                </div>
                {reportingCount < covered.length && (
                  <div className="text-[11px] text-ink-mute mt-0.5">
                    {reportingCount} of {covered.length} counties report{" "}
                    {METRICS[metric].label.toLowerCase()} · the rest rank by
                    listings
                  </div>
                )}
              </div>
              <div className="overflow-y-auto flex-1 px-2.5 py-1.5">
                {covered.map((cc) => {
                  const cos = byCounty.get(cc)!;
                  const frac = valueFraction(cc);
                  const s = frac == null ? 0 : Math.round(frac * 100);
                  const primary = METRICS[metric].fmt(countyValues.get(cc) ?? null);
                  return (
                    <button
                      key={cc}
                      type="button"
                      onClick={() => setSelected(cc)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-bg-2 text-left"
                    >
                      <span className="w-[34px] h-[34px] shrink-0 rounded-[9px] bg-brand-tint text-brand-dark flex items-center justify-center">
                        <MapPin size={17} strokeWidth={2} />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block font-semibold text-[13.5px] text-ink">{displayOf(cc)}</span>
                        <span className="block text-[11.5px] text-ink-mute">
                          {cos.length} listed compan{cos.length > 1 ? "ies" : "y"}
                        </span>
                        <span className="block h-1.5 rounded bg-bg-2 mt-1.5 overflow-hidden">
                            <span
                            className={`block h-full rounded ${frac == null ? "bg-ink-faint/40" : "bg-brand"}`}
                            style={{ width: `${frac == null ? 4 : Math.max(6, s)}%` }}
                          />
                        </span>
                      </span>
                      <span className="tabular-nums font-semibold text-[13px] text-ink text-right">{primary}</span>
                    </button>
                  );
                })}
                <div className="px-4 py-4 text-center text-[12px] leading-relaxed text-ink-mute">
                  Counties with no mapped headquarters are muted. Companies are placed by the
                  county of their head office — {mappedCount} of {rows.length} BVB-listed
                  companies are mapped.
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="px-4 pt-4 pb-3.5 border-b border-rule-soft">
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-rule text-[12px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2 mb-2.5"
                >
                  <ArrowLeft size={13} strokeWidth={2.2} /> All județe
                </button>
                <div className="flex items-center gap-3">
                  <span className="w-[34px] h-[34px] shrink-0 rounded-[9px] bg-brand-tint text-brand-dark flex items-center justify-center">
                    <MapPin size={18} strokeWidth={2} />
                  </span>
                  <div>
                    <div className="text-[16px] font-semibold leading-tight text-ink">{displayOf(selected)}</div>
                    <div className="text-[11.5px] text-ink-mute">
                      Județ · {selCos.length} listed compan{selCos.length > 1 ? "ies" : "y"}
                    </div>
                  </div>
                  <div className="ml-auto text-right">
                    <div className="font-mono text-[22px] font-medium tabular-nums leading-none text-brand-dark">
                      {METRICS[metric].fmt(countyValues.get(selected) ?? null)}
                    </div>
                    <div className="text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">
                      {METRICS[metric].label}
                      {METRICS[metric].unit ? ` · ${METRICS[metric].unit}` : ""}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-px bg-rule-soft border border-rule-soft rounded-[10px] overflow-hidden mt-3">
                  {METRIC_ORDER.filter((k) => k !== "count").map((k) => (
                    <div key={k} className="bg-surface px-2.5 py-2">
                      <div className="text-[10px] uppercase tracking-[0.04em] text-ink-mute">
                        {METRICS[k].label}
                        {METRICS[k].unit ? ` (${METRICS[k].unit})` : ""}
                      </div>
                      <div className="text-[15px] font-semibold mt-0.5 tabular-nums text-ink">
                        {METRICS[k].fmt(METRICS[k].agg(selCos))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="overflow-y-auto flex-1 px-2.5 py-1.5">
                <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-mute px-3 pt-3 pb-1.5">
                  Companies · sorted by {detailMetric.label}
                </div>
                {sortedSel.map((c) => (
                  <button
                    key={c.ticker}
                    type="button"
                    onClick={() => onSelectTicker(c.ticker)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-bg-2 text-left"
                  >
                    <CompanyLogo ticker={c.ticker} variant="monogram" size={30} />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-baseline gap-1.5">
                        <span className="font-semibold text-[12.5px] text-ink truncate">
                          {c.companyName}
                        </span>
                        <span className="text-[11px] text-ink-mute font-medium shrink-0">
                          {c.ticker}
                        </span>
                      </span>
                      <span className="block text-[11px] text-ink-mute truncate">
                        {c.sector ?? "—"}
                      </span>
                    </span>
                    <span className="text-right tabular-nums">
                      <span className="block font-semibold text-[12.5px] text-ink">
                        {detailMetric.cofmt?.(detailMetric.co?.(c)) ?? "—"}
                      </span>
                      <span className="block text-[10px] text-ink-mute">{detailMetric.label}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>

      {/* ── Tooltip ── */}
      {tip && (
        <div
          className="fixed z-50 pointer-events-none bg-ink text-bg px-2.5 py-1.5 rounded-lg text-[11.5px] leading-snug shadow-lg max-w-[230px]"
          style={{
            left: Math.min(tip.x + 14, window.innerWidth - 240),
            top: Math.min(tip.y + 14, window.innerHeight - 90),
          }}
          dangerouslySetInnerHTML={{ __html: tip.html }}
        />
      )}
    </div>
  );
}
