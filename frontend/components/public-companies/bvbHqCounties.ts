// bvbHqCounties — BVB ticker → headquarters county (județ).
//
// Feeds the Geographic Map tab: each listed company is placed on the
// Romania choropleth by the county of its registered head office. Names
// are matched against the geometry's NAME_1 after diacritic-stripping
// normalization, so "București" here matches "Bucuresti" in the geojson.
//
// Coverage policy: only counties we are CONFIDENT about are mapped — an
// unmapped ticker simply doesn't appear on the map (the panel footer says
// so) rather than being pinned to a guessed county. Foreign-incorporated
// listings with no Romanian head office (EBS — Vienna, WINE — Chișinău/
// Cyprus, PE — Cyprus) are deliberately absent.

export const BVB_HQ_COUNTY: Record<string, string> = {
  // ── București ──
  SNP: "București", SNN: "București", BRD: "București", DIGI: "București",
  FP: "București", "EL.BVB": "București", TEL: "București", M: "București",
  SFG: "București", ONE: "București", TTS: "București", H2O: "București",
  BVB: "București", IMP: "București", PBK: "București", ROC1: "București",
  SMTL: "București", SAFE: "București", BIO: "București", ELMA: "București",
  TBM: "București", ELJ: "București", BUCV: "București", ALU: "București",
  BNET: "București", RRC: "Constanța",
  // ── Cluj ──
  TLV: "Cluj", CBC: "Cluj", NAPO: "Cluj", AROBS: "Cluj",
  // ── Sibiu (Mediaș hosts both gas companies) ──
  SNG: "Sibiu", TGN: "Sibiu", CMP: "Sibiu",
  // ── Mureș ──
  AAG: "Mureș", MCAB: "Mureș", VESY: "Mureș",
  // ── Iași ──
  ATB: "Iași",
  // ── Bacău ──
  ARS: "Bacău", EVER: "Bacău", CRC: "Bacău",
  // ── Brașov ──
  IARV: "Brașov", TBK: "Brașov", RPH: "Brașov", TRANSI: "Brașov", COMI: "Brașov",
  // ── Prahova ──
  AQ: "Prahova", COTE: "Prahova", ENP: "Prahova", UZT: "Prahova",
  // ── Constanța ──
  OIL: "Constanța", SOCP: "Constanța", CMCM: "Constanța", EFO: "Constanța",
  // ── Ilfov ──
  CFH: "Ilfov",
  // ── Bistrița-Năsăud ──
  TRP: "Bistrița-Năsăud", CMF: "Bistrița-Năsăud",
  // ── Olt ──
  ALR: "Olt", ALT: "Olt",
  // ── Others ──
  SNO: "Mehedinți",
  MECF: "Neamț",
  EAI: "Botoșani", ECT: "Botoșani", CNTE: "Botoșani",
  VNC: "Vrancea",
  ARTE: "Gorj",
  PREB: "Alba",
  RMAH: "Hunedoara",
  BRM: "Suceava", BCM: "Suceava",
  UAM: "Bihor", "STZ.BVB": "Bihor", CAOR: "Bihor",
  LION: "Arad",
  INFINITY: "Dolj",
  PREH: "Călărași",
  ROCE: "Buzău", GREEN: "Buzău", PPL: "Buzău",
};

/** Diacritic-stripping normalizer shared by the map + this table. */
export function normCounty(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "");
}
