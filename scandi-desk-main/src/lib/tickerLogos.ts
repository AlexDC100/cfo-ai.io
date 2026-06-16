// Ticker → primary-domain map for company logo lookup.
//
// Used by <CompanyLogo /> to build a Clearbit logo URL
// (`https://logo.clearbit.com/<domain>`). Clearbit serves 128x128 PNG
// transparent logos for any domain it knows about — coverage is
// excellent for US-listed companies. When a ticker isn't in this map
// (or the network request 404s), <CompanyLogo /> falls back to a
// deterministic letter avatar so the layout never breaks.
//
// Maintenance: add entries as the universe grows. The map is keyed on
// the SEC ticker (uppercase). Tickers with periods (e.g. "BRK.B") use
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
};

/** Look up a Clearbit logo URL for a given ticker. Returns `null` when
 *  the ticker isn't in the static map — callers should render the
 *  letter-avatar fallback in that case. We deliberately don't try a
 *  speculative "<ticker>.com" guess because Clearbit returns a generic
 *  placeholder for unknown domains, which is worse than our own letter
 *  avatar. */
export function tickerLogoUrl(ticker: string): string | null {
  const domain = TICKER_DOMAINS[ticker.toUpperCase()];
  if (!domain) return null;
  return `https://logo.clearbit.com/${domain}`;
}
