// CFO AI bucket — display utilities. Mirrors src/engine/buckets.py.

import type { Bucket } from "./cfoApi";

export const BUCKET_LABEL: Record<Bucket, string> = {
  PROTECT: "Protect",
  WATCH: "Watch",
  FIX: "Fix",
  REDUCE: "Reduce",
  LIQUIDATE: "Liquidate",
  SCALE: "Scale",
};

export const BUCKET_DESCRIPTION: Record<Bucket, string> = {
  PROTECT: "Strategic anchors — do not auto-touch.",
  WATCH: "Important but weakening — monitor closely.",
  FIX: "Renegotiate, reprice, or change channel.",
  REDUCE: "Throttle reorder and minimum stock.",
  LIQUIDATE: "Dead stock or bleeding margin — exit.",
  SCALE: "Strong returns — allocate more capital.",
};

export const BUCKET_CHIP_CLASS: Record<Bucket, string> = {
  PROTECT: "chip chip-protect",
  WATCH: "chip chip-watch",
  FIX: "chip chip-fix",
  REDUCE: "chip chip-reduce",
  LIQUIDATE: "chip chip-liquidate",
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
