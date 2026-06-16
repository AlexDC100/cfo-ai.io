// CFO AI bucket — display utilities. Mirrors src/engine/buckets.py.
//
// Display naming follows the 3-bucket UX model (Protect / Watch / Wind down).
// The engine still emits 6 raw bucket tokens because the underlying rules
// distinguish them; `BUCKET_LABEL` for the LIQUIDATE token is intentionally
// "Wind down" so no user-facing string in any locale reads "Liquidate".

import type { Bucket } from "./cfoApi";

export const BUCKET_LABEL: Record<Bucket, string> = {
  PROTECT: "Protect",
  WATCH: "Watch",
  FIX: "Fix",
  REDUCE: "Reduce",
  LIQUIDATE: "Wind down",
  SCALE: "Scale",
};

export const BUCKET_DESCRIPTION: Record<Bucket, string> = {
  PROTECT: "Strategic anchors — do not auto-touch.",
  WATCH: "Important but weakening — monitor closely.",
  FIX: "Renegotiate, reprice, or change channel.",
  REDUCE: "Throttle reorder and minimum stock.",
  LIQUIDATE: "Dead stock or bleeding margin — wind down.",
  SCALE: "Strong returns — allocate more capital.",
};

export const BUCKET_CHIP_CLASS: Record<Bucket, string> = {
  PROTECT: "chip chip-protect",
  WATCH: "chip chip-watch",
  FIX: "chip chip-fix",
  REDUCE: "chip chip-reduce",
  LIQUIDATE: "chip chip-wind-down",
  SCALE: "chip chip-scale",
};

export const BUCKET_PRIORITY: Record<Bucket, number> = {
  LIQUIDATE: 0,
  FIX: 1,
  REDUCE: 2,
  WATCH: 3,
  SCALE: 4,
  PROTECT: 5,
};

export const ALL_BUCKETS: Bucket[] = [
  "PROTECT",
  "WATCH",
  "FIX",
  "REDUCE",
  "LIQUIDATE",
  "SCALE",
];
