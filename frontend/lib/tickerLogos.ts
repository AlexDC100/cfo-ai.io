// Ticker → primary-domain map for company logo lookup.
//
// Used by <CompanyLogo /> to build a logo-image URL from the domain.
//
// 2026-07-24 — this used to build a Clearbit logo URL
// (`https://logo.clearbit.com/<domain>`). Clearbit's free Logo API was
// deprecated 2025-03-18 and permanently shut down 2025-12-08 (see
// https://developers.hubspot.com/changelog/upcoming-sunset-of-clearbits-free-logo-api).
// `logo.clearbit.com` no longer resolves in DNS at all — every logo on
// this page (all ~200 US tickers below, not just the newly-added BVB
// ones) had been silently falling back to the letter avatar since
// then. Found while adding the 88 BVB tickers below.
//
// Swapped to Google's favicon service (`google.com/s2/favicons`) —
// free, no signup/API key, no rate-limit wall. Image quality is
// favicon-grade (lower fidelity than a dedicated logo API), which is
// an acceptable tradeoff for a 28-40px chip. The alternative (logo.dev,
// Clearbit's suggested successor) requires creating an account and
// shipping an API token — not something to add without asking; revisit
// if logo quality becomes a real complaint.
//
// Caveat found 2026-07-24: for a domain with no real favicon, Google's
// endpoint doesn't reliably error — it can substitute its own generic
// "no icon found" glyph (a plain globe) and still render successfully,
// so <CompanyLogo />'s onError fallback doesn't always catch it. There's
// no CORS-safe way to distinguish "real tiny favicon" from "Google's
// generic globe" client-side (both can come back as small, oddly-sized
// images — confirmed by inspecting actual response bytes, not guessing).
// Worse: the response is flaky per-domain — the same URL flipped between
// 200 (globe placeholder) and 404 across back-to-back requests during
// verification (arobs.com did this twice), so "it 404s right now" isn't
// a signal to trust either. The fix is manual and conservative: any
// domain observed returning a non-2xx / placeholder response even once
// is left out of TICKER_DOMAINS entirely (19 of the 88 BVB tickers, see
// the "no favicon" comment block below) rather than risk it flipping to
// the globe placeholder in production. Letter avatar > maybe-a-logo.
//
// Maintenance: add entries as the universe grows. The map is keyed on
// the ticker (uppercase). Tickers with periods (e.g. "BRK.B") use
// the same domain as the unsuffixed share class.

export const TICKER_DOMAINS: Record<string, string> = {
  // Mega-cap tech
  AAPL: "apple.com",
  MSFT: "microsoft.com",
  GOOGL: "google.com",
  GOOG: "google.com",
  AMZN: "amazon.com",
  META: "meta.com",
  NVDA: "nvidia.com",
  TSLA: "tesla.com",
  AVGO: "broadcom.com",
  ORCL: "oracle.com",
  CRM: "salesforce.com",
  ADBE: "adobe.com",
  NFLX: "netflix.com",
  CSCO: "cisco.com",
  IBM: "ibm.com",
  INTC: "intel.com",
  AMD: "amd.com",
  QCOM: "qualcomm.com",
  TXN: "ti.com",
  MU: "micron.com",
  AMAT: "appliedmaterials.com",
  LRCX: "lamresearch.com",
  KLAC: "kla.com",
  ASML: "asml.com",
  NOW: "servicenow.com",
  INTU: "intuit.com",
  WDAY: "workday.com",
  PANW: "paloaltonetworks.com",
  CRWD: "crowdstrike.com",
  SNOW: "snowflake.com",
  PLTR: "palantir.com",
  SHOP: "shopify.com",
  SQ: "block.xyz",
  PYPL: "paypal.com",
  COIN: "coinbase.com",
  UBER: "uber.com",
  LYFT: "lyft.com",
  ABNB: "airbnb.com",
  BKNG: "booking.com",
  SPOT: "spotify.com",
  ROKU: "roku.com",
  ZM: "zoom.us",
  DOCU: "docusign.com",

  // Financials
  "BRK.A": "berkshirehathaway.com",
  "BRK.B": "berkshirehathaway.com",
  JPM: "jpmorganchase.com",
  BAC: "bankofamerica.com",
  WFC: "wellsfargo.com",
  C: "citigroup.com",
  GS: "goldmansachs.com",
  MS: "morganstanley.com",
  BLK: "blackrock.com",
  AXP: "americanexpress.com",
  V: "visa.com",
  MA: "mastercard.com",
  SCHW: "schwab.com",
  USB: "usbank.com",
  PNC: "pnc.com",
  TFC: "truist.com",
  COF: "capitalone.com",
  AIG: "aig.com",
  MET: "metlife.com",
  PRU: "prudential.com",
  ALL: "allstate.com",
  TRV: "travelers.com",
  CB: "chubb.com",
  SPGI: "spglobal.com",
  ICE: "ice.com",
  CME: "cmegroup.com",
  MCO: "moodys.com",
  MSCI: "msci.com",

  // Healthcare
  UNH: "unitedhealthgroup.com",
  JNJ: "jnj.com",
  PFE: "pfizer.com",
  LLY: "lilly.com",
  ABBV: "abbvie.com",
  MRK: "merck.com",
  TMO: "thermofisher.com",
  ABT: "abbott.com",
  DHR: "danaher.com",
  BMY: "bms.com",
  CVS: "cvshealth.com",
  AMGN: "amgen.com",
  GILD: "gilead.com",
  BIIB: "biogen.com",
  MDT: "medtronic.com",
  ISRG: "intuitivesurgical.com",
  SYK: "stryker.com",
  ZTS: "zoetis.com",
  REGN: "regeneron.com",
  VRTX: "vrtx.com",
  MRNA: "modernatx.com",
  HUM: "humana.com",
  ELV: "elevancehealth.com",
  CI: "thecignagroup.com",

  // Consumer
  WMT: "walmart.com",
  HD: "homedepot.com",
  LOW: "lowes.com",
  COST: "costco.com",
  TGT: "target.com",
  TJX: "tjx.com",
  NKE: "nike.com",
  LULU: "lululemon.com",
  SBUX: "starbucks.com",
  MCD: "mcdonalds.com",
  YUM: "yum.com",
  CMG: "chipotle.com",
  DIS: "disney.com",
  PG: "pg.com",
  KO: "coca-colacompany.com",
  PEP: "pepsico.com",
  MDLZ: "mondelezinternational.com",
  PM: "pmi.com",
  MO: "altria.com",
  KMB: "kimberly-clark.com",
  CL: "colgatepalmolive.com",
  EL: "elcompanies.com",
  F: "ford.com",
  GM: "gm.com",

  // Industrials
  BA: "boeing.com",
  CAT: "caterpillar.com",
  GE: "ge.com",
  MMM: "3m.com",
  HON: "honeywell.com",
  LMT: "lockheedmartin.com",
  RTX: "rtx.com",
  NOC: "northropgrumman.com",
  GD: "gd.com",
  UPS: "ups.com",
  FDX: "fedex.com",
  UNP: "up.com",
  CSX: "csx.com",
  NSC: "norfolksouthern.com",
  DE: "deere.com",
  ETN: "eaton.com",
  EMR: "emerson.com",
  ITW: "itw.com",
  PH: "parker.com",

  // Energy
  XOM: "exxonmobil.com",
  CVX: "chevron.com",
  COP: "conocophillips.com",
  SLB: "slb.com",
  EOG: "eogresources.com",
  MPC: "marathonpetroleum.com",
  PSX: "phillips66.com",
  OXY: "oxy.com",
  PXD: "pxd.com",
  VLO: "valero.com",
  KMI: "kindermorgan.com",
  WMB: "williams.com",
  ENB: "enbridge.com",

  // Utilities
  NEE: "nexteraenergy.com",
  DUK: "duke-energy.com",
  SO: "southerncompany.com",
  D: "dominionenergy.com",
  AEP: "aep.com",
  SRE: "sempra.com",
  XEL: "xcelenergy.com",
  EXC: "exeloncorp.com",

  // Communication
  T: "att.com",
  VZ: "verizon.com",
  TMUS: "t-mobile.com",
  CMCSA: "corporate.comcast.com",
  CHTR: "corporate.charter.com",

  // Materials
  LIN: "linde.com",
  APD: "airproducts.com",
  ECL: "ecolab.com",
  SHW: "sherwin-williams.com",
  DOW: "dow.com",
  DD: "dupont.com",
  FCX: "fcx.com",
  NEM: "newmont.com",
  NUE: "nucor.com",

  // Real Estate
  PLD: "prologis.com",
  AMT: "americantower.com",
  CCI: "crowncastle.com",
  EQIX: "equinix.com",
  PSA: "publicstorage.com",
  O: "realtyincome.com",
  WELL: "welltower.com",
  SPG: "simon.com",

  // BVB tickers are NOT in this map — they use the bundled high-res
  // assets in BVB_LOCAL_LOGOS below (2026-07-24). The Google-favicon
  // route was tried first for all 88 and abandoned: 128px max is useless
  // for the large logo-background tiles, and the endpoint's per-domain
  // flakiness/globe-placeholder behavior (see the caveat in the header)
  // made 19 of them unusable outright.
};

// ── BVB — bundled high-resolution logos (2026-07-24) ────────────────────
// Self-hosted under public/logos/bvb/ and served same-origin at
// /logos/bvb/<file>. Sourced by three parallel research agents from
// Wikimedia Commons, the companies' own sites/press assets, and BVB's
// issuer-profile logo endpoint (bvb.ro Logo.ashx?s=<ticker> — serves
// company-provided logos, several at high res). Every file was verified
// as a real image AND visually inspected against the company identity —
// that inspection caught four wrong-company downloads (e.g. mfcapital.ro
// serving an unrelated "Wellness Club" logo) that URL-level sourcing
// alone would have shipped. Formats: SVG where one exists (23), else the
// largest official raster (target ≥400px, floor ~200px).
//
// Missing on purpose (4 of 88, letter avatar renders instead): BUCV,
// CNTE, PTR, AAG — no official asset above ~196px exists anywhere
// (company site, Commons, Wikipedia, press PDFs, and BVB's issuer
// endpoint all checked). Re-source if these companies ever rebrand.
export const BVB_LOCAL_LOGOS: Record<string, string> = {
  TLV: "TLV.svg",
  BRD: "BRD.svg",
  FP: "FP.png",
  SNP: "SNP.png",
  SNG: "SNG.png",
  TGN: "TGN.svg",
  PE: "PE.svg",
  H2O: "H2O.webp",
  SNN: "SNN.svg",
  "EL.BVB": "EL_BVB.png",
  TEL: "TEL.svg",
  DIGI: "DIGI.svg",
  M: "M.svg",
  ATB: "ATB.webp",
  CFH: "CFH.png",
  AQ: "AQ.webp",
  SFG: "SFG.png",
  TTS: "TTS.webp",
  ONE: "ONE.webp",
  TRP: "TRP.svg",
  BRK: "BRK.png",
  EAI: "EAI.png",
  OIL: "OIL.png",
  ROC1: "ROC1.png",
  IMP: "IMP.png",
  TRIP: "TRIP.png",
  AROBS: "AROBS.png",
  COTE: "COTE.png",
  PBK: "PBK.svg",
  ALT: "ALT.png",
  SNO: "SNO.webp",
  "STZ.BVB": "STZ_BVB.webp",
  CRC: "CRC.svg",
  BVB: "BVB.webp",
  LONG: "LONG.png",
  CMP: "CMP.png",
  TBK: "TBK.svg",
  ARS: "ARS.png",
  LION: "LION.png",
  IARV: "IARV.png",
  VNC: "VNC.webp",
  RMAH: "RMAH.svg",
  EVER: "EVER.png",
  WINE: "WINE.svg",
  ENP: "ENP.jpg",
  BRM: "BRM.webp",
  EFO: "EFO.svg",
  SMTL: "SMTL.svg",
  COMI: "COMI.webp",
  BNET: "BNET.png",
  TRANSI: "TRANSI.svg",
  EBS: "EBS.svg",
  BIO: "BIO.png",
  SAFE: "SAFE.png",
  ROCE: "ROCE.jpg",
  RPH: "RPH.webp",
  RRC: "RRC.png",
  CMF: "CMF.png",
  INFINITY: "INFINITY.png",
  PREB: "PREB.jpg",
  ALR: "ALR.svg",
  ALU: "ALU.svg",
  UAM: "UAM.webp",
  TBM: "TBM.webp",
  CBC: "CBC.gif",
  GREEN: "GREEN.png",
  CMCM: "CMCM.jpg",
  SOCP: "SOCP.png",
  ELMA: "ELMA.webp",
  "ARM.BVB": "ARM_BVB.jpg",
  BCM: "BCM.svg",
  ECT: "ECT.webp",
  ELJ: "ELJ.png",
  ARTE: "ARTE.webp",
  MECF: "MECF.png",
  ELGS: "ELGS.png",
  MFC: "MFC.png",
  PPL: "PPL.svg",
  PREH: "PREH.png",
  CAOR: "CAOR.svg",
  NAPO: "NAPO.jpg",
  UZT: "UZT.png",
  MCAB: "MCAB.png",
  VESY: "VESY.png",
};

// Logos that are white/near-white marks on a transparent background —
// the only variant these companies publish. Invisible on a light card;
// <CompanyLogo /> gives them a dark backdrop instead. (ONE is white on
// a baked-in navy square, so it needs no special handling.)
const WHITE_ON_TRANSPARENT = new Set(["INFINITY", "SOCP", "VESY"]);

/** True when the ticker's bundled logo needs a dark background to be
 *  visible (white-on-transparent brand mark). */
export function tickerLogoNeedsDarkBg(ticker: string): boolean {
  return WHITE_ON_TRANSPARENT.has(ticker.toUpperCase());
}

/** Look up a logo-image URL for a given ticker.
 *
 *  BVB tickers resolve to the bundled high-res asset (same-origin,
 *  /logos/bvb/<file>) — no third-party service, no flakiness, resolution
 *  good enough for large tiles. US tickers still go through Google's
 *  favicon service (acceptable for their 28px chips). Returns `null`
 *  when the ticker is in neither map — callers render the letter-avatar
 *  fallback. We deliberately don't try a speculative "<ticker>.com"
 *  guess — an unrelated domain that happens to have SOME favicon is
 *  worse than our own letter avatar. */
export function tickerLogoUrl(ticker: string): string | null {
  const t = ticker.toUpperCase();
  const local = BVB_LOCAL_LOGOS[t];
  if (local) return `/logos/bvb/${local}`;
  const domain = TICKER_DOMAINS[t];
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}
